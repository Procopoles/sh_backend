import type { PoolClient } from "pg";
import { dataApiRequest, dataApiRpc, isDataApiConfigured } from "./data-api";
import { ensureControlSchema, getPool, query, withTransaction } from "./db";
import {
  buildAdLimitSql,
  buildRuleSelectSql,
  buildViewSql,
  buildWhereSql,
  buildRuleRowsPreviewQuery,
  DEFAULT_FILTERS,
  DEFAULT_PUBLICATION_PRIORITY,
  getBaseColumns,
  quoteIdentifier,
  quoteLiteral,
  resolveRuleColumnTarget,
  sanitizeFilters,
  sanitizePublicationPriority,
  slugify
} from "./rules";
import type {
  ColumnMetadata,
  Portal,
  PortalAdType,
  PublicationPriority,
  PublicationRule,
  RuleHealthcheckReport,
  RuleHealthcheckReportRule,
  RuleHealthcheckStatus,
  RuleFilters,
  RuleSummaryCalculation,
  RuleSummaryConfigItem,
  RuleSummaryItemResult,
  RuleSummaryResponse,
  SourceViewMetadata
} from "./types";

type PortalInput = {
  name: string;
  slug?: string | null;
  description?: string | null;
  logo_url?: string | null;
  active?: boolean;
  ad_types?: PortalAdTypeInput[];
};

type PortalAdTypeInput = {
  id?: number;
  name: string;
  quantity: number;
};

type RuleInput = {
  portal_id?: number | null;
  name: string;
  description?: string | null;
  source_table?: string | null;
  active?: boolean;
  include_locked?: boolean;
  use_ad_limit?: boolean;
  ad_limit_type?: string | null;
  filters?: RuleFilters;
  publication_priority?: PublicationPriority;
  summary_config?: RuleSummaryConfigItem[] | null;
};

type PreviewRowsInput = RuleInput & {
  limit?: number;
  preview_sort_column?: string | null;
  preview_sort_direction?: "asc" | "desc" | null;
};

type RuleSummaryInput = RuleInput & {
  items?: RuleSummaryConfigItem[];
};

const DEFAULT_SUMMARY_GROUP_COUNT = 5;
const DEFAULT_SUMMARY_VALUE_COUNT_LIMIT = 5;
const MAX_SUMMARY_ITEMS = 12;
const DATA_API_COLUMNS_CACHE_MS = 5 * 60 * 1000;
const HEALTHCHECK_REPORT_CACHE_MS = Math.max(
  10_000,
  Number(process.env.HEALTHCHECK_REPORT_CACHE_MS ?? "120000") || 120_000
);

let dataApiColumnsCache: { expiresAt: number; columns: ColumnMetadata[] } | null = null;
let dataApiHealthcheckReportCache: { key: string; expiresAt: number; value: RuleHealthcheckReport } | null = null;

const healthcheckReportRuleCache = new Map<
  string,
  {
    expiresAt: number;
    value: RuleHealthcheckReportRule;
  }
>();

export async function listPortals() {
  if (isDataApiConfigured()) return listPortalsViaApi();

  await ensureControlSchema();
  const result = await query<Portal>(`
    select p.*,
      (select count(*)::int from publish_rules r where r.portal_id = p.id) as rules_count,
      (select coalesce(sum(a.quantity), 0)::int from publish_portal_ad_types a where a.portal_id = p.id) as total_quota,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', a.id,
            'portal_id', a.portal_id,
            'name', a.name,
            'quantity', a.quantity,
            'created_at', a.created_at,
            'updated_at', a.updated_at
          )
        ) filter (where a.id is not null),
        '[]'::jsonb
      ) as ad_types
    from publish_portals p
    left join publish_portal_ad_types a on a.portal_id = p.id
    group by p.id
    order by p.name
  `);
  return result.rows;
}

export async function createPortal(input: PortalInput) {
  if (isDataApiConfigured()) return createPortalViaApi(input);

  await ensureControlSchema();
  const portal = await withTransaction(async (client) => {
    const slug = normalizePortalSlug(input.slug, input.name);
    const result = await client.query<Portal>(
      `
        insert into publish_portals (name, slug, description, logo_url, active)
        values ($1, $2, $3, $4, $5)
        returning *
      `,
      [input.name.trim(), slug, input.description ?? null, input.logo_url ?? null, input.active ?? true]
    );
    await replacePortalAdTypes(client, result.rows[0].id, input.ad_types ?? []);
    return getPortalById(client, result.rows[0].id);
  });
  invalidateHealthcheckReportCache();
  return portal;
}

export async function updatePortal(id: number, input: PortalInput) {
  if (isDataApiConfigured()) return updatePortalViaApi(id, input);

  await ensureControlSchema();
  const portal = await withTransaction(async (client) => {
    const slug = normalizePortalSlug(input.slug, input.name);
    const currentAdTypes = await listPortalAdTypes(client, id);
    const adTypesChanged = portalAdTypesSignature(currentAdTypes) !== portalAdTypesSignature(input.ad_types ?? []);
    const result = await client.query<Portal>(
      `
        update publish_portals
        set name = $2, slug = $3, description = $4, logo_url = $5, active = $6, updated_at = now()
        where id = $1
        returning *
      `,
      [id, input.name.trim(), slug, input.description ?? null, input.logo_url ?? null, input.active ?? true]
    );
    if (!result.rows[0]) return null;
    await replacePortalAdTypes(client, id, input.ad_types ?? []);
    if (adTypesChanged) {
      await refreshRuleViewsForPortal(client, id);
    }
    return getPortalById(client, id);
  });
  invalidateHealthcheckReportCache();
  return portal;
}

export async function deletePortal(id: number) {
  if (isDataApiConfigured()) return deletePortalViaApi(id);

  await ensureControlSchema();
  await withTransaction(async (client) => {
    await client.query("update publish_rules set portal_id = null, updated_at = now() where portal_id = $1", [id]);
    await client.query("delete from publish_portals where id = $1", [id]);
  });
  invalidateHealthcheckReportCache();
}

export async function listRules(portalId?: number) {
  if (isDataApiConfigured()) return listRulesViaApi(portalId);

  await ensureControlSchema();
  const params = portalId ? [portalId] : [];
  const result = await query<PublicationRule>(
    `
      select r.*, p.name as portal_name, p.slug as portal_slug, p.logo_url as portal_logo_url
      from publish_rules r
      left join publish_portals p on p.id = r.portal_id
      ${portalId ? "where r.portal_id = $1" : ""}
      order by r.updated_at desc, r.id desc
    `,
    params
  );
  return result.rows;
}

export async function createRule(input: RuleInput) {
  if (isDataApiConfigured()) return createRuleViaApi(input);

  await ensureControlSchema();
  const rule = await withTransaction(async (client) => {
    const columns = await getBaseColumns(client);
    const portalId = normalizePortalId(input.portal_id);
    const portal = portalId
      ? await client.query<{ slug: string }>("select slug from publish_portals where id = $1", [portalId])
      : ({ rows: [{ slug: "" }] } as { rows: Array<{ slug: string }> });
    if (!portal.rows[0]) throw new Error("Portal nao encontrado.");

    const slug = slugify(input.name);
    const filters = sanitizeFilters(input.filters ?? DEFAULT_FILTERS, columns);
    const publicationPriority = sanitizePublicationPriority(input.publication_priority ?? DEFAULT_PUBLICATION_PRIORITY, columns);
    const summaryConfig = sanitizeRuleSummaryConfig(input.summary_config, columns);
    const sourceTable = await validateSourceTable(client, input.source_table);
    const adLimit = await normalizeRuleAdLimit(client, portalId, input.use_ad_limit ?? false, input.ad_limit_type);
    const inserted = await client.query<PublicationRule>(
      `
        insert into publish_rules
          (portal_id, name, slug, description, source_table, active, include_locked, use_ad_limit, ad_limit_type, filters, publication_priority, summary_config)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb)
        returning *
      `,
      [
        portalId,
        input.name.trim(),
        slug,
        input.description ?? null,
        sourceTable,
        input.active ?? true,
        input.include_locked ?? true,
        adLimit.useAdLimit,
        adLimit.adLimitType,
        JSON.stringify(filters),
        JSON.stringify(publicationPriority),
        summaryConfig == null ? null : JSON.stringify(summaryConfig)
      ]
    );

    const rule = inserted.rows[0];
    const viewPrefix = portal.rows[0].slug ? `${portal.rows[0].slug}_` : "";
    const viewName = `pc_${viewPrefix}${slug}_${rule.id}`.slice(0, 62);
    return refreshRuleView(client, rule.id, viewName, {
      ...rule,
      filters,
      source_table: sourceTable,
      active: input.active ?? true,
      include_locked: input.include_locked ?? true,
      use_ad_limit: adLimit.useAdLimit,
      ad_limit_type: adLimit.adLimitType,
      publication_priority: publicationPriority,
      summary_config: summaryConfig
    });
  });
  invalidateHealthcheckReportCache();
  return rule;
}

export async function updateRule(id: number, input: RuleInput) {
  if (isDataApiConfigured()) return updateRuleViaApi(id, input);

  await ensureControlSchema();
  const rule = await withTransaction(async (client) => {
    const columns = await getBaseColumns(client);
    const existing = await client.query<PublicationRule>("select * from publish_rules where id = $1", [id]);
    if (!existing.rows[0]) return null;

    const portalId = input.portal_id === undefined ? existing.rows[0].portal_id : normalizePortalId(input.portal_id);
    if (portalId) {
      const portal = await client.query<{ id: number }>("select id from publish_portals where id = $1", [portalId]);
      if (!portal.rows[0]) throw new Error("Portal nao encontrado.");
    }
    const filters = sanitizeFilters(input.filters ?? existing.rows[0].filters, columns);
    const publicationPriority = sanitizePublicationPriority(
      input.publication_priority ?? existing.rows[0].publication_priority ?? DEFAULT_PUBLICATION_PRIORITY,
      columns
    );
    const summaryConfig =
      input.summary_config === undefined
        ? existing.rows[0].summary_config ?? null
        : sanitizeRuleSummaryConfig(input.summary_config, columns);
    const sourceTable = await validateSourceTable(client, input.source_table ?? existing.rows[0].source_table, id);
    const adLimit = await normalizeRuleAdLimit(
      client,
      portalId,
      input.use_ad_limit ?? existing.rows[0].use_ad_limit ?? false,
      input.ad_limit_type === undefined ? existing.rows[0].ad_limit_type : input.ad_limit_type
    );
    const slug = slugify(input.name);
    const updated = await client.query<PublicationRule>(
      `
        update publish_rules
        set portal_id = $2,
            name = $3,
            slug = $4,
            description = $5,
            source_table = $6,
            active = $7,
            include_locked = $8,
            use_ad_limit = $9,
            ad_limit_type = $10,
            filters = $11::jsonb,
            publication_priority = $12::jsonb,
            summary_config = $13::jsonb,
            updated_at = now()
        where id = $1
        returning *
      `,
      [
        id,
        portalId,
        input.name.trim(),
        slug,
        input.description ?? null,
        sourceTable,
        input.active ?? true,
        input.include_locked ?? true,
        adLimit.useAdLimit,
        adLimit.adLimitType,
        JSON.stringify(filters),
        JSON.stringify(publicationPriority),
        summaryConfig == null ? null : JSON.stringify(summaryConfig)
      ]
    );

    const refreshed = await refreshRuleView(client, id, updated.rows[0].view_name, {
      ...updated.rows[0],
      filters,
      source_table: sourceTable,
      active: input.active ?? true,
      include_locked: input.include_locked ?? true,
      use_ad_limit: adLimit.useAdLimit,
      ad_limit_type: adLimit.adLimitType,
      publication_priority: publicationPriority,
      summary_config: summaryConfig
    });
    await refreshDependentRuleViews(client, refreshed.view_name, new Set([id]));
    return refreshed;
  });
  invalidateHealthcheckReportCache();
  return rule;
}

export async function updateRuleSummaryConfig(id: number, summaryConfigInput: unknown) {
  if (isDataApiConfigured()) return updateRuleSummaryConfigViaApi(id, summaryConfigInput);

  await ensureControlSchema();
  const rule = await withTransaction(async (client) => {
    const columns = await getBaseColumns(client);
    const summaryConfig = sanitizeRuleSummaryConfig(summaryConfigInput, columns);
    const result = await client.query<PublicationRule>(
      `
        update publish_rules
        set summary_config = $2::jsonb,
            updated_at = now()
        where id = $1
        returning *
      `,
      [id, summaryConfig == null ? null : JSON.stringify(summaryConfig)]
    );
    return result.rows[0] ?? null;
  });
  invalidateHealthcheckReportCache();
  return rule;
}

export async function deleteRule(id: number) {
  if (isDataApiConfigured()) return deleteRuleViaApi(id);

  await ensureControlSchema();
  await withTransaction(async (client) => {
    const existing = await client.query<{ view_name: string | null }>(
      "select view_name from publish_rules where id = $1",
      [id]
    );
    if (existing.rows[0]?.view_name) {
      await client.query(`drop view if exists public."${existing.rows[0].view_name.replace(/"/g, '""')}"`);
    }
    await client.query("delete from publish_rules where id = $1", [id]);
  });
  invalidateHealthcheckReportCache();
}

export async function runRuleHealthchecks(ruleId?: number | null): Promise<RuleHealthcheckStatus[]> {
  if (isDataApiConfigured()) {
    const statuses = await runRuleHealthchecksViaApi(ruleId);
    invalidateHealthcheckReportCache(ruleId);
    return statuses;
  }

  await ensureControlSchema();
  const result = await query<
    Pick<
      PublicationRule,
      "id" | "portal_id" | "view_name" | "use_ad_limit" | "ad_limit_type"
    > & { portal_slug: string | null }
  >(
    `
      select r.id, r.portal_id, r.view_name, r.use_ad_limit, r.ad_limit_type, p.slug as portal_slug
      from publish_rules r
      left join publish_portals p on p.id = r.portal_id
      ${ruleId ? "where r.id = $1" : ""}
      order by r.updated_at desc, r.id desc
    `,
    ruleId ? [ruleId] : []
  );

  const statuses: RuleHealthcheckStatus[] = [];
  for (const rule of result.rows) {
    statuses.push(await runSingleRuleHealthcheck(rule));
  }
  invalidateHealthcheckReportCache(ruleId);
  return statuses;
}

export async function getRuleHealthcheckReport(options: { ruleId?: number | null; refresh?: boolean } = {}): Promise<RuleHealthcheckReport> {
  const ruleId = normalizeOptionalPositiveInteger(options.ruleId);
  if (isDataApiConfigured()) return getRuleHealthcheckReportViaApi(ruleId, Boolean(options.refresh));

  await ensureControlSchema();
  const result = await query<HealthcheckReportRuleRow>(
    `
      select r.id,
             r.name,
             r.slug,
             r.view_name,
             r.active,
             r.use_ad_limit,
             r.ad_limit_type,
             r.health_expected_count,
             r.health_published_count,
             r.health_pending_count,
             r.health_unexpected_count,
             r.health_checked_at,
             r.health_error,
             r.updated_at,
             p.id as portal_id,
             p.name as portal_name,
             p.slug as portal_slug
      from publish_rules r
      join publish_portals p on p.id = r.portal_id
      where r.active = true
        ${ruleId ? "and r.id = $1" : ""}
      order by p.name asc, r.name asc, r.id asc
    `,
    ruleId ? [ruleId] : []
  );

  let ruleHits = 0;
  let ruleMisses = 0;
  const rules = await mapWithConcurrency(result.rows, 4, async (rule) => {
    const cacheKey = healthcheckReportRuleCacheKey(rule);
    const cached = options.refresh ? null : healthcheckReportRuleCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      ruleHits += 1;
      return cached.value;
    }

    ruleMisses += 1;
    const value = await buildHealthcheckReportRule(rule);
    healthcheckReportRuleCache.set(cacheKey, {
      expiresAt: Date.now() + HEALTHCHECK_REPORT_CACHE_MS,
      value
    });
    trimHealthcheckReportRuleCache();
    return value;
  });

  return {
    generated_at: new Date().toISOString(),
    cached: ruleMisses === 0,
    cache: {
      ttl_ms: HEALTHCHECK_REPORT_CACHE_MS,
      rule_hits: ruleHits,
      rule_misses: ruleMisses
    },
    rules
  };
}

export async function previewRule(input: RuleInput) {
  if (isDataApiConfigured()) return previewRuleViaApi(input);

  await ensureControlSchema();
  return withTransaction(async (client) => {
    const columns = await getBaseColumns(client);
    const filters = sanitizeFilters(input.filters ?? DEFAULT_FILTERS, columns);
    const sourceTable = await validateSourceTable(client, input.source_table);
    const where = buildWhereSql(filters, columns, input.include_locked ?? true, true);
    const result = await client.query<{ count: number }>(
      `select count(*)::int as count from public.${quoteIdentifier(sourceTable)} b where ${input.active === false ? "false" : where.whereSql}`,
      where.params
    );
    const count = result.rows[0]?.count ?? 0;
    const portalId = normalizePortalId(input.portal_id);
    const limitedCount = input.use_ad_limit
      ? Math.min(count, await getAdLimitQuota(client, portalId, input.ad_limit_type))
      : null;
    return { count, limited_count: limitedCount };
  });
}

export async function previewRuleRows(input: PreviewRowsInput) {
  if (isDataApiConfigured()) return previewRuleRowsViaApi(input);

  await ensureControlSchema();
  return withTransaction(async (client) => {
    const columns = await getBaseColumns(client);
    const filters = sanitizeFilters(input.filters ?? DEFAULT_FILTERS, columns);
    const publicationPriority = sanitizePublicationPriority(input.publication_priority ?? DEFAULT_PUBLICATION_PRIORITY, columns);
    const sourceTable = await validateSourceTable(client, input.source_table);
    const portalId = normalizePortalId(input.portal_id);
    const adLimitQuota = input.use_ad_limit ? await getAdLimitQuota(client, portalId, input.ad_limit_type) : null;
    const preview = buildRuleRowsPreviewQuery(
      sourceTable,
      filters,
      columns,
      input.include_locked ?? true,
      input.active ?? true,
      input.limit ?? 10,
      publicationPriority,
      adLimitQuota,
      input.preview_sort_column ?? null,
      input.preview_sort_direction === "desc" ? "desc" : "asc"
    );
    const result = await client.query<Record<string, unknown>>(preview.sql, preview.params);
    return { columns: preview.columns, rows: result.rows };
  });
}

export async function previewRuleSummary(input: RuleSummaryInput): Promise<RuleSummaryResponse> {
  if (isDataApiConfigured()) return previewRuleSummaryViaApi(input);

  await ensureControlSchema();
  return withTransaction(async (client) => {
    const columns = await getBaseColumns(client);
    const filters = sanitizeFilters(input.filters ?? DEFAULT_FILTERS, columns);
    const publicationPriority = sanitizePublicationPriority(input.publication_priority ?? DEFAULT_PUBLICATION_PRIORITY, columns);
    const sourceTable = await validateSourceTable(client, input.source_table);
    const portalId = normalizePortalId(input.portal_id);
    const limitSql = input.use_ad_limit ? buildAdLimitSql(portalId, input.ad_limit_type) : null;
    const selectionSql = buildRuleSelectSqlForSummary(
      sourceTable,
      filters,
      columns,
      input.include_locked ?? true,
      input.active ?? true,
      publicationPriority,
      limitSql
    );
    const items = normalizeSummaryItems(input.items, columns);
    if (!items.length) {
      const totalResult = await client.query<{ total: number }>(
        `select count(*)::int as total from (${selectionSql}) summary_selection`
      );
      return { total: totalResult.rows[0]?.total ?? 0, items: [] };
    }

    const summarySelectionSql = await materializeRuleSummarySelection(client, selectionSql);
    const totalResult = await client.query<{ total: number }>(
      `select count(*)::int as total from (${summarySelectionSql}) summary_selection`
    );
    const total = totalResult.rows[0]?.total ?? 0;
    const resultItems: RuleSummaryItemResult[] = [];

    for (const item of items) {
      resultItems.push(await summarizeRuleItem(client, summarySelectionSql, item, total));
    }

    return { total, items: resultItems };
  });
}

function buildRuleSelectSqlForSummary(
  sourceTable: string,
  filters: RuleFilters,
  columns: ColumnMetadata[],
  includeLocked: boolean,
  active: boolean,
  publicationPriority: PublicationPriority,
  limitSql?: string | null
) {
  return buildRuleSelectSql(
    sourceTable,
    filters,
    columns,
    includeLocked,
    active,
    undefined,
    limitSql ? publicationPriority : DEFAULT_PUBLICATION_PRIORITY,
    limitSql
  );
}

async function materializeRuleSummarySelection(client: PoolClient, selectionSql: string) {
  await client.query("drop table if exists pg_temp.rule_summary_selection");
  await client.query(`create temporary table rule_summary_selection on commit drop as ${selectionSql}`);
  return "select * from rule_summary_selection";
}

type NormalizedRuleSummaryItem = {
  column: string;
  jsonPath: string[] | null;
  jsonValueKind: ColumnMetadata["filter_kind"] | null;
  calculation: RuleSummaryCalculation;
  groupCount: number;
  label: string;
  dataType: string;
  filterKind: ColumnMetadata["filter_kind"];
  target: NonNullable<ReturnType<typeof resolveRuleColumnTarget>>;
};

function normalizeSummaryItems(items: unknown, columns: ColumnMetadata[]): NormalizedRuleSummaryItem[] {
  if (!Array.isArray(items)) return [];

  const normalized: NormalizedRuleSummaryItem[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (!isSummaryRecord(item) || typeof item.column !== "string") continue;

    const target = resolveRuleColumnTarget(columns, item.column, item.jsonPath, item.jsonValueKind, "s");
    if (!target) continue;

    const jsonPath = Array.isArray(target.metadata.json_path) && target.metadata.json_path.length ? target.metadata.json_path : null;
    const calculation = normalizeSummaryCalculation(item.calculation, target.metadata.filter_kind);
    const key = JSON.stringify([target.metadata.column_name, jsonPath, calculation]);
    if (seen.has(key)) continue;
    seen.add(key);

    normalized.push({
      column: target.metadata.column_name,
      jsonPath,
      jsonValueKind: jsonPath ? target.metadata.filter_kind : null,
      calculation,
      groupCount: normalizeSummaryGroupCount(item.groupCount),
      label: summaryColumnLabel(target.metadata),
      dataType: target.metadata.data_type || target.metadata.udt_name || target.metadata.filter_kind,
      filterKind: target.metadata.filter_kind,
      target
    });

    if (normalized.length >= MAX_SUMMARY_ITEMS) break;
  }

  return normalized;
}

function sanitizeRuleSummaryConfig(items: unknown, columns: ColumnMetadata[]): RuleSummaryConfigItem[] | null {
  if (items == null) return null;

  return normalizeSummaryItems(items, columns).map((item) => ({
    column: item.column,
    jsonPath: item.jsonPath,
    jsonValueKind: item.jsonValueKind,
    calculation: item.calculation,
    groupCount: item.groupCount
  }));
}

function normalizeSummaryCalculation(
  value: unknown,
  filterKind: ColumnMetadata["filter_kind"]
): RuleSummaryCalculation {
  const calculation: RuleSummaryCalculation =
    value === "range" || value === "group" || value === "count" ? value : "count";

  if (calculation === "range" && !["number", "datetime", "text"].includes(filterKind)) return "count";
  return calculation;
}

function normalizeSummaryGroupCount(value: unknown) {
  const count = typeof value === "number" ? value : DEFAULT_SUMMARY_GROUP_COUNT;
  if (!Number.isFinite(count)) return DEFAULT_SUMMARY_GROUP_COUNT;
  return Math.max(2, Math.min(10, Math.trunc(count)));
}

async function summarizeRuleItem(
  client: PoolClient,
  selectionSql: string,
  item: NormalizedRuleSummaryItem,
  total: number
): Promise<RuleSummaryItemResult> {
  if (item.calculation === "range") return summarizeRangeItem(client, selectionSql, item);
  if (item.calculation === "group") return summarizeGroupItem(client, selectionSql, item, total);
  return summarizeCountItem(client, selectionSql, item);
}

async function summarizeRangeItem(
  client: PoolClient,
  selectionSql: string,
  item: NormalizedRuleSummaryItem
): Promise<RuleSummaryItemResult> {
  const result = await client.query<{
    total_count: number;
    filled_count: number;
    min: string | null;
    max: string | null;
  }>(`
    with final_selection as (${selectionSql})
    select
      count(*)::int as total_count,
      count(${item.target.columnSql})::int as filled_count,
      min(${item.target.columnSql})::text as min,
      max(${item.target.columnSql})::text as max
    from final_selection s
  `);
  const row = result.rows[0];

  return {
    column: item.column,
    jsonPath: item.jsonPath,
    label: item.label,
    calculation: "range",
    data_type: item.dataType,
    filter_kind: item.filterKind,
    filled_count: row?.filled_count ?? 0,
    total_count: row?.total_count ?? 0,
    min: row?.min ?? null,
    max: row?.max ?? null
  };
}

async function summarizeCountItem(
  client: PoolClient,
  selectionSql: string,
  item: NormalizedRuleSummaryItem
): Promise<RuleSummaryItemResult> {
  const filledSql = summaryFilledSql(item);
  const labelSql = summaryCountLabelSql(item);
  const result = await client.query<{
    total_count: number;
    filled_count: number;
    empty_count: number;
    distinct_count: number;
    value_counts: Array<{ label: string; count: number }>;
  }>(`
    with final_selection as (${selectionSql}),
    summary_labels as (
      select ${filledSql} as filled_value, ${labelSql} as label
      from final_selection s
    ),
    stats as (
      select
        count(*)::int as total_count,
        count(filled_value)::int as filled_count,
        (count(*) - count(filled_value))::int as empty_count,
        count(distinct label)::int as distinct_count
      from summary_labels
    ),
    top_values as (
      select label, count(*)::int as count
      from summary_labels
      group by label
      order by count desc, label asc
      limit ${DEFAULT_SUMMARY_VALUE_COUNT_LIMIT}
    )
    select
      stats.total_count,
      stats.filled_count,
      stats.empty_count,
      stats.distinct_count,
      coalesce(
        json_agg(
          json_build_object('label', top_values.label, 'count', top_values.count)
          order by top_values.count desc, top_values.label asc
        ) filter (where top_values.label is not null),
        '[]'::json
      ) as value_counts
    from stats
    left join top_values on true
    group by stats.total_count, stats.filled_count, stats.empty_count, stats.distinct_count
  `);
  const row = result.rows[0];

  return {
    column: item.column,
    jsonPath: item.jsonPath,
    label: item.label,
    calculation: "count",
    data_type: item.dataType,
    filter_kind: item.filterKind,
    filled_count: row?.filled_count ?? 0,
    empty_count: row?.empty_count ?? 0,
    distinct_count: row?.distinct_count ?? 0,
    total_count: row?.total_count ?? 0,
    value_count_limit: DEFAULT_SUMMARY_VALUE_COUNT_LIMIT,
    values: row?.value_counts ?? []
  };
}

async function summarizeGroupItem(
  client: PoolClient,
  selectionSql: string,
  item: NormalizedRuleSummaryItem,
  total: number
): Promise<RuleSummaryItemResult> {
  if (item.filterKind === "number") return summarizeNumericGroupItem(client, selectionSql, item, total);
  return summarizeExactGroupItem(client, selectionSql, item, total);
}

async function summarizeNumericGroupItem(
  client: PoolClient,
  selectionSql: string,
  item: NormalizedRuleSummaryItem,
  total: number
): Promise<RuleSummaryItemResult> {
  const result = await client.query<{
    bucket: number;
    min_value: string | null;
    max_value: string | null;
    count: number;
  }>(`
    with final_selection as (${selectionSql}),
    summary_values as (
      select ${item.target.columnSql}::numeric as value
      from final_selection s
      where ${item.target.columnSql} is not null
    ),
    bounds as (
      select
        case
          when min(value) = 0 and min(value) filter (where value <> 0) is not null then min(value) filter (where value <> 0)
          else min(value)
        end as min_value,
        max(value) as max_value,
        min(value) = 0 and min(value) filter (where value <> 0) is not null as ignore_zero_floor
      from summary_values
    ),
    bucket_settings as (
      select
        bounds.*,
        chosen_step.step,
        floor(bounds.min_value / chosen_step.floor_unit) * chosen_step.floor_unit as floor_value
      from bounds
      left join lateral (
        with raw as (
          select (bounds.max_value - bounds.min_value) / ${item.groupCount} as raw_step
        ),
        step_candidates as (
          select
            factor * power(10::double precision, exponent)::numeric as step,
            power(10::double precision, exponent)::numeric as floor_unit,
            raw.raw_step
          from raw
          cross join lateral generate_series(
            floor(log(greatest(raw.raw_step::double precision, 1e-12)))::int - 1,
            floor(log(greatest(raw.raw_step::double precision, 1e-12)))::int + 12
          ) as exponents(exponent)
          cross join (values (1::numeric), (2::numeric), (5::numeric), (10::numeric)) factors(factor)
          where raw.raw_step > 0
        )
        select step, floor_unit
        from step_candidates
        where step >= raw_step
          and ceil((bounds.max_value - floor(bounds.min_value / floor_unit) * floor_unit) / step) <= ${item.groupCount}
        order by step
        limit 1
      ) chosen_step on bounds.min_value is not null and bounds.min_value <> bounds.max_value
    ),
    bucketed_raw as (
      select
        case
          when bucket_settings.min_value is null then null
          when bucket_settings.min_value = bucket_settings.max_value then 1
          else least(
            greatest(floor((summary_values.value - bucket_settings.floor_value) / bucket_settings.step)::int + 1, 1),
            ${item.groupCount}
          )
        end as bucket,
        summary_values.value,
        bucket_settings.min_value,
        bucket_settings.max_value,
        bucket_settings.floor_value,
        bucket_settings.step
      from summary_values
      cross join bucket_settings
      where bucket_settings.min_value is not null
        and (not bucket_settings.ignore_zero_floor or summary_values.value <> 0)
    ),
    bucketed as (
      select
        bucket,
        value,
        case
          when min_value = max_value then value
          else floor_value + ((bucket - 1) * step)
        end as bucket_min,
        case
          when min_value = max_value then value
          else floor_value + (bucket * step)
        end as bucket_max
      from bucketed_raw
    )
    select bucket::int, min(bucket_min)::text as min_value, max(bucket_max)::text as max_value, count(*)::int as count
    from bucketed
    where bucket is not null
    group by bucket
    order by bucket
  `);

  return {
    column: item.column,
    jsonPath: item.jsonPath,
    label: item.label,
    calculation: "group",
    data_type: item.dataType,
    filter_kind: item.filterKind,
    group_count: item.groupCount,
    total_count: total,
    groups: result.rows.map((row) => ({
      label: summaryRangeLabel(row.min_value, row.max_value),
      count: row.count,
      min: row.min_value,
      max: row.max_value
    }))
  };
}

async function summarizeExactGroupItem(
  client: PoolClient,
  selectionSql: string,
  item: NormalizedRuleSummaryItem,
  total: number
): Promise<RuleSummaryItemResult> {
  const labelSql = `coalesce(nullif(btrim(${item.target.textColumnSql}::text), ''), 'Sem valor')`;
  const result = await client.query<{ label: string; count: number }>(`
    with final_selection as (${selectionSql})
    select ${labelSql} as label, count(*)::int as count
    from final_selection s
    group by label
    order by count desc, label asc
    limit ${item.groupCount}
  `);

  return {
    column: item.column,
    jsonPath: item.jsonPath,
    label: item.label,
    calculation: "group",
    data_type: item.dataType,
    filter_kind: item.filterKind,
    group_count: item.groupCount,
    total_count: total,
    groups: result.rows.map((row) => ({ label: row.label, count: row.count }))
  };
}

function summaryFilledSql(item: NormalizedRuleSummaryItem) {
  if (item.filterKind === "text" || item.filterKind === "json") {
    return `nullif(btrim(${item.target.textColumnSql}::text), '')`;
  }
  return item.target.nullCheckSql;
}

function summaryCountLabelSql(item: NormalizedRuleSummaryItem) {
  if (item.filterKind === "text" || item.filterKind === "json") {
    return `coalesce(nullif(btrim(${item.target.textColumnSql}::text), ''), 'Sem valor')`;
  }
  if (item.filterKind === "boolean") {
    return `case when ${item.target.columnSql} is true then 'Verdadeiro' when ${item.target.columnSql} is false then 'Falso' else 'Sem valor' end`;
  }
  return `coalesce(${item.target.columnSql}::text, 'Sem valor')`;
}

function summaryColumnLabel(column: ColumnMetadata) {
  if (column.display_name) return column.display_name;
  const path = Array.isArray(column.json_path) ? column.json_path.filter(Boolean) : [];
  return path.length ? `${column.column_name}.${path.join(".")}` : column.column_name;
}

function summaryRangeLabel(min: string | null, max: string | null) {
  if (!min && !max) return "Sem valor";
  if (min === max) return min ?? max ?? "Sem valor";
  return `${min ?? "-"} ate ${max ?? "-"}`;
}

function isSummaryRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function getMetadata() {
  if (isDataApiConfigured()) {
    const [columns, counts, sourceViews] = await Promise.all([
      listBaseColumnsViaApi(),
      dataApiRpc<Array<{ base_imoveis: number; publish_locks: number }>>("publish_control_counts"),
      listSourceViewsViaApi()
    ]);

    return { columns, counts: counts[0], source_views: sourceViews };
  }

  const client = await query<{ base_imoveis: number; publish_locks: number }>(`
    select
      (select count(*)::int from base_imoveis) as base_imoveis,
      (select count(*)::int from publish_locks) as publish_locks
  `);
  const poolClient = await getPool().connect();
  try {
    const columns = await getBaseColumns(poolClient);
    const sourceViews = await listSourceViews(poolClient);
    return { columns, counts: client.rows[0], source_views: sourceViews };
  } finally {
    poolClient.release();
  }
}

export async function checkHealth() {
  if (isDataApiConfigured()) {
    await dataApiRequest<Record<string, unknown>>("/");
    return { ok: true, mode: "data-api" };
  }

  const result = await query("select now() as now");
  return { ok: true, mode: "direct-db", now: result.rows[0].now };
}

async function listPortalsViaApi() {
  const [portals, rules, adTypes] = await Promise.all([
    dataApiRequest<Portal[]>("/publish_portals?order=name.asc"),
    dataApiRequest<Array<{ id: number; portal_id: number | null }>>("/publish_rules?select=id,portal_id"),
    dataApiRequest<PortalAdType[]>("/publish_portal_ad_types?order=name.asc")
  ]);
  const counts = new Map<number, number>();
  for (const rule of rules) {
    if (rule.portal_id == null) continue;
    counts.set(rule.portal_id, (counts.get(rule.portal_id) ?? 0) + 1);
  }
  const adTypesByPortal = groupAdTypesByPortal(adTypes);
  return portals.map((portal) => {
    const portalAdTypes = adTypesByPortal.get(portal.id) ?? [];
    return {
      ...portal,
      rules_count: counts.get(portal.id) ?? 0,
      ad_types: portalAdTypes,
      total_quota: sumPortalQuota(portalAdTypes)
    };
  });
}

async function createPortalViaApi(input: PortalInput) {
  const slug = normalizePortalSlug(input.slug, input.name);
  const rows = await dataApiRequest<Portal[]>("/publish_portals", {
    method: "POST",
    prefer: "return=representation",
    body: {
      name: input.name.trim(),
      slug,
      description: input.description ?? null,
      logo_url: input.logo_url ?? null,
      active: input.active ?? true
    }
  });
  await replacePortalAdTypesViaApi(rows[0].id, input.ad_types ?? []);
  const portal = await getPortalByIdViaApi(rows[0].id);
  invalidateHealthcheckReportCache();
  return portal;
}

async function updatePortalViaApi(id: number, input: PortalInput) {
  const slug = normalizePortalSlug(input.slug, input.name);
  const currentAdTypes = await dataApiRequest<PortalAdType[]>(`/publish_portal_ad_types?portal_id=eq.${id}&order=name.asc`);
  const adTypesChanged = portalAdTypesSignature(currentAdTypes) !== portalAdTypesSignature(input.ad_types ?? []);
  const rows = await dataApiRequest<Portal[]>(`/publish_portals?id=eq.${id}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: {
      name: input.name.trim(),
      slug,
      description: input.description ?? null,
      logo_url: input.logo_url ?? null,
      active: input.active ?? true,
      updated_at: new Date().toISOString()
    }
  });
  if (!rows[0]) return null;
  await replacePortalAdTypesViaApi(id, input.ad_types ?? []);
  if (adTypesChanged) {
    await refreshRuleViewsForPortalViaApi(id);
  }
  const portal = await getPortalByIdViaApi(id);
  invalidateHealthcheckReportCache();
  return portal;
}

async function deletePortalViaApi(id: number) {
  await dataApiRequest(`/publish_rules?portal_id=eq.${id}`, { method: "PATCH", body: { portal_id: null } });
  await dataApiRequest(`/publish_portals?id=eq.${id}`, { method: "DELETE" });
  invalidateHealthcheckReportCache();
}

async function listRulesViaApi(portalId?: number) {
  const rulePath = portalId
    ? `/publish_rules?portal_id=eq.${portalId}&order=updated_at.desc,id.desc`
    : "/publish_rules?order=updated_at.desc,id.desc";
  const [rules, portals] = await Promise.all([
    dataApiRequest<PublicationRule[]>(rulePath),
    dataApiRequest<Array<Pick<Portal, "id" | "name" | "slug" | "logo_url">>>("/publish_portals?select=id,name,slug,logo_url")
  ]);
  const portalNames = new Map(portals.map((portal) => [portal.id, portal.name]));
  const portalSlugs = new Map(portals.map((portal) => [portal.id, portal.slug]));
  const portalLogos = new Map(portals.map((portal) => [portal.id, portal.logo_url]));
  return rules.map((rule) => ({
    ...rule,
    portal_name: rule.portal_id == null ? undefined : portalNames.get(rule.portal_id),
    portal_slug: rule.portal_id == null ? undefined : portalSlugs.get(rule.portal_id),
    portal_logo_url: rule.portal_id == null ? undefined : portalLogos.get(rule.portal_id)
  }));
}

async function createRuleViaApi(input: RuleInput) {
  const columns = await listBaseColumnsViaApi();
  const filters = sanitizeFilters(input.filters ?? DEFAULT_FILTERS, columns);
  const publicationPriority = sanitizePublicationPriority(input.publication_priority ?? DEFAULT_PUBLICATION_PRIORITY, columns);
  const summaryConfig = sanitizeRuleSummaryConfig(input.summary_config, columns);
  const sourceTable = await validateSourceTableViaApi(input.source_table);
  const portalId = normalizePortalId(input.portal_id);
  if (portalId) await assertPortalExistsViaApi(portalId);
  const adLimit = await normalizeRuleAdLimitViaApi(portalId, input.use_ad_limit ?? false, input.ad_limit_type);
  const inserted = await dataApiRequest<PublicationRule[]>("/publish_rules", {
    method: "POST",
    prefer: "return=representation",
    body: {
      portal_id: portalId,
      name: input.name.trim(),
      slug: slugify(input.name),
      description: input.description ?? null,
      source_table: sourceTable,
      active: input.active ?? true,
      include_locked: input.include_locked ?? true,
      use_ad_limit: adLimit.useAdLimit,
      ad_limit_type: adLimit.adLimitType,
      filters,
      publication_priority: publicationPriority,
      summary_config: summaryConfig
    }
  });

  const refreshed = await dataApiRpc<PublicationRule[]>("refresh_publish_rule_view", {
    rule_id: inserted[0].id
  });
  invalidateHealthcheckReportCache();
  return refreshed[0];
}

async function updateRuleViaApi(id: number, input: RuleInput) {
  const existing = await dataApiRequest<PublicationRule[]>(`/publish_rules?id=eq.${id}&limit=1`);
  if (!existing[0]) return null;

  const columns = await listBaseColumnsViaApi();
  const filters = sanitizeFilters(input.filters ?? existing[0].filters, columns);
  const publicationPriority = sanitizePublicationPriority(
    input.publication_priority ?? existing[0].publication_priority ?? DEFAULT_PUBLICATION_PRIORITY,
    columns
  );
  const summaryConfig =
    input.summary_config === undefined
      ? existing[0].summary_config ?? null
      : sanitizeRuleSummaryConfig(input.summary_config, columns);
  const sourceTable = await validateSourceTableViaApi(input.source_table ?? existing[0].source_table, id);
  const portalId = input.portal_id === undefined ? existing[0].portal_id : normalizePortalId(input.portal_id);
  if (portalId) await assertPortalExistsViaApi(portalId);
  const adLimit = await normalizeRuleAdLimitViaApi(
    portalId,
    input.use_ad_limit ?? existing[0].use_ad_limit ?? false,
    input.ad_limit_type === undefined ? existing[0].ad_limit_type : input.ad_limit_type
  );
  const updated = await dataApiRequest<PublicationRule[]>(`/publish_rules?id=eq.${id}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: {
      portal_id: portalId,
      name: input.name.trim(),
      slug: slugify(input.name),
      description: input.description ?? null,
      source_table: sourceTable,
      active: input.active ?? true,
      include_locked: input.include_locked ?? true,
      use_ad_limit: adLimit.useAdLimit,
      ad_limit_type: adLimit.adLimitType,
      filters,
      publication_priority: publicationPriority,
      summary_config: summaryConfig,
      updated_at: new Date().toISOString()
    }
  });

  if (!updated[0]) return null;
  const refreshed = await dataApiRpc<PublicationRule[]>("refresh_publish_rule_view", { rule_id: id });
  await refreshDependentRuleViewsViaApi(refreshed[0]?.view_name ?? null, new Set([id]));
  invalidateHealthcheckReportCache();
  return refreshed[0];
}

async function updateRuleSummaryConfigViaApi(id: number, summaryConfigInput: unknown) {
  const columns = await listBaseColumnsViaApi();
  const summaryConfig = sanitizeRuleSummaryConfig(summaryConfigInput, columns);
  const updated = await dataApiRequest<PublicationRule[]>(`/publish_rules?id=eq.${id}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: {
      summary_config: summaryConfig,
      updated_at: new Date().toISOString()
    }
  });
  invalidateHealthcheckReportCache();
  return updated[0] ?? null;
}

async function deleteRuleViaApi(id: number) {
  await dataApiRpc<PublicationRule[]>("drop_publish_rule_view", { rule_id: id });
  await dataApiRequest(`/publish_rules?id=eq.${id}`, { method: "DELETE" });
  invalidateHealthcheckReportCache();
}

async function runRuleHealthchecksViaApi(ruleId?: number | null) {
  return dataApiRpc<RuleHealthcheckStatus[]>("publish_rule_healthcheck", {
    target_rule_id: ruleId ?? null
  });
}

async function getRuleHealthcheckReportViaApi(ruleId: number | null, refresh: boolean): Promise<RuleHealthcheckReport> {
  const cacheKey = `data-api|${ruleId ?? "all"}`;
  if (!refresh && dataApiHealthcheckReportCache?.key === cacheKey && dataApiHealthcheckReportCache.expiresAt > Date.now()) {
    return {
      ...dataApiHealthcheckReportCache.value,
      cached: true,
      cache: {
        ...dataApiHealthcheckReportCache.value.cache,
        rule_hits: dataApiHealthcheckReportCache.value.rules.length,
        rule_misses: 0
      }
    };
  }

  const report = await dataApiRpc<RuleHealthcheckReport>("publish_rule_healthcheck_report", {
    target_rule_id: ruleId ?? null
  });
  const value: RuleHealthcheckReport = {
    ...report,
    cached: false,
    cache: {
      ttl_ms: HEALTHCHECK_REPORT_CACHE_MS,
      rule_hits: 0,
      rule_misses: report.rules.length
    }
  };
  dataApiHealthcheckReportCache = {
    key: cacheKey,
    expiresAt: Date.now() + HEALTHCHECK_REPORT_CACHE_MS,
    value
  };
  return value;
}

async function previewRuleViaApi(input: RuleInput) {
  const columns = await listBaseColumnsViaApi();
  const filters = sanitizeFilters(input.filters ?? DEFAULT_FILTERS, columns);
  const sourceTable = await validateSourceTableViaApi(input.source_table);
  const rows = await dataApiRpc<Array<{ count: number; limited_count: number | null }>>("preview_publish_rule", {
    filters,
    source_table: sourceTable,
    portal_id: normalizePortalId(input.portal_id),
    use_ad_limit: input.use_ad_limit ?? false,
    ad_limit_type: input.ad_limit_type ?? "total",
    include_locked: input.include_locked ?? true,
    active: input.active ?? true
  });
  return { count: rows[0]?.count ?? 0, limited_count: rows[0]?.limited_count ?? null };
}

async function previewRuleRowsViaApi(input: PreviewRowsInput) {
  const columns = await listBaseColumnsViaApi();
  const filters = sanitizeFilters(input.filters ?? DEFAULT_FILTERS, columns);
  const publicationPriority = sanitizePublicationPriority(input.publication_priority ?? DEFAULT_PUBLICATION_PRIORITY, columns);
  const sourceTable = await validateSourceTableViaApi(input.source_table);
  const portalId = normalizePortalId(input.portal_id);
  return dataApiRpc<{
    columns: Array<{ key: string; label: string }>;
    rows: Array<Record<string, unknown>>;
  }>("preview_publish_rule_rows", {
    filters,
    publication_priority: publicationPriority,
    source_table: sourceTable,
    portal_id: portalId,
    use_ad_limit: input.use_ad_limit ?? false,
    ad_limit_type: input.ad_limit_type ?? "total",
    include_locked: input.include_locked ?? true,
    active: input.active ?? true,
    preview_limit: input.limit === 100 ? 100 : 10,
    preview_sort_column: input.preview_sort_column ?? null,
    preview_sort_direction: input.preview_sort_direction === "desc" ? "desc" : "asc"
  });
}

async function previewRuleSummaryViaApi(_input: RuleSummaryInput): Promise<RuleSummaryResponse> {
  const columns = await listBaseColumnsViaApi();
  const filters = sanitizeFilters(_input.filters ?? DEFAULT_FILTERS, columns);
  const publicationPriority = sanitizePublicationPriority(_input.publication_priority ?? DEFAULT_PUBLICATION_PRIORITY, columns);
  const sourceTable = await validateSourceTableViaApi(_input.source_table);
  return dataApiRpc<RuleSummaryResponse>("preview_publish_rule_summary", {
    filters,
    publication_priority: publicationPriority,
    source_table: sourceTable,
    portal_id: normalizePortalId(_input.portal_id),
    use_ad_limit: _input.use_ad_limit ?? false,
    ad_limit_type: _input.ad_limit_type ?? "total",
    include_locked: _input.include_locked ?? true,
    active: _input.active ?? true,
    items: Array.isArray(_input.items) ? _input.items : []
  });
}

async function listBaseColumnsViaApi() {
  if (dataApiColumnsCache && dataApiColumnsCache.expiresAt > Date.now()) {
    return dataApiColumnsCache.columns;
  }

  const columns = await dataApiRpc<ColumnMetadata[]>("publish_base_columns");
  dataApiColumnsCache = { columns, expiresAt: Date.now() + DATA_API_COLUMNS_CACHE_MS };
  return columns;
}

async function listPortalAdTypes(client: PoolClient, portalId: number) {
  const result = await client.query<PortalAdType>(
    "select id, portal_id, name, quantity, created_at, updated_at from publish_portal_ad_types where portal_id = $1 order by name",
    [portalId]
  );
  return result.rows;
}

function portalAdTypesSignature(adTypes: PortalAdTypeInput[] | PortalAdType[]) {
  return JSON.stringify(sanitizeAdTypes(adTypes).sort((left, right) => left.name.localeCompare(right.name, "pt-BR")));
}

async function refreshRuleViewsForPortal(client: PoolClient, portalId: number) {
  const rules = await listRefreshableRules(client);
  const seedIds = rules.filter((rule) => rule.portal_id === portalId).map((rule) => rule.id);
  await refreshRuleViewsBySeedIds(client, seedIds, rules);
}

async function refreshDependentRuleViews(client: PoolClient, sourceViewName: string | null, ignoredIds = new Set<number>()) {
  if (!sourceViewName) return;
  const rules = await listRefreshableRules(client);
  const seedIds = rules
    .filter((rule) => rule.source_table === sourceViewName && !ignoredIds.has(rule.id))
    .map((rule) => rule.id);
  await refreshRuleViewsBySeedIds(client, seedIds, rules);
}

async function listRefreshableRules(client: PoolClient) {
  const result = await client.query<PublicationRule>("select * from publish_rules order by id asc");
  return result.rows;
}

async function refreshRuleViewsBySeedIds(client: PoolClient, seedIds: number[], rules: PublicationRule[]) {
  if (!seedIds.length) return;

  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  const viewToRuleId = new Map<string, number>();
  for (const rule of rules) {
    if (rule.view_name) viewToRuleId.set(rule.view_name, rule.id);
  }

  const pending = new Set<number>();
  const queue = [...seedIds];
  while (queue.length) {
    const ruleId = queue.shift();
    if (!ruleId || pending.has(ruleId)) continue;
    const rule = rulesById.get(ruleId);
    if (!rule) continue;
    pending.add(ruleId);

    if (!rule.view_name) continue;
    for (const child of rules) {
      if (child.source_table === rule.view_name && !pending.has(child.id)) {
        queue.push(child.id);
      }
    }
  }

  while (pending.size) {
    let progressed = false;
    for (const ruleId of [...pending]) {
      const rule = rulesById.get(ruleId);
      if (!rule) {
        pending.delete(ruleId);
        continue;
      }

      const parentRuleId = rule.source_table ? viewToRuleId.get(rule.source_table) : undefined;
      if (parentRuleId && pending.has(parentRuleId)) continue;

      const refreshed = await refreshRuleView(client, rule.id, rule.view_name, rule);
      rulesById.set(rule.id, { ...rule, ...refreshed });
      if (refreshed.view_name) viewToRuleId.set(refreshed.view_name, refreshed.id);
      pending.delete(ruleId);
      progressed = true;
    }

    if (!progressed) {
      const [ruleId] = pending;
      const rule = rulesById.get(ruleId);
      pending.delete(ruleId);
      if (rule) {
        const refreshed = await refreshRuleView(client, rule.id, rule.view_name, rule);
        rulesById.set(rule.id, { ...rule, ...refreshed });
        if (refreshed.view_name) viewToRuleId.set(refreshed.view_name, refreshed.id);
      }
    }
  }
}

async function refreshRuleViewsForPortalViaApi(portalId: number) {
  const rules = await dataApiRequest<PublicationRule[]>("/publish_rules?order=id.asc");
  const seedIds = rules.filter((rule) => rule.portal_id === portalId).map((rule) => rule.id);
  await refreshRuleViewsBySeedIdsViaApi(seedIds, rules);
}

async function refreshDependentRuleViewsViaApi(sourceViewName: string | null, ignoredIds = new Set<number>()) {
  if (!sourceViewName) return;
  const rules = await dataApiRequest<PublicationRule[]>("/publish_rules?order=id.asc");
  const seedIds = rules
    .filter((rule) => rule.source_table === sourceViewName && !ignoredIds.has(rule.id))
    .map((rule) => rule.id);
  await refreshRuleViewsBySeedIdsViaApi(seedIds, rules);
}

async function refreshRuleViewsBySeedIdsViaApi(seedIds: number[], rules: PublicationRule[]) {
  if (!seedIds.length) return;

  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  const viewToRuleId = new Map<string, number>();
  for (const rule of rules) {
    if (rule.view_name) viewToRuleId.set(rule.view_name, rule.id);
  }

  const pending = new Set<number>();
  const queue = [...seedIds];
  while (queue.length) {
    const ruleId = queue.shift();
    if (!ruleId || pending.has(ruleId)) continue;
    const rule = rulesById.get(ruleId);
    if (!rule) continue;
    pending.add(ruleId);

    if (!rule.view_name) continue;
    for (const child of rules) {
      if (child.source_table === rule.view_name && !pending.has(child.id)) {
        queue.push(child.id);
      }
    }
  }

  while (pending.size) {
    let progressed = false;
    for (const ruleId of [...pending]) {
      const rule = rulesById.get(ruleId);
      if (!rule) {
        pending.delete(ruleId);
        continue;
      }

      const parentRuleId = rule.source_table ? viewToRuleId.get(rule.source_table) : undefined;
      if (parentRuleId && pending.has(parentRuleId)) continue;

      const refreshed = await dataApiRpc<PublicationRule[]>("refresh_publish_rule_view", { rule_id: rule.id });
      const refreshedRule = refreshed[0];
      if (refreshedRule) {
        rulesById.set(rule.id, { ...rule, ...refreshedRule });
        if (refreshedRule.view_name) viewToRuleId.set(refreshedRule.view_name, refreshedRule.id);
      }
      pending.delete(ruleId);
      progressed = true;
    }

    if (!progressed) {
      const [ruleId] = pending;
      pending.delete(ruleId);
      const rule = rulesById.get(ruleId);
      if (rule) {
        const refreshed = await dataApiRpc<PublicationRule[]>("refresh_publish_rule_view", { rule_id: rule.id });
        const refreshedRule = refreshed[0];
        if (refreshedRule) {
          rulesById.set(rule.id, { ...rule, ...refreshedRule });
          if (refreshedRule.view_name) viewToRuleId.set(refreshedRule.view_name, refreshedRule.id);
        }
      }
    }
  }
}

async function assertPortalExistsViaApi(portalId: number) {
  const rows = await dataApiRequest<Array<Pick<Portal, "id">>>(`/publish_portals?id=eq.${portalId}&select=id&limit=1`);
  if (!rows[0]) throw new Error("Portal nao encontrado.");
}

async function listSourceViews(client: PoolClient): Promise<SourceViewMetadata[]> {
  const result = await client.query<SourceViewMetadata>(`
    select c.relname::text as view_name,
      case c.relkind when 'm' then 'materialized' else 'view' end as view_type
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('v', 'm')
    order by c.relname
  `);
  return result.rows;
}

async function listSourceViewsViaApi() {
  return dataApiRpc<SourceViewMetadata[]>("publish_source_views");
}

async function validateSourceTable(client: PoolClient, sourceTable?: string | null, excludedRuleId?: number) {
  const source = normalizeSourceTable(sourceTable);
  if (source === "base_imoveis") return source;

  if (excludedRuleId) {
    const currentRule = await client.query<{ view_name: string | null }>(
      "select view_name from publish_rules where id = $1",
      [excludedRuleId]
    );
    if (currentRule.rows[0]?.view_name === source) {
      throw new Error("Preset inicial nao pode ser a propria view da regra.");
    }
  }

  if (!(await sourceViewExists(client, source))) throw new Error("Preset inicial invalido ou indisponivel.");
  return source;
}

async function validateSourceTableViaApi(sourceTable?: string | null, excludedRuleId?: number) {
  const source = normalizeSourceTable(sourceTable);
  if (source === "base_imoveis") return source;

  if (excludedRuleId) {
    const currentRule = await dataApiRequest<Array<Pick<PublicationRule, "view_name">>>(
      `/publish_rules?id=eq.${excludedRuleId}&select=view_name&limit=1`
    );
    if (currentRule[0]?.view_name === source) {
      throw new Error("Preset inicial nao pode ser a propria view da regra.");
    }
  }

  const views = await listSourceViewsViaApi();
  if (!views.some((view) => view.view_name === source)) {
    throw new Error("Preset inicial invalido ou indisponivel.");
  }
  return source;
}

async function sourceViewExists(client: PoolClient, viewName: string) {
  const result = await client.query<{ exists: boolean }>(
    `
      select exists (
        select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind in ('v', 'm')
          and c.relname = $1
      ) as exists
    `,
    [viewName]
  );
  return result.rows[0]?.exists ?? false;
}

function normalizeSourceTable(sourceTable?: string | null) {
  const source = sourceTable?.trim() || "base_imoveis";
  if (source === "base_imoveis") return source;
  if (source.includes("\u0000")) throw new Error("Preset inicial invalido.");
  return source;
}

function normalizePortalId(portalId?: number | string | null) {
  if (portalId == null || portalId === "") return null;
  const normalized = Number(portalId);
  if (!Number.isInteger(normalized) || normalized <= 0) throw new Error("Portal vinculado invalido.");
  return normalized;
}

function normalizeOptionalPositiveInteger(value?: number | string | null) {
  if (value == null || value === "") return null;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) throw new Error("Identificador invalido.");
  return normalized;
}

function normalizePortalSlug(slug: string | null | undefined, fallbackName: string) {
  const normalized = (slug?.trim() || slugify(fallbackName)).trim();
  if (!normalized) throw new Error("Slug do portal e obrigatorio.");
  if (!/^[a-z0-9_]+$/.test(normalized)) {
    throw new Error("Slug do portal deve usar apenas letras minusculas, numeros e underscore.");
  }
  return normalized;
}

function normalizeAdLimitType(adLimitType?: string | null) {
  const normalized = normalizeAdTypeName(adLimitType || "total");
  return normalized || "total";
}

function adLimitTypeSlug(adLimitType: string) {
  return slugify(normalizeAdTypeName(adLimitType));
}

async function normalizeRuleAdLimit(
  client: PoolClient,
  portalId: number | null,
  useAdLimit: boolean,
  adLimitType?: string | null
) {
  if (!useAdLimit) return { useAdLimit: false, adLimitType: null };
  if (!portalId) throw new Error("Limite de anuncios exige portal vinculado.");

  const normalizedType = normalizeAdLimitType(adLimitType);
  if (normalizedType !== "total") {
    const result = await client.query<{ exists: boolean }>(
      "select exists (select 1 from publish_portal_ad_types where portal_id = $1 and name = $2) as exists",
      [portalId, normalizedType]
    );
    if (!result.rows[0]?.exists) throw new Error("Tipo de anuncio nao encontrado para este portal.");
  }

  return { useAdLimit: true, adLimitType: normalizedType };
}

async function normalizeRuleAdLimitViaApi(
  portalId: number | null,
  useAdLimit: boolean,
  adLimitType?: string | null
) {
  if (!useAdLimit) return { useAdLimit: false, adLimitType: null };
  if (!portalId) throw new Error("Limite de anuncios exige portal vinculado.");

  const normalizedType = normalizeAdLimitType(adLimitType);
  if (normalizedType !== "total") {
    const rows = await dataApiRequest<Array<Pick<PortalAdType, "id">>>(
      `/publish_portal_ad_types?portal_id=eq.${portalId}&name=eq.${encodeURIComponent(normalizedType)}&select=id&limit=1`
    );
    if (!rows[0]) throw new Error("Tipo de anuncio nao encontrado para este portal.");
  }

  return { useAdLimit: true, adLimitType: normalizedType };
}

async function getAdLimitQuota(client: PoolClient, portalId: number | null, adLimitType?: string | null) {
  if (!portalId) return 0;
  const result = await client.query<{ quota: number }>("select publish_ad_limit_quota($1, $2) as quota", [
    portalId,
    normalizeAdLimitType(adLimitType)
  ]);
  return result.rows[0]?.quota ?? 0;
}

function sanitizeAdTypes(adTypes: PortalAdTypeInput[]) {
  const normalized = new Map<string, number>();
  for (const adType of adTypes) {
    const name = normalizeAdTypeName(adType.name);
    if (!name) continue;

    const quantity = Math.max(0, Math.trunc(Number(adType.quantity) || 0));
    normalized.set(name, (normalized.get(name) ?? 0) + quantity);
  }

  return [...normalized.entries()].map(([name, quantity]) => ({ name, quantity }));
}

function normalizeAdTypeName(name: string) {
  return name.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("pt-BR");
}

async function replacePortalAdTypes(client: PoolClient, portalId: number, adTypes: PortalAdTypeInput[]) {
  await client.query("delete from publish_portal_ad_types where portal_id = $1", [portalId]);
  for (const adType of sanitizeAdTypes(adTypes)) {
    await client.query(
      `
        insert into publish_portal_ad_types (portal_id, name, quantity)
        values ($1, $2, $3)
      `,
      [portalId, adType.name, adType.quantity]
    );
  }
}

async function getPortalById(client: PoolClient, portalId: number) {
  const result = await client.query<Portal>(
    `
      select p.*,
        (select count(*)::int from publish_rules r where r.portal_id = p.id) as rules_count,
        (select coalesce(sum(a2.quantity), 0)::int from publish_portal_ad_types a2 where a2.portal_id = p.id) as total_quota,
        coalesce(
          jsonb_agg(
            jsonb_build_object(
              'id', a.id,
              'portal_id', a.portal_id,
              'name', a.name,
              'quantity', a.quantity,
              'created_at', a.created_at,
              'updated_at', a.updated_at
            )
          ) filter (where a.id is not null),
          '[]'::jsonb
        ) as ad_types
      from publish_portals p
      left join publish_portal_ad_types a on a.portal_id = p.id
      where p.id = $1
      group by p.id
    `,
    [portalId]
  );
  return result.rows[0];
}

async function replacePortalAdTypesViaApi(portalId: number, adTypes: PortalAdTypeInput[]) {
  await dataApiRequest(`/publish_portal_ad_types?portal_id=eq.${portalId}`, { method: "DELETE" });
  const cleanAdTypes = sanitizeAdTypes(adTypes);
  if (!cleanAdTypes.length) return;

  await dataApiRequest("/publish_portal_ad_types", {
    method: "POST",
    prefer: "return=minimal",
    body: cleanAdTypes.map((adType) => ({
      portal_id: portalId,
      name: adType.name,
      quantity: adType.quantity
    }))
  });
}

async function getPortalByIdViaApi(portalId: number) {
  const [portals, rules, adTypes] = await Promise.all([
    dataApiRequest<Portal[]>(`/publish_portals?id=eq.${portalId}&limit=1`),
    dataApiRequest<Array<{ id: number; portal_id: number }>>(`/publish_rules?portal_id=eq.${portalId}&select=id,portal_id`),
    dataApiRequest<PortalAdType[]>(`/publish_portal_ad_types?portal_id=eq.${portalId}&order=name.asc`)
  ]);
  if (!portals[0]) return null;
  return {
    ...portals[0],
    rules_count: rules.length,
    ad_types: adTypes,
    total_quota: sumPortalQuota(adTypes)
  };
}

function groupAdTypesByPortal(adTypes: PortalAdType[]) {
  const result = new Map<number, PortalAdType[]>();
  for (const adType of adTypes) {
    if (!adType.portal_id) continue;
    const current = result.get(adType.portal_id) ?? [];
    current.push(adType);
    result.set(adType.portal_id, current);
  }
  return result;
}

function sumPortalQuota(adTypes: PortalAdType[]) {
  return adTypes.reduce((total, adType) => total + (Number(adType.quantity) || 0), 0);
}

const HEALTHCHECK_REVERSE_SOURCE_TABLE = "imoveis_ativos";

type HealthcheckRuleRow = Pick<
  PublicationRule,
  "id" | "portal_id" | "view_name" | "use_ad_limit" | "ad_limit_type"
> & {
  portal_slug: string | null;
};

type HealthcheckReportRuleRow = Pick<
  PublicationRule,
  | "id"
  | "name"
  | "slug"
  | "view_name"
  | "active"
  | "use_ad_limit"
  | "ad_limit_type"
  | "health_expected_count"
  | "health_published_count"
  | "health_pending_count"
  | "health_unexpected_count"
  | "health_checked_at"
  | "health_error"
  | "updated_at"
> & {
  portal_id: number;
  portal_name: string;
  portal_slug: string;
};

function healthcheckReportRuleCacheKey(rule: HealthcheckReportRuleRow) {
  return [
    rule.id,
    rule.view_name ?? "",
    rule.portal_id,
    rule.portal_slug,
    rule.use_ad_limit ? "1" : "0",
    rule.ad_limit_type ?? "",
    rule.health_checked_at ?? "",
    rule.updated_at ?? ""
  ].join("|");
}

function invalidateHealthcheckReportCache(ruleId?: number | null) {
  dataApiHealthcheckReportCache = null;

  if (!ruleId) {
    healthcheckReportRuleCache.clear();
    return;
  }

  const keyPrefix = `${ruleId}|`;
  for (const key of healthcheckReportRuleCache.keys()) {
    if (key.startsWith(keyPrefix)) healthcheckReportRuleCache.delete(key);
  }
}

function trimHealthcheckReportRuleCache() {
  if (healthcheckReportRuleCache.size <= 300) return;
  const now = Date.now();
  for (const [key, value] of healthcheckReportRuleCache) {
    if (value.expiresAt <= now || healthcheckReportRuleCache.size > 220) {
      healthcheckReportRuleCache.delete(key);
    }
  }
}

function healthcheckAdType(rule: Pick<PublicationRule, "use_ad_limit" | "ad_limit_type">) {
  const name = rule.use_ad_limit && rule.ad_limit_type ? rule.ad_limit_type : "total";
  return {
    name,
    slug: name === "total" ? "total" : adLimitTypeSlug(name),
    is_total: name === "total"
  };
}

function healthcheckPublishedPredicate(alias: string, portalSlug: string, adTypeSlug: string, shouldFilterType: boolean) {
  const portalLiteral = quoteLiteral(portalSlug);
  return [
    `coalesce((${alias}.publicacao_portais::jsonb -> ${portalLiteral} ->> 'publicado')::boolean, false) is true`,
    shouldFilterType ? `${alias}.publicacao_portais::jsonb -> ${portalLiteral} ->> 'tipo' = ${quoteLiteral(adTypeSlug)}` : null
  ].filter(Boolean).join(" and ");
}

function healthcheckPendingQuery(rule: HealthcheckReportRuleRow, adTypeSlug: string) {
  if (!rule.view_name) return null;
  const shouldFilterType = rule.use_ad_limit && Boolean(rule.ad_limit_type && rule.ad_limit_type !== "total");
  return `
select b.codigo_crm::text as codigo_crm
from public.${quoteIdentifier(rule.view_name)} b
where not (${healthcheckPublishedPredicate("b", rule.portal_slug, adTypeSlug, shouldFilterType)})
order by b.codigo_crm
`.trim();
}

function healthcheckUnexpectedQuery(rule: HealthcheckReportRuleRow, adTypeSlug: string) {
  if (!rule.view_name) return null;
  const shouldFilterType = rule.use_ad_limit && Boolean(rule.ad_limit_type && rule.ad_limit_type !== "total");
  return `
select ia.codigo_crm::text as codigo_crm
from public.${quoteIdentifier(HEALTHCHECK_REVERSE_SOURCE_TABLE)} ia
where ${healthcheckPublishedPredicate("ia", rule.portal_slug, adTypeSlug, shouldFilterType)}
  and not exists (
    select 1
    from public.${quoteIdentifier(rule.view_name)} p
    where p.codigo_crm = ia.codigo_crm
  )
order by ia.codigo_crm
`.trim();
}

async function buildHealthcheckReportRule(rule: HealthcheckReportRuleRow): Promise<RuleHealthcheckReportRule> {
  const adType = healthcheckAdType(rule);
  const baseReport: RuleHealthcheckReportRule = {
    rule: {
      id: rule.id,
      name: rule.name,
      slug: rule.slug,
      view_name: rule.view_name,
      active: rule.active
    },
    portal: {
      id: rule.portal_id,
      name: rule.portal_name,
      slug: rule.portal_slug
    },
    ad_type: adType,
    status: {
      expected_count: rule.health_expected_count,
      published_count: rule.health_published_count,
      pending_count: rule.health_pending_count,
      unexpected_count: rule.health_unexpected_count,
      checked_at: rule.health_checked_at,
      error: rule.health_error
    },
    codes: {
      pending: [],
      unexpected: []
    },
    queries: {
      pending_codes: null,
      unexpected_codes: null
    },
    error: rule.health_error
  };

  if (!rule.view_name) {
    return { ...baseReport, error: baseReport.error ?? "View da regra ainda nao foi criada." };
  }

  const pendingQuery = healthcheckPendingQuery(rule, adType.slug);
  const unexpectedQuery = healthcheckUnexpectedQuery(rule, adType.slug);
  baseReport.queries.pending_codes = pendingQuery;
  baseReport.queries.unexpected_codes = unexpectedQuery;

  try {
    const [pending, unexpected] = await Promise.all([
      pendingQuery ? query<{ codigo_crm: string }>(pendingQuery) : Promise.resolve({ rows: [] } as { rows: Array<{ codigo_crm: string }> }),
      unexpectedQuery ? query<{ codigo_crm: string }>(unexpectedQuery) : Promise.resolve({ rows: [] } as { rows: Array<{ codigo_crm: string }> })
    ]);

    return {
      ...baseReport,
      codes: {
        pending: pending.rows.map((row) => row.codigo_crm),
        unexpected: unexpected.rows.map((row) => row.codigo_crm)
      }
    };
  } catch (error) {
    return {
      ...baseReport,
      error: error instanceof Error ? error.message : "Erro ao montar detalhes do healthcheck."
    };
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  callback: (item: T, index: number) => Promise<R>
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await callback(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

async function runSingleRuleHealthcheck(rule: HealthcheckRuleRow): Promise<RuleHealthcheckStatus> {
  const checkedAt = new Date().toISOString();

  try {
    if (!rule.portal_id || !rule.portal_slug) {
      return updateRuleHealthcheckStatus(rule, null, null, null, null, checkedAt, "Regra sem portal vinculado.");
    }

    if (!rule.view_name) {
      return updateRuleHealthcheckStatus(rule, null, null, null, null, checkedAt, "View da regra ainda nao foi criada.");
    }

    const viewExists = await query<{ exists: boolean }>(
      `
        select exists (
          select 1
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and c.relkind in ('v', 'm')
            and c.relname = $1
        ) as exists
      `,
      [rule.view_name]
    );
    if (!viewExists.rows[0]?.exists) {
      return updateRuleHealthcheckStatus(rule, null, null, null, null, checkedAt, "View da regra nao encontrada.");
    }

    const hasPublicationPortals = await query<{ exists: boolean }>(
      `
        select exists (
          select 1
          from information_schema.columns
          where table_schema = 'public'
            and table_name = $1
            and column_name = 'publicacao_portais'
        ) as exists
      `,
      [rule.view_name]
    );
    if (!hasPublicationPortals.rows[0]?.exists) {
      return updateRuleHealthcheckStatus(
        rule,
        null,
        null,
        null,
        null,
        checkedAt,
        "Coluna publicacao_portais nao encontrada na view da regra."
      );
    }

    const reverseSourceReady = await query<{ ready: boolean }>(
      `
        select exists (
          select 1
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and c.relkind in ('r', 'v', 'm')
            and c.relname = $1
        )
        and exists (
          select 1
          from information_schema.columns
          where table_schema = 'public'
            and table_name = $1
            and column_name = 'publicacao_portais'
        )
        and exists (
          select 1
          from information_schema.columns
          where table_schema = 'public'
            and table_name = $1
            and column_name = 'codigo_crm'
        )
        and exists (
          select 1
          from information_schema.columns
          where table_schema = 'public'
            and table_name = $2
            and column_name = 'codigo_crm'
        ) as ready
      `,
      [HEALTHCHECK_REVERSE_SOURCE_TABLE, rule.view_name]
    );
    if (!reverseSourceReady.rows[0]?.ready) {
      return updateRuleHealthcheckStatus(
        rule,
        null,
        null,
        null,
        null,
        checkedAt,
        "Base imoveis_ativos ou coluna codigo_crm/publicacao_portais indisponivel para verificacao inversa."
      );
    }

    const expected = await query<{ count: number }>(
      `select count(*)::int as count from public.${quoteIdentifier(rule.view_name)}`
    );
    const expectedCount = expected.rows[0]?.count ?? 0;
    const shouldFilterType = rule.use_ad_limit && Boolean(rule.ad_limit_type && rule.ad_limit_type !== "total");
    const adLimitTypeFilter = shouldFilterType && rule.ad_limit_type ? adLimitTypeSlug(rule.ad_limit_type) : null;
    const published = await query<{ count: number }>(
      `
        select count(*)::int as count
        from public.${quoteIdentifier(rule.view_name)} b
        where coalesce((b.publicacao_portais::jsonb -> $1 ->> 'publicado')::boolean, false) is true
        ${shouldFilterType ? "and b.publicacao_portais::jsonb -> $1 ->> 'tipo' = $2" : ""}
      `,
      shouldFilterType ? [rule.portal_slug, adLimitTypeFilter] : [rule.portal_slug]
    );
    const publishedCount = published.rows[0]?.count ?? 0;
    const unexpected = await query<{ count: number }>(
      `
        select count(*)::int as count
        from public.${quoteIdentifier(HEALTHCHECK_REVERSE_SOURCE_TABLE)} ia
        where coalesce((ia.publicacao_portais::jsonb -> $1 ->> 'publicado')::boolean, false) is true
          ${shouldFilterType ? "and ia.publicacao_portais::jsonb -> $1 ->> 'tipo' = $2" : ""}
          and not exists (
            select 1
            from public.${quoteIdentifier(rule.view_name)} p
            where p.codigo_crm = ia.codigo_crm
          )
      `,
      shouldFilterType ? [rule.portal_slug, adLimitTypeFilter] : [rule.portal_slug]
    );
    const unexpectedCount = unexpected.rows[0]?.count ?? 0;
    return updateRuleHealthcheckStatus(
      rule,
      expectedCount,
      publishedCount,
      Math.max(expectedCount - publishedCount, 0),
      unexpectedCount,
      checkedAt,
      null
    );
  } catch (error) {
    return updateRuleHealthcheckStatus(
      rule,
      null,
      null,
      null,
      null,
      checkedAt,
      error instanceof Error ? error.message : "Erro ao executar healthcheck."
    );
  }
}

async function updateRuleHealthcheckStatus(
  rule: HealthcheckRuleRow,
  expectedCount: number | null,
  publishedCount: number | null,
  pendingCount: number | null,
  unexpectedCount: number | null,
  checkedAt: string,
  error: string | null
): Promise<RuleHealthcheckStatus> {
  await query(
    `
      update publish_rules
      set health_expected_count = $2,
          health_published_count = $3,
          health_pending_count = $4,
          health_unexpected_count = $5,
          health_checked_at = $6::timestamptz,
          health_error = $7,
          updated_at = now()
      where id = $1
    `,
    [rule.id, expectedCount, publishedCount, pendingCount, unexpectedCount, checkedAt, error]
  );

  return {
    rule_id: rule.id,
    portal_id: rule.portal_id,
    portal_slug: rule.portal_slug,
    expected_count: expectedCount,
    published_count: publishedCount,
    pending_count: pendingCount,
    unexpected_count: unexpectedCount,
    checked_at: checkedAt,
    error
  };
}

async function refreshRuleView(
  client: PoolClient,
  id: number,
  viewName: string | null,
  rule: Pick<
    PublicationRule,
    "portal_id" | "filters" | "source_table" | "active" | "include_locked" | "use_ad_limit" | "ad_limit_type" | "publication_priority" | "summary_config"
  >
) {
  const targetViewName = viewName ?? `pc_rule_${id}`;
  const columns = await getBaseColumns(client);
  const limitSql = rule.use_ad_limit ? buildAdLimitSql(rule.portal_id, rule.ad_limit_type) : null;
  const sql = buildViewSql(
    targetViewName,
    rule.source_table,
    rule.filters,
    columns,
    rule.include_locked,
    rule.active,
    rule.publication_priority,
    limitSql
  );
  await client.query(sql);

  const countSql = buildWhereSql(rule.filters, columns, rule.include_locked, true);
  const count = await client.query<{ count: number }>(
    `select count(*)::int as count from public.${quoteIdentifier(rule.source_table)} b where ${rule.active ? countSql.whereSql : "false"}`,
    countSql.params
  );

  const totalCount = count.rows[0]?.count ?? 0;
  const limitedCount = rule.use_ad_limit ? Math.min(totalCount, await getAdLimitQuota(client, rule.portal_id, rule.ad_limit_type)) : null;
  const result = await client.query<PublicationRule>(
    `
      update publish_rules
      set view_name = $2, last_sql = $3, last_count = $4, last_limited_count = $5, updated_at = now()
      where id = $1
      returning *
    `,
    [id, targetViewName, sql, totalCount, limitedCount]
  );

  return result.rows[0];
}
