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
  RULE_INDEX_COLUMN,
  getBaseColumns,
  getFilterKind,
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
  PublishAutomation,
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
  final_listing_refresh_time?: string | null;
  ad_types?: PortalAdTypeInput[];
};

type PortalAdTypeInput = {
  id?: number;
  name: string;
  quantity: number;
  tier?: number | string | null;
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
  crm_code?: string | null;
};

type RuleSummaryInput = RuleInput & {
  items?: RuleSummaryConfigItem[];
};

type RuleQueryPreviewInput = RuleInput & {
  id?: number | string | null;
  view_name?: string | null;
};

type PortalFinalPreviewRowsInput = {
  portal_id?: number | string | null;
  limit?: number;
  preview_sort_column?: string | null;
  preview_sort_direction?: "asc" | "desc" | null;
  crm_code?: string | null;
  refresh?: boolean;
};

type PortalFinalSummaryInput = {
  portal_id?: number | string | null;
  items?: RuleSummaryConfigItem[];
  refresh?: boolean;
};

const DEFAULT_SUMMARY_GROUP_COUNT = 5;
const DEFAULT_SUMMARY_VALUE_COUNT_LIMIT = 5;
const MAX_SUMMARY_ITEMS = 12;
const DATA_API_COLUMNS_CACHE_MS = 5 * 60 * 1000;
const PUBLISH_REFRESH_LOCK_NAMESPACE = 748513;
const PUBLISH_REFRESH_LOCK_KEY = 42017;
const HEALTHCHECK_REPORT_CACHE_MS = Math.max(
  10_000,
  Number(process.env.HEALTHCHECK_REPORT_CACHE_MS ?? "120000") || 120_000
);
const HEALTHCHECK_REPORT_RULE_CONCURRENCY = Math.max(
  1,
  Math.min(2, Number(process.env.HEALTHCHECK_REPORT_RULE_CONCURRENCY ?? "1") || 1)
);
const FINAL_VIEW_AD_TYPE_NAME_COLUMN = "ad_type_name";
const FINAL_VIEW_AD_TYPE_SLUG_COLUMN = "ad_type_slug";
const FINAL_VIEW_TIER_COLUMN = "tier";
const FINAL_VIEW_PUBLICATION_RANK_COLUMN = "publication_rank";
const FINAL_VIEW_STATUS_COLUMN = "status";
const FINAL_VIEW_CURRENT_PUBLICATION_COLUMN = "current_publication";
const FINAL_VIEW_PUBLISHED_STATUS = "published";
const FINAL_VIEW_PENDING_STATUS = "pending";
const FINAL_VIEW_REQUIRED_COLUMNS = ["codigo_crm", "publicacao_portais"];
const FINAL_SUMMARY_COLUMN_PREFIX = "__final_";
const BASE_SUMMARY_COLUMN_PREFIX = "__base_";
const FINAL_VIEW_PREVIEW_COLUMNS = [
  { key: "codigo_crm", label: "codigo_crm" },
  { key: FINAL_VIEW_STATUS_COLUMN, label: "Status" },
  { key: FINAL_VIEW_AD_TYPE_NAME_COLUMN, label: "Tipo de anuncio" },
  { key: FINAL_VIEW_AD_TYPE_SLUG_COLUMN, label: "Slug do tipo" },
  { key: FINAL_VIEW_TIER_COLUMN, label: "Tier" },
  { key: FINAL_VIEW_PUBLICATION_RANK_COLUMN, label: "Ordem" }
] as const;
const FINAL_VIEW_RESERVED_COLUMNS = new Set([
  RULE_INDEX_COLUMN,
  "__allocation_rule_order",
  "__ad_type_duplicate_rank",
  "__allocation_match_rank",
  "__allocation_tier_distance",
  "__candidate_ad_type_slug",
  "__candidate_tier",
  FINAL_VIEW_AD_TYPE_NAME_COLUMN,
  FINAL_VIEW_AD_TYPE_SLUG_COLUMN,
  FINAL_VIEW_TIER_COLUMN,
  FINAL_VIEW_PUBLICATION_RANK_COLUMN,
  FINAL_VIEW_STATUS_COLUMN,
  FINAL_VIEW_CURRENT_PUBLICATION_COLUMN
]);

let dataApiColumnsCache: { expiresAt: number; columns: ColumnMetadata[] } | null = null;
let dataApiHealthcheckReportCache: { key: string; expiresAt: number; value: RuleHealthcheckReport } | null = null;
let healthcheckRunQueue: Promise<unknown> = Promise.resolve();

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
            'slug', a.slug,
            'quantity', a.quantity,
            'tier', a.tier,
            'created_at', a.created_at,
            'updated_at', a.updated_at
          )
          order by a.quantity desc, a.tier asc, a.id asc
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
    await acquirePublishRefreshLock(client);
    const slug = normalizePortalSlug(input.slug, input.name);
    const result = await client.query<Portal>(
      `
        insert into publish_portals (name, slug, description, logo_url, active, final_listing_refresh_time)
        values ($1, $2, $3, $4, $5, $6::time)
        returning *
      `,
      [
        input.name.trim(),
        slug,
        input.description ?? null,
        input.logo_url ?? null,
        input.active ?? true,
        normalizePortalRefreshTime(input.final_listing_refresh_time)
      ]
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
    await acquirePublishRefreshLock(client);
    const existingPortal = await client.query<Pick<Portal, "slug">>("select slug from publish_portals where id = $1", [id]);
    const slug = normalizePortalSlug(input.slug, input.name);
    const currentAdTypes = await listPortalAdTypes(client, id);
    const adTypesChanged = portalAdTypesSignature(currentAdTypes) !== portalAdTypesSignature(input.ad_types ?? []);
    const result = await client.query<Portal>(
      `
        update publish_portals
        set name = $2,
            slug = $3,
            description = $4,
            logo_url = $5,
            active = $6,
            final_listing_refresh_time = $7::time,
            updated_at = now()
        where id = $1
        returning *
      `,
      [
        id,
        input.name.trim(),
        slug,
        input.description ?? null,
        input.logo_url ?? null,
        input.active ?? true,
        normalizePortalRefreshTime(input.final_listing_refresh_time)
      ]
    );
    if (!result.rows[0]) return null;
    if (existingPortal.rows[0]?.slug && existingPortal.rows[0].slug !== slug) {
      await dropPortalFinalViewBySlug(client, existingPortal.rows[0].slug);
    }
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
    await acquirePublishRefreshLock(client);
    const portal = await client.query<Pick<Portal, "slug">>("select slug from publish_portals where id = $1", [id]);
    if (portal.rows[0]?.slug) await dropPortalFinalViewBySlug(client, portal.rows[0].slug);
    await client.query("update publish_rules set portal_id = null, updated_at = now() where portal_id = $1", [id]);
    await client.query("delete from publish_portals where id = $1", [id]);
  });
  invalidateHealthcheckReportCache();
}

export async function listAutomations() {
  if (isDataApiConfigured()) return listAutomationsViaApi();

  await ensureControlSchema();
  const result = await query<PublishAutomation>(`
    select *
    from publish_automations
    where deleted_at is null
    order by name asc, key asc
  `);
  return result.rows;
}

export async function updateAutomationActive(key: string, active: boolean) {
  if (isDataApiConfigured()) return updateAutomationActiveViaApi(key, active);

  await ensureControlSchema();
  const automation = await withTransaction(async (client) => {
    const updated = await client.query<PublishAutomation>(
      `
        update publish_automations
        set active = $2,
            updated_at = now()
        where key = $1
          and deleted_at is null
        returning *
      `,
      [key, active]
    );
    if (!updated.rows[0]) return null;

    if (active) {
      await client.query("select * from public.publish_apply_automation($1)", [key]);
    }

    return getAutomationByKey(client, key);
  });
  return automation;
}

export async function deleteAutomation(key: string) {
  if (isDataApiConfigured()) return deleteAutomationViaApi(key);

  await ensureControlSchema();
  const result = await query<PublishAutomation>(
    `
      update publish_automations
      set active = false,
          deleted_at = coalesce(deleted_at, now()),
          updated_at = now()
      where key = $1
        and deleted_at is null
      returning *
    `,
    [key]
  );
  return result.rows[0] ?? null;
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
    await acquirePublishRefreshLock(client);
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
    const refreshed = await refreshRuleView(client, rule.id, viewName, {
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
    return refreshed;
  });
  invalidateHealthcheckReportCache();
  return rule;
}

export async function updateRule(id: number, input: RuleInput) {
  if (isDataApiConfigured()) return updateRuleViaApi(id, input);

  await ensureControlSchema();
  const rule = await withTransaction(async (client) => {
    await acquirePublishRefreshLock(client);
    const columns = await getBaseColumns(client);
    const existing = await client.query<PublicationRule>("select * from publish_rules where id = $1", [id]);
    if (!existing.rows[0]) return null;

    const previousPortalId = existing.rows[0].portal_id;
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
    await acquirePublishRefreshLock(client);
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
    await acquirePublishRefreshLock(client);
    const existing = await client.query<{ view_name: string | null }>(
      `
        select r.view_name
        from publish_rules r
        where r.id = $1
      `,
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

  return enqueueHealthcheckRun(async () => runRuleHealthchecksDirect(ruleId));
}

function enqueueHealthcheckRun<T>(callback: () => Promise<T>) {
  const previousRun = healthcheckRunQueue.catch(() => undefined);
  const queuedRun = previousRun.then(callback);
  healthcheckRunQueue = queuedRun.catch(() => undefined);
  return queuedRun;
}

async function runRuleHealthchecksDirect(ruleId?: number | null): Promise<RuleHealthcheckStatus[]> {
  await ensureControlSchema();
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const lockAcquired = await tryAcquirePublishRefreshLock(client);
    if (!lockAcquired) {
      const statuses = await listStoredRuleHealthcheckStatuses(client, ruleId);
      await client.query("commit");
      logRepository("info", "healthcheck.skipped-refresh-lock", {
        ruleId: ruleId ?? null,
        statusCount: statuses.length
      });
      return statuses;
    }

    const result = await client.query<
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

    const portalStatusErrors = await refreshFinalStatusesForHealthcheck(client, result.rows);

    const statuses: RuleHealthcheckStatus[] = [];
    for (const rule of result.rows) {
      statuses.push(await runSingleRuleHealthcheck(client, rule, rule.portal_id ? portalStatusErrors.get(rule.portal_id) ?? null : null));
    }
    await client.query("commit");
    invalidateHealthcheckReportCache(ruleId);
    return statuses;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function listStoredRuleHealthcheckStatuses(client: PoolClient, ruleId?: number | null) {
  const result = await client.query<{
    rule_id: number;
    portal_id: number | null;
    portal_slug: string | null;
    expected_count: number | null;
    published_count: number | null;
    pending_count: number | null;
    unexpected_count: number | null;
    checked_at: string | null;
    error: string | null;
  }>(
    `
      select r.id as rule_id,
             r.portal_id,
             p.slug as portal_slug,
             r.health_expected_count as expected_count,
             r.health_published_count as published_count,
             r.health_pending_count as pending_count,
             r.health_unexpected_count as unexpected_count,
             r.health_checked_at as checked_at,
             r.health_error as error
      from publish_rules r
      left join publish_portals p on p.id = r.portal_id
      ${ruleId ? "where r.id = $1" : ""}
      order by r.updated_at desc, r.id desc
    `,
    ruleId ? [ruleId] : []
  );
  return result.rows;
}

export async function getRuleHealthcheckReport(options: { ruleId?: number | null; refresh?: boolean } = {}): Promise<RuleHealthcheckReport> {
  const ruleId = normalizeOptionalPositiveInteger(options.ruleId);
  if (isDataApiConfigured()) return getRuleHealthcheckReportViaApi(ruleId, Boolean(options.refresh));

  if (options.refresh) {
    await runRuleHealthchecks(ruleId);
  }

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
  const rules = await mapWithConcurrency(result.rows, HEALTHCHECK_REPORT_RULE_CONCURRENCY, async (rule) => {
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

async function refreshFinalStatusesForHealthcheck(client: PoolClient, rules: Array<Pick<HealthcheckRuleRow, "portal_id">>) {
  const portalIds = new Set<number>();
  for (const rule of rules) {
    if (rule.portal_id) portalIds.add(rule.portal_id);
  }

  const errors = new Map<number, string | null>();
  for (const portalId of portalIds) {
    try {
      await refreshPortalFinalStatuses(client, portalId);
      errors.set(portalId, null);
    } catch (error) {
      errors.set(portalId, error instanceof Error ? error.message : "Erro ao atualizar status da listagem final.");
    }
  }
  return errors;
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
      input.preview_sort_direction === "desc" ? "desc" : "asc",
      input.crm_code ?? null
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
    const items = normalizeSummaryItems(input.items, columns);
    const selectionSql = buildRuleSelectSqlForSummary(
      sourceTable,
      filters,
      columns,
      input.include_locked ?? true,
      input.active ?? true,
      publicationPriority,
      limitSql,
      summarySelectionColumns(items, columns)
    );
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

export async function previewRuleQuery(input: RuleQueryPreviewInput) {
  if (isDataApiConfigured()) return previewRuleQueryViaApi(input);

  await ensureControlSchema();
  return withTransaction(async (client) => {
    const columns = await getBaseColumns(client);
    const filters = sanitizeFilters(input.filters ?? DEFAULT_FILTERS, columns);
    const publicationPriority = sanitizePublicationPriority(input.publication_priority ?? DEFAULT_PUBLICATION_PRIORITY, columns);
    const ruleId = normalizeOptionalPositiveInteger(input.id);
    const sourceTable = await validateSourceTable(client, input.source_table, ruleId ?? undefined);
    const sourceColumns = await listPublishSelectableColumns(client, sourceTable);
    const selectSql = buildRuleSelectSql(
      sourceTable,
      filters,
      columns,
      input.include_locked ?? true,
      input.active ?? true,
      undefined,
      publicationPriority,
      null,
      sourceColumns,
      true
    );
    const viewName = await resolvePreviewRuleViewName(client, input, ruleId);
    const viewSql = viewName
      ? buildViewSql(
          viewName,
          sourceTable,
          filters,
          columns,
          input.include_locked ?? true,
          input.active ?? true,
          publicationPriority,
          null,
          sourceColumns,
          true
        )
      : null;

    return { select_sql: selectSql, view_sql: viewSql, view_name: viewName };
  });
}

export async function previewPortalFinalRows(input: PortalFinalPreviewRowsInput) {
  const startedAt = Date.now();
  logRepository("info", "portal-final.rows.start", {
    mode: isDataApiConfigured() ? "data-api" : "direct-db",
    portalId: input.portal_id ?? null,
    limit: input.limit ?? null,
    refresh: Boolean(input.refresh),
    crmCode: normalizeCrmCodeFilter(input.crm_code) ? "[filtered]" : null
  });
  try {
    const result = isDataApiConfigured()
      ? await previewPortalFinalRowsViaApi(input)
      : await previewPortalFinalRowsDirect(input);
    logRepository("info", "portal-final.rows.ok", {
      portalId: input.portal_id ?? null,
      columnCount: result.columns.length,
      rowCount: result.rows.length,
      elapsedMs: Date.now() - startedAt
    });
    return result;
  } catch (error) {
    logRepository("error", "portal-final.rows.error", {
      portalId: input.portal_id ?? null,
      elapsedMs: Date.now() - startedAt,
      error
    });
    throw error;
  }
}

export async function previewPortalFinalSummary(input: PortalFinalSummaryInput): Promise<RuleSummaryResponse> {
  const startedAt = Date.now();
  logRepository("info", "portal-final.summary.start", {
    mode: isDataApiConfigured() ? "data-api" : "direct-db",
    portalId: input.portal_id ?? null,
    itemCount: input.items?.length ?? 0,
    refresh: Boolean(input.refresh),
    columns: input.items?.map((item) => item.column) ?? []
  });
  try {
    const result = isDataApiConfigured()
      ? await previewPortalFinalSummaryViaApi(input)
      : await previewPortalFinalSummaryDirect(input);
    logRepository("info", "portal-final.summary.ok", {
      portalId: input.portal_id ?? null,
      total: result.total,
      resultItems: result.items.length,
      elapsedMs: Date.now() - startedAt
    });
    return result;
  } catch (error) {
    logRepository("error", "portal-final.summary.error", {
      portalId: input.portal_id ?? null,
      elapsedMs: Date.now() - startedAt,
      error
    });
    throw error;
  }
}

export async function refreshPortalFinalListing(input: { portalId?: number | string | null } = {}) {
  const startedAt = Date.now();
  logRepository("info", "portal-final.listing-refresh.start", {
    mode: isDataApiConfigured() ? "data-api" : "direct-db",
    portalId: input.portalId ?? null
  });
  try {
    const result = isDataApiConfigured()
      ? await refreshPortalFinalListingsViaApi(input)
      : await refreshPortalFinalListingsDirect(input);
    logRepository("info", "portal-final.listing-refresh.ok", {
      portalId: input.portalId ?? null,
      refreshedCount: result.refreshed.length,
      elapsedMs: Date.now() - startedAt
    });
    return result;
  } catch (error) {
    logRepository("error", "portal-final.listing-refresh.error", {
      portalId: input.portalId ?? null,
      elapsedMs: Date.now() - startedAt,
      error
    });
    throw error;
  }
}

export async function refreshPortalFinalListings(input: { portalId?: number | string | null } = {}) {
  return refreshPortalFinalListing(input);
}

export async function refreshScheduledPortalFinalListings(now = new Date()) {
  const startedAt = Date.now();
  logRepository("info", "portal-final.scheduled-refresh.start", {
    mode: isDataApiConfigured() ? "data-api" : "direct-db"
  });
  try {
    const result = isDataApiConfigured()
      ? await refreshScheduledPortalFinalListingsViaApi(now)
      : await refreshScheduledPortalFinalListingsDirect(now);
    logRepository("info", "portal-final.scheduled-refresh.ok", {
      checkedCount: result.checked,
      dueCount: result.due,
      refreshedCount: result.refreshed.length,
      skipped: result.skipped,
      elapsedMs: Date.now() - startedAt
    });
    return result;
  } catch (error) {
    logRepository("error", "portal-final.scheduled-refresh.error", {
      elapsedMs: Date.now() - startedAt,
      error
    });
    throw error;
  }
}

async function previewPortalFinalRowsDirect(input: PortalFinalPreviewRowsInput) {
  await ensureControlSchema();
  return withTransaction(async (client) => {
    const portalId = normalizeRequiredPortalId(input.portal_id);
    const { viewName } = await ensurePortalFinalViewForRead(client, portalId);
    return queryPortalFinalRows(client, viewName, input);
  });
}

async function previewPortalFinalSummaryDirect(input: PortalFinalSummaryInput): Promise<RuleSummaryResponse> {
  await ensureControlSchema();
  return withTransaction(async (client) => {
    const portalId = normalizeRequiredPortalId(input.portal_id);
    const { viewName } = await ensurePortalFinalViewForRead(client, portalId);
    const baseColumns = await getBaseColumns(client);
    const columns = portalFinalSummaryColumnMetadata(baseColumns);
    const items = normalizeSummaryItems(input.items, columns);
    const selectionSql = buildPortalFinalSummarySelectionSql(viewName, summarySelectionColumns(items, columns), columns);

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

async function refreshPortalFinalListingsDirect(input: { portalId?: number | string | null } = {}) {
  await ensureControlSchema();
  return withTransaction(async (client) => {
    await acquirePublishRefreshLock(client);
    const portalId = normalizeOptionalPositiveInteger(input.portalId);
    const portalIds = portalId ? [portalId] : await listRefreshablePortalIds(client);
    const refreshed: Array<{ portal_id: number; view_name: string }> = [];

    for (const currentPortalId of portalIds) {
      const result = await refreshPortalFinalView(client, currentPortalId, "manual");
      if (result) refreshed.push({ portal_id: currentPortalId, view_name: result.viewName });
    }

    invalidateHealthcheckReportCache();
    return { refreshed };
  });
}

type ScheduledPortalRow = Pick<Portal, "id" | "slug" | "final_listing_refresh_time" | "final_view_refreshed_at">;

async function refreshScheduledPortalFinalListingsDirect(now: Date) {
  await ensureControlSchema();
  return withTransaction(async (client) => {
    const lockAcquired = await tryAcquirePublishRefreshLock(client);
    if (!lockAcquired) {
      return { refreshed: [], checked: 0, due: 0, skipped: true, reason: "refresh-lock" };
    }

    const result = await client.query<ScheduledPortalRow>(
      `
        select id,
               slug,
               final_listing_refresh_time::text as final_listing_refresh_time,
               final_view_refreshed_at
        from publish_portals
        where active = true
        order by name asc, id asc
      `
    );
    const portalIds = result.rows.filter((portal) => shouldRunScheduledPortalRefresh(portal, now)).map((portal) => portal.id);
    const refreshed: Array<{ portal_id: number; view_name: string }> = [];

    for (const portalId of portalIds) {
      const refreshResult = await refreshPortalFinalView(client, portalId, "scheduled");
      if (refreshResult) refreshed.push({ portal_id: portalId, view_name: refreshResult.viewName });
    }

    invalidateHealthcheckReportCache();
    return { refreshed, checked: result.rows.length, due: portalIds.length, skipped: false };
  });
}

function buildRuleSelectSqlForSummary(
  sourceTable: string,
  filters: RuleFilters,
  columns: ColumnMetadata[],
  includeLocked: boolean,
  active: boolean,
  publicationPriority: PublicationPriority,
  limitSql?: string | null,
  selectColumns?: string[]
) {
  return buildRuleSelectSql(
    sourceTable,
    filters,
    columns,
    includeLocked,
    active,
    undefined,
    limitSql ? publicationPriority : DEFAULT_PUBLICATION_PRIORITY,
    limitSql,
    selectColumns
  );
}

async function materializeRuleSummarySelection(client: PoolClient, selectionSql: string) {
  await client.query("drop table if exists pg_temp.rule_summary_selection");
  await client.query(`create temporary table rule_summary_selection on commit drop as ${selectionSql}`);
  return "select * from rule_summary_selection";
}

function logRepository(level: "info" | "error", event: string, details: Record<string, unknown>) {
  const logger = level === "error" ? console.error : console.info;
  logger(`[publish-engine] repository.${event}`, details);
}

async function acquirePublishRefreshLock(client: PoolClient) {
  await client.query("select pg_advisory_xact_lock($1::integer, $2::integer)", [
    PUBLISH_REFRESH_LOCK_NAMESPACE,
    PUBLISH_REFRESH_LOCK_KEY
  ]);
}

async function tryAcquirePublishRefreshLock(client: PoolClient) {
  const result = await client.query<{ locked: boolean }>(
    "select pg_try_advisory_xact_lock($1::integer, $2::integer) as locked",
    [PUBLISH_REFRESH_LOCK_NAMESPACE, PUBLISH_REFRESH_LOCK_KEY]
  );
  return result.rows[0]?.locked ?? false;
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

function summarySelectionColumns(items: NormalizedRuleSummaryItem[], columns: ColumnMetadata[]) {
  const selected = new Set<string>();
  for (const item of items) selected.add(item.column);

  if (!selected.size) {
    const fallbackColumn =
      summaryBaseColumn(columns, "id_interno") ??
      summaryBaseColumn(columns, "codigo_crm") ??
      columns.find((column) => !Array.isArray(column.json_path) || !column.json_path.length);
    if (fallbackColumn) selected.add(fallbackColumn.column_name);
  }

  return [...selected];
}

function summaryBaseColumn(columns: ColumnMetadata[], columnName: string) {
  return columns.find(
    (column) =>
      column.column_name === columnName &&
      (!Array.isArray(column.json_path) || !column.json_path.length)
  );
}

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
    dataApiRequest<PortalAdType[]>("/publish_portal_ad_types?order=quantity.desc,tier.asc,id.asc")
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

async function listAutomationsViaApi() {
  return dataApiRequest<PublishAutomation[]>("/publish_automations?deleted_at=is.null&order=name.asc,key.asc");
}

async function updateAutomationActiveViaApi(key: string, active: boolean) {
  const updated = await dataApiRequest<PublishAutomation[]>(
    `/publish_automations?key=eq.${encodeURIComponent(key)}&deleted_at=is.null`,
    {
      method: "PATCH",
      prefer: "return=representation",
      body: {
        active,
        updated_at: new Date().toISOString()
      }
    }
  );
  if (!updated[0]) return null;

  if (active) {
    await dataApiRpc("publish_apply_automation", { target_key: key });
  }

  const refreshed = await dataApiRequest<PublishAutomation[]>(
    `/publish_automations?key=eq.${encodeURIComponent(key)}&deleted_at=is.null&limit=1`
  );
  return refreshed[0] ?? null;
}

async function deleteAutomationViaApi(key: string) {
  const updated = await dataApiRequest<PublishAutomation[]>(
    `/publish_automations?key=eq.${encodeURIComponent(key)}&deleted_at=is.null`,
    {
      method: "PATCH",
      prefer: "return=representation",
      body: {
        active: false,
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    }
  );
  return updated[0] ?? null;
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
      active: input.active ?? true,
      final_listing_refresh_time: normalizePortalRefreshTime(input.final_listing_refresh_time)
    }
  });
  await replacePortalAdTypesViaApi(rows[0].id, input.ad_types ?? []);
  const portal = await getPortalByIdViaApi(rows[0].id);
  invalidateHealthcheckReportCache();
  return portal;
}

async function updatePortalViaApi(id: number, input: PortalInput) {
  const slug = normalizePortalSlug(input.slug, input.name);
  const [currentPortal, currentAdTypes] = await Promise.all([
    dataApiRequest<Array<Pick<Portal, "slug">>>(`/publish_portals?id=eq.${id}&select=slug&limit=1`),
    dataApiRequest<PortalAdType[]>(`/publish_portal_ad_types?portal_id=eq.${id}&order=quantity.desc,tier.asc,id.asc`)
  ]);
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
      final_listing_refresh_time: normalizePortalRefreshTime(input.final_listing_refresh_time),
      updated_at: new Date().toISOString()
    }
  });
  if (!rows[0]) return null;
  if (currentPortal[0]?.slug && currentPortal[0].slug !== slug) {
    await dropPortalFinalViewViaApi(currentPortal[0].slug);
  }
  await replacePortalAdTypesViaApi(id, input.ad_types ?? []);
  if (adTypesChanged) {
    await refreshRuleViewsForPortalViaApi(id);
  }
  const portal = await getPortalByIdViaApi(id);
  invalidateHealthcheckReportCache();
  return portal;
}

async function deletePortalViaApi(id: number) {
  const portal = await dataApiRequest<Array<Pick<Portal, "slug">>>(`/publish_portals?id=eq.${id}&select=slug&limit=1`);
  if (portal[0]?.slug) await dropPortalFinalViewViaApi(portal[0].slug);
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
  const previousPortalId = existing[0].portal_id;
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
  if (refresh) {
    await runRuleHealthchecksViaApi(ruleId);
    dataApiHealthcheckReportCache = null;
  }

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
    preview_sort_direction: input.preview_sort_direction === "desc" ? "desc" : "asc",
    crm_code: normalizeCrmCodeFilter(input.crm_code)
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

async function previewRuleQueryViaApi(input: RuleQueryPreviewInput) {
  const columns = await listBaseColumnsViaApi();
  const filters = sanitizeFilters(input.filters ?? DEFAULT_FILTERS, columns);
  const publicationPriority = sanitizePublicationPriority(input.publication_priority ?? DEFAULT_PUBLICATION_PRIORITY, columns);
  const ruleId = normalizeOptionalPositiveInteger(input.id);
  const sourceTable = await validateSourceTableViaApi(input.source_table, ruleId ?? undefined);
  const selectSql = buildRuleSelectSql(
    sourceTable,
    filters,
    columns,
    input.include_locked ?? true,
    input.active ?? true,
    undefined,
    publicationPriority,
    null,
    undefined,
    true
  );
  const viewName = await resolvePreviewRuleViewNameViaApi(input, ruleId);
  const viewSql = viewName
    ? buildViewSql(
        viewName,
        sourceTable,
        filters,
        columns,
        input.include_locked ?? true,
        input.active ?? true,
        publicationPriority,
        null,
        undefined,
        true
      )
    : null;

  return { select_sql: selectSql, view_sql: viewSql, view_name: viewName };
}

async function previewPortalFinalRowsViaApi(input: PortalFinalPreviewRowsInput) {
  const portalId = normalizeRequiredPortalId(input.portal_id);
  const portal = await ensurePortalFinalViewForReadViaApi(portalId);
  const viewName = portalFinalViewName(portal.slug);
  const previewLimit = input.limit === 100 ? 100 : 10;
  const sortDirection = input.preview_sort_direction === "desc" ? "desc" : "asc";
  const sortColumn = FINAL_VIEW_PREVIEW_COLUMNS.find((column) => column.key === input.preview_sort_column);
  const order = sortColumn
    ? `${sortColumn.key}.${sortDirection}.nullslast,${FINAL_VIEW_PUBLICATION_RANK_COLUMN}.asc.nullslast,${FINAL_VIEW_TIER_COLUMN}.desc.nullslast,codigo_crm.asc`
    : `${FINAL_VIEW_PUBLICATION_RANK_COLUMN}.asc.nullslast,${FINAL_VIEW_TIER_COLUMN}.desc.nullslast,codigo_crm.asc`;
  const crmCode = normalizeCrmCodeFilter(input.crm_code);
  const crmFilter = crmCode ? `&codigo_crm=ilike.*${encodeURIComponent(escapePostgrestLikeValue(crmCode))}*` : "";
  const columns = FINAL_VIEW_PREVIEW_COLUMNS.map((column) => column.key).join(",");
  const rows = await dataApiRequest<Array<Record<string, unknown>>>(
    `/${encodeURIComponent(viewName)}?select=${columns}&order=${encodeURIComponent(order)}&limit=${previewLimit}${crmFilter}`
  );

  return {
    columns: FINAL_VIEW_PREVIEW_COLUMNS.map((column) => ({ key: column.key, label: column.label })),
    rows
  };
}

async function previewPortalFinalSummaryViaApi(input: PortalFinalSummaryInput): Promise<RuleSummaryResponse> {
  const portalId = normalizeRequiredPortalId(input.portal_id);
  await ensurePortalFinalViewForReadViaApi(portalId);
  return dataApiRpc<RuleSummaryResponse>("preview_publish_portal_final_summary", {
    portal_id: portalId,
    items: Array.isArray(input.items) ? input.items : []
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

async function getAutomationByKey(client: PoolClient, key: string) {
  const result = await client.query<PublishAutomation>(
    `
      select *
      from publish_automations
      where key = $1
        and deleted_at is null
      limit 1
    `,
    [key]
  );
  return result.rows[0] ?? null;
}

async function listPortalAdTypes(client: PoolClient, portalId: number) {
  const result = await client.query<PortalAdType>(
    "select id, portal_id, name, slug, quantity, tier, created_at, updated_at from publish_portal_ad_types where portal_id = $1 order by quantity desc, tier asc, id asc",
    [portalId]
  );
  return result.rows;
}

function portalAdTypesSignature(adTypes: PortalAdTypeInput[] | PortalAdType[]) {
  return JSON.stringify(sanitizeAdTypes(adTypes).sort((left, right) => left.slug.localeCompare(right.slug, "pt-BR")));
}

async function refreshRuleViewsForPortal(client: PoolClient, portalId: number) {
  const rules = await listRefreshableRules(client);
  const seedIds = rules.filter((rule) => rule.portal_id === portalId).map((rule) => rule.id);
  const affectedPortalIds = await refreshRuleViewsBySeedIds(client, seedIds, rules);
  affectedPortalIds.add(portalId);
  return affectedPortalIds;
}

async function refreshDependentRuleViews(client: PoolClient, sourceViewName: string | null, ignoredIds = new Set<number>()) {
  if (!sourceViewName) return new Set<number>();
  const rules = await listRefreshableRules(client);
  const seedIds = rules
    .filter((rule) => rule.source_table === sourceViewName && !ignoredIds.has(rule.id))
    .map((rule) => rule.id);
  return refreshRuleViewsBySeedIds(client, seedIds, rules);
}

async function listRefreshableRules(client: PoolClient) {
  const result = await client.query<PublicationRule>("select * from publish_rules order by id asc");
  return result.rows;
}

async function refreshRuleViewsBySeedIds(client: PoolClient, seedIds: number[], rules: PublicationRule[]) {
  const affectedPortalIds = new Set<number>();
  if (!seedIds.length) return affectedPortalIds;

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
      if (refreshed.portal_id) affectedPortalIds.add(refreshed.portal_id);
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
        if (refreshed.portal_id) affectedPortalIds.add(refreshed.portal_id);
      }
    }
  }

  return affectedPortalIds;
}

async function refreshRuleViewsForPortalViaApi(portalId: number) {
  const rules = await dataApiRequest<PublicationRule[]>("/publish_rules?order=id.asc");
  const seedIds = rules.filter((rule) => rule.portal_id === portalId).map((rule) => rule.id);
  const affectedPortalIds = await refreshRuleViewsBySeedIdsViaApi(seedIds, rules);
  affectedPortalIds.add(portalId);
  return affectedPortalIds;
}

async function refreshDependentRuleViewsViaApi(sourceViewName: string | null, ignoredIds = new Set<number>()) {
  if (!sourceViewName) return new Set<number>();
  const rules = await dataApiRequest<PublicationRule[]>("/publish_rules?order=id.asc");
  const seedIds = rules
    .filter((rule) => rule.source_table === sourceViewName && !ignoredIds.has(rule.id))
    .map((rule) => rule.id);
  return refreshRuleViewsBySeedIdsViaApi(seedIds, rules);
}

async function refreshRuleViewsBySeedIdsViaApi(seedIds: number[], rules: PublicationRule[]) {
  const affectedPortalIds = new Set<number>();
  if (!seedIds.length) return affectedPortalIds;

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
        if (refreshedRule.portal_id) affectedPortalIds.add(refreshedRule.portal_id);
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
          if (refreshedRule.portal_id) affectedPortalIds.add(refreshedRule.portal_id);
        }
      }
    }
  }

  return affectedPortalIds;
}

async function refreshPortalFinalViewViaApi(portalId: number) {
  await dataApiRpc<{ view_name: string }[]>("refresh_publish_portal_final_listing", {
    target_portal_id: portalId,
    refresh_reason: "manual"
  });
}

async function refreshPortalFinalListingsViaApi(input: { portalId?: number | string | null } = {}) {
  const portalId = normalizeOptionalPositiveInteger(input.portalId);
  const portalIds = portalId
    ? [portalId]
    : (await dataApiRequest<Array<Pick<Portal, "id">>>("/publish_portals?select=id&order=name.asc,id.asc")).map((portal) => portal.id);
  const refreshed: Array<{ portal_id: number; view_name: string }> = [];

  for (const currentPortalId of portalIds) {
    const result = await dataApiRpc<Array<{ view_name: string }>>("refresh_publish_portal_final_listing", {
      target_portal_id: currentPortalId,
      refresh_reason: "manual"
    });
    if (result[0]?.view_name) refreshed.push({ portal_id: currentPortalId, view_name: result[0].view_name });
  }

  invalidateHealthcheckReportCache();
  return { refreshed };
}

async function refreshScheduledPortalFinalListingsViaApi(now: Date) {
  const portals = await dataApiRequest<ScheduledPortalRow[]>(
    "/publish_portals?active=eq.true&select=id,slug,final_listing_refresh_time,final_view_refreshed_at&order=name.asc,id.asc"
  );
  const duePortals = portals.filter((portal) => shouldRunScheduledPortalRefresh(portal, now));
  const refreshed: Array<{ portal_id: number; view_name: string }> = [];

  for (const portal of duePortals) {
    const result = await dataApiRpc<Array<{ view_name: string }>>("refresh_publish_portal_final_listing", {
      target_portal_id: portal.id,
      refresh_reason: "scheduled"
    });
    if (result[0]?.view_name) refreshed.push({ portal_id: portal.id, view_name: result[0].view_name });
  }

  invalidateHealthcheckReportCache();
  return { refreshed, checked: portals.length, due: duePortals.length, skipped: false };
}

async function ensurePortalFinalViewForReadViaApi(portalId: number) {
  const portals = await dataApiRequest<Array<Pick<Portal, "id" | "slug" | "final_view_refreshed_at">>>(
    `/publish_portals?id=eq.${portalId}&select=id,slug,final_view_refreshed_at&limit=1`
  );
  const portal = portals[0];
  if (!portal?.slug) throw new Error("Portal nao encontrado.");

  const viewName = portalFinalViewName(portal.slug);
  try {
    await dataApiRequest(`/${encodeURIComponent(viewName)}?select=codigo_crm&limit=0`);
  } catch {
    throw new Error("Listagem final ainda nao existe. Use Atualizar listagem para gerar a listagem completa.");
  }
  return portal;
}

async function dropPortalFinalViewViaApi(portalSlug: string) {
  await dataApiRpc<{ ok: boolean }[]>("drop_publish_portal_final_view", { portal_slug: portalSlug });
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

async function resolvePreviewRuleViewName(
  client: PoolClient,
  input: RuleQueryPreviewInput,
  ruleId: number | null
) {
  const providedViewName = input.view_name?.trim();
  if (providedViewName) {
    assertRuleViewName(providedViewName);
    return providedViewName;
  }
  if (!ruleId) return null;

  const result = await client.query<Pick<PublicationRule, "view_name">>(
    "select view_name from publish_rules where id = $1",
    [ruleId]
  );
  const viewName = result.rows[0]?.view_name?.trim();
  if (!viewName) return null;
  assertRuleViewName(viewName);
  return viewName;
}

async function resolvePreviewRuleViewNameViaApi(input: RuleQueryPreviewInput, ruleId: number | null) {
  const providedViewName = input.view_name?.trim();
  if (providedViewName) {
    assertRuleViewName(providedViewName);
    return providedViewName;
  }
  if (!ruleId) return null;

  const result = await dataApiRequest<Array<Pick<PublicationRule, "view_name">>>(
    `/publish_rules?id=eq.${ruleId}&select=view_name&limit=1`
  );
  const viewName = result[0]?.view_name?.trim();
  if (!viewName) return null;
  assertRuleViewName(viewName);
  return viewName;
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

function normalizePortalRefreshTime(value: string | null | undefined) {
  const normalized = value?.trim() || "00:00";
  const match = normalized.match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (!match) throw new Error("Horario de atualização da listagem invalido.");
  return `${match[1]}:${match[2]}`;
}

function shouldRunScheduledPortalRefresh(portal: ScheduledPortalRow, now: Date) {
  const currentLocal = saoPauloDateTimeParts(now);
  const scheduledMinutes = timeToMinutes(portal.final_listing_refresh_time);
  const currentMinutes = timeToMinutes(`${currentLocal.hour}:${currentLocal.minute}`);
  if (currentMinutes < scheduledMinutes) return false;

  const refreshedAt = portal.final_view_refreshed_at ? new Date(portal.final_view_refreshed_at) : null;
  if (!refreshedAt || Number.isNaN(refreshedAt.getTime())) return true;

  const refreshedLocal = saoPauloDateTimeParts(refreshedAt);
  const refreshedDate = `${refreshedLocal.year}-${refreshedLocal.month}-${refreshedLocal.day}`;
  const currentDate = `${currentLocal.year}-${currentLocal.month}-${currentLocal.day}`;
  if (refreshedDate !== currentDate) return true;

  return timeToMinutes(`${refreshedLocal.hour}:${refreshedLocal.minute}`) < scheduledMinutes;
}

function saoPauloDateTimeParts(value: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(value);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: lookup.get("year") ?? "1970",
    month: lookup.get("month") ?? "01",
    day: lookup.get("day") ?? "01",
    hour: lookup.get("hour") ?? "00",
    minute: lookup.get("minute") ?? "00"
  };
}

function timeToMinutes(value: string) {
  const normalized = normalizePortalRefreshTime(value);
  const [hour, minute] = normalized.split(":").map(Number);
  return hour * 60 + minute;
}

function normalizeAdLimitType(adLimitType?: string | null) {
  const normalized = normalizeAdTypeSlug(adLimitType || "total");
  return normalized || "total";
}

function adLimitTypeSlug(adLimitType: string) {
  return normalizeAdTypeSlug(adLimitType);
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
      "select exists (select 1 from publish_portal_ad_types where portal_id = $1 and slug = $2) as exists",
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
      `/publish_portal_ad_types?portal_id=eq.${portalId}&slug=eq.${encodeURIComponent(normalizedType)}&select=id&limit=1`
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

function sanitizeAdTypes(adTypes: Array<PortalAdTypeInput | PortalAdType>) {
  const normalized = new Map<string, { name: string; slug: string; quantity: number; tier: number }>();
  for (const [index, adType] of adTypes.entries()) {
    const name = normalizeAdTypeName(adType.name);
    if (!name.trim()) continue;
    const slug = normalizeAdTypeSlug(name);

    const quantity = Math.max(0, Math.trunc(Number(adType.quantity) || 0));
    const tier = normalizeAdTypeTier(adType.tier ?? index + 1);
    const current = normalized.get(slug);
    normalized.set(slug, {
      name: current?.name ?? name,
      slug,
      quantity: (current?.quantity ?? 0) + quantity,
      tier: current?.tier ?? tier
    });
  }

  const cleanAdTypes = [...normalized.values()];
  if (cleanAdTypes.length > 10) throw new Error("Um portal pode ter no maximo 10 tipos de anuncio.");

  const tiers = new Set<number>();
  for (const adType of cleanAdTypes) {
    if (tiers.has(adType.tier)) throw new Error("Nao e permitido repetir o mesmo tier de anuncio para o mesmo portal.");
    tiers.add(adType.tier);
  }

  return cleanAdTypes.sort(comparePortalAdTypesByQuantity);
}

function normalizeAdTypeName(name: string) {
  return name.normalize("NFC");
}

function normalizeAdTypeSlug(name: string) {
  return slugify(normalizeAdTypeName(name).replace(/\s+/g, " ").trim());
}

function normalizeAdTypeTier(value?: number | string | null) {
  const tier = Number(value);
  if (!Number.isInteger(tier) || tier < 1 || tier > 10) {
    throw new Error("Tier do anuncio deve ser um numero de 1 a 10.");
  }
  return tier;
}

function comparePortalAdTypesByQuantity<T extends Pick<PortalAdType, "name" | "quantity" | "tier">>(left: T, right: T) {
  const quantityDelta = (Number(right.quantity) || 0) - (Number(left.quantity) || 0);
  if (quantityDelta !== 0) return quantityDelta;
  const tierDelta = (Number(left.tier) || 0) - (Number(right.tier) || 0);
  if (tierDelta !== 0) return tierDelta;
  return left.name.localeCompare(right.name, "pt-BR");
}

async function replacePortalAdTypes(client: PoolClient, portalId: number, adTypes: PortalAdTypeInput[]) {
  await client.query("delete from publish_portal_ad_types where portal_id = $1", [portalId]);
  for (const adType of sanitizeAdTypes(adTypes)) {
    await client.query(
      `
        insert into publish_portal_ad_types (portal_id, name, slug, quantity, tier)
        values ($1, $2, $3, $4, $5)
      `,
      [portalId, adType.name, adType.slug, adType.quantity, adType.tier]
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
              'slug', a.slug,
              'quantity', a.quantity,
              'tier', a.tier,
              'created_at', a.created_at,
              'updated_at', a.updated_at
            )
            order by a.quantity desc, a.tier asc, a.id asc
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
      slug: adType.slug,
      quantity: adType.quantity,
      tier: adType.tier
    }))
  });
}

async function getPortalByIdViaApi(portalId: number) {
  const [portals, rules, adTypes] = await Promise.all([
    dataApiRequest<Portal[]>(`/publish_portals?id=eq.${portalId}&limit=1`),
    dataApiRequest<Array<{ id: number; portal_id: number }>>(`/publish_rules?portal_id=eq.${portalId}&select=id,portal_id`),
    dataApiRequest<PortalAdType[]>(`/publish_portal_ad_types?portal_id=eq.${portalId}&order=quantity.desc,tier.asc,id.asc`)
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
  for (const [portalId, portalAdTypes] of result) {
    result.set(portalId, portalAdTypes.sort(comparePortalAdTypesByQuantity));
  }
  return result;
}

function sumPortalQuota(adTypes: PortalAdType[]) {
  return adTypes.reduce((total, adType) => total + (Number(adType.quantity) || 0), 0);
}

type PortalFinalCandidateRule = {
  rule_id: number;
  view_name: string;
  candidate_ad_type_slug: string | null;
  candidate_tier: number | null;
  has_rule_index?: boolean;
};

type PortalFinalAdType = {
  ad_type_name: string;
  ad_type_slug: string;
  tier: number;
  quantity: number;
};

type PortalFinalReadPortal = Pick<Portal, "id" | "slug"> & {
  final_view_refreshed_at: string | Date | null;
};

async function listRefreshablePortalIds(client: PoolClient) {
  const result = await client.query<{ id: number }>("select id from publish_portals order by name asc, id asc");
  return result.rows.map((row) => row.id);
}

async function ensurePortalFinalViewForRead(
  client: PoolClient,
  portalId: number
) {
  const portal = await client.query<PortalFinalReadPortal>(
    "select id, slug, final_view_refreshed_at from publish_portals where id = $1",
    [portalId]
  );
  const portalRow = portal.rows[0];
  if (!portalRow?.slug) throw new Error("Portal nao encontrado.");

  const viewName = portalFinalViewName(portalRow.slug);
  const relationKind = await portalFinalRelationKind(client, viewName);
  if (!relationKind) {
    throw new Error("Listagem final ainda nao existe. Use Atualizar listagem para gerar a listagem completa.");
  }

  return { portal: portalRow, viewName };
}

async function portalFinalRelationKind(client: PoolClient, viewName: string) {
  const result = await client.query<{ relkind: string }>(
    `
      select c.relkind
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'v', 'm')
        and c.relname = $1
      limit 1
    `,
    [viewName]
  );
  return result.rows[0]?.relkind ?? null;
}

async function portalFinalRelationExists(client: PoolClient, viewName: string) {
  return Boolean(await portalFinalRelationKind(client, viewName));
}

async function refreshPortalFinalStatuses(client: PoolClient, portalId: number) {
  await acquirePublishRefreshLock(client);
  const portal = await client.query<Pick<Portal, "slug">>("select slug from publish_portals where id = $1", [portalId]);
  const portalSlug = portal.rows[0]?.slug;
  if (!portalSlug) throw new Error("Portal nao encontrado.");

  const viewName = portalFinalViewName(portalSlug);
  const relationKind = await portalFinalRelationKind(client, viewName);
  if (!relationKind) {
    throw new Error("Listagem final ainda nao existe. Use Atualizar listagem para gerar a listagem completa.");
  }
  if (relationKind !== "r") {
    throw new Error("Listagem final precisa ser atualizada completamente antes da atualização de status.");
  }

  const columns = await listRelationColumns(client, viewName);
  const missingColumns = [
    "codigo_crm",
    FINAL_VIEW_AD_TYPE_SLUG_COLUMN,
    FINAL_VIEW_STATUS_COLUMN,
    FINAL_VIEW_CURRENT_PUBLICATION_COLUMN
  ].filter((column) => !columns.includes(column));
  if (missingColumns.length) {
    throw new Error(`Listagem final sem ${missingColumns.join(", ")}.`);
  }

  const result = await client.query(
    `
      update public.${quoteIdentifier(viewName)} final
      set ${quoteIdentifier(FINAL_VIEW_CURRENT_PUBLICATION_COLUMN)} = b.${quoteIdentifier("publicacao_portais")}::jsonb,
          ${quoteIdentifier(FINAL_VIEW_STATUS_COLUMN)} = case
            when ${portalPublishedFromSql(`b.${quoteIdentifier("publicacao_portais")}::jsonb`, portalSlug)}
             and ${portalPublicationTypeSlugFromSql(`b.${quoteIdentifier("publicacao_portais")}::jsonb`, portalSlug)} = final.${quoteIdentifier(FINAL_VIEW_AD_TYPE_SLUG_COLUMN)}
            then ${quoteLiteral(FINAL_VIEW_PUBLISHED_STATUS)}::text
            else ${quoteLiteral(FINAL_VIEW_PENDING_STATUS)}::text
          end
      from public.base_imoveis b
      where b.${quoteIdentifier("codigo_crm")} = final.${quoteIdentifier("codigo_crm")}
    `
  );
  return { portal_id: portalId, view_name: viewName, updated_count: result.rowCount ?? 0 };
}

async function queryPortalFinalRows(
  client: PoolClient,
  viewName: string,
  input: PortalFinalPreviewRowsInput
) {
  const previewLimit = input.limit === 100 ? 100 : 10;
  const sortDirection = input.preview_sort_direction === "desc" ? "desc" : "asc";
  const sortColumn = FINAL_VIEW_PREVIEW_COLUMNS.find((column) => column.key === input.preview_sort_column);
  const defaultOrderSql = [
    `b.${quoteIdentifier(FINAL_VIEW_PUBLICATION_RANK_COLUMN)} asc nulls last`,
    `b.${quoteIdentifier(FINAL_VIEW_TIER_COLUMN)} desc nulls last`,
    `b.${quoteIdentifier("codigo_crm")} asc`
  ].join(", ");
  const orderSql = sortColumn
    ? `b.${quoteIdentifier(sortColumn.key)} ${sortDirection} nulls last, ${defaultOrderSql}`
    : defaultOrderSql;
  const selectSql = FINAL_VIEW_PREVIEW_COLUMNS
    .map((column) => `b.${quoteIdentifier(column.key)} as ${quoteIdentifier(column.key)}`)
    .join(", ");
  const params: unknown[] = [];
  const crmCode = normalizeCrmCodeFilter(input.crm_code);
  const whereSql = crmCode
    ? `where strpos(lower(b.${quoteIdentifier("codigo_crm")}::text), lower($1::text)) > 0`
    : "";
  if (crmCode) params.push(crmCode);

  const result = await client.query<Record<string, unknown>>(
    `
      select ${selectSql}
      from public.${quoteIdentifier(viewName)} b
      ${whereSql}
      order by ${orderSql}
      limit ${previewLimit}
    `,
    params
  );

  return {
    columns: FINAL_VIEW_PREVIEW_COLUMNS.map((column) => ({ key: column.key, label: column.label })),
    rows: result.rows
  };
}

function portalFinalSummaryColumnMetadata(baseColumns: ColumnMetadata[] = []): ColumnMetadata[] {
  const columns: Array<Pick<ColumnMetadata, "column_name" | "data_type" | "udt_name" | "display_name">> = [
    { column_name: "codigo_crm", data_type: "text", udt_name: "text", display_name: "Codigo CRM" },
    { column_name: FINAL_VIEW_STATUS_COLUMN, data_type: "text", udt_name: "text", display_name: "Status" },
    { column_name: FINAL_VIEW_AD_TYPE_NAME_COLUMN, data_type: "text", udt_name: "text", display_name: "Tipo de anuncio" },
    { column_name: FINAL_VIEW_AD_TYPE_SLUG_COLUMN, data_type: "text", udt_name: "text", display_name: "Slug do tipo" },
    { column_name: FINAL_VIEW_TIER_COLUMN, data_type: "integer", udt_name: "int4", display_name: "Tier" },
    { column_name: FINAL_VIEW_PUBLICATION_RANK_COLUMN, data_type: "integer", udt_name: "int4", display_name: "Ordem" },
    { column_name: FINAL_VIEW_CURRENT_PUBLICATION_COLUMN, data_type: "jsonb", udt_name: "jsonb", display_name: "Publicacao atual" }
  ];

  return [
    ...columns.map((column) => ({
      ...column,
      column_name: portalFinalSummaryColumnKey("final", column.column_name),
      display_name: `Listagem final / ${column.display_name ?? column.column_name}`,
      is_nullable: "YES" as const,
      filter_kind: getFilterKind(column.data_type),
      json_path: null
    })),
    ...baseColumns
      .filter((column) => column.filter_kind !== "other")
      .map((column) => ({
        ...column,
        column_name: portalFinalSummaryColumnKey("base", column.column_name),
        display_name: `Base / ${column.display_name ?? column.column_name}`
      }))
  ];
}

function buildPortalFinalSummarySelectionSql(viewName: string, selectedColumns: string[], columns: ColumnMetadata[]) {
  const columnLookup = new Map(columns.map((column) => [column.column_name, column]));
  const columnsToSelect = selectedColumns.length
    ? selectedColumns
    : [portalFinalSummaryColumnKey("final", "codigo_crm")];
  const selectParts: string[] = [];
  const seen = new Set<string>();

  for (const columnName of columnsToSelect) {
    const column = columnLookup.get(columnName);
    if (!column || seen.has(column.column_name)) continue;

    const source = portalFinalSummaryColumnSource(column.column_name);
    if (!source) continue;

    const actualColumn = portalFinalSummaryActualColumnName(column.column_name, source);
    const alias = source === "final" ? "final_listing" : "base";
    selectParts.push(`${quoteIdentifier(alias)}.${quoteIdentifier(actualColumn)} as ${quoteIdentifier(column.column_name)}`);
    seen.add(column.column_name);
  }

  if (!selectParts.length) {
    selectParts.push(
      `${quoteIdentifier("final_listing")}.${quoteIdentifier("codigo_crm")} as ${quoteIdentifier(portalFinalSummaryColumnKey("final", "codigo_crm"))}`
    );
  }

  return `select ${selectParts.join(", ")}
from public.${quoteIdentifier(viewName)} ${quoteIdentifier("final_listing")}
left join public.base_imoveis ${quoteIdentifier("base")}
  on ${quoteIdentifier("base")}.${quoteIdentifier("codigo_crm")} = ${quoteIdentifier("final_listing")}.${quoteIdentifier("codigo_crm")}`;
}

function portalFinalSummaryColumnKey(source: "final" | "base", columnName: string) {
  return `${source === "final" ? FINAL_SUMMARY_COLUMN_PREFIX : BASE_SUMMARY_COLUMN_PREFIX}${columnName}`;
}

function portalFinalSummaryColumnSource(columnName: string): "final" | "base" | null {
  if (columnName.startsWith(FINAL_SUMMARY_COLUMN_PREFIX)) return "final";
  if (columnName.startsWith(BASE_SUMMARY_COLUMN_PREFIX)) return "base";
  return null;
}

function portalFinalSummaryActualColumnName(columnName: string, source: "final" | "base") {
  const prefix = source === "final" ? FINAL_SUMMARY_COLUMN_PREFIX : BASE_SUMMARY_COLUMN_PREFIX;
  return columnName.slice(prefix.length);
}

function normalizeCrmCodeFilter(value: unknown) {
  if (value == null) return "";
  return String(value).trim();
}

function escapePostgrestLikeValue(value: string) {
  return value.replace(/([%_*])/g, "\\$1");
}

function normalizeRequiredPortalId(value?: number | string | null) {
  const portalId = normalizeOptionalPositiveInteger(value);
  if (!portalId) throw new Error("Portal invalido.");
  return portalId;
}

function portalFinalViewName(portalSlug: string) {
  const viewName = `pc_${portalSlug}_final`;
  if (!/^pc_[a-z0-9_]+_final$/.test(viewName) || viewName.length > 63) {
    throw new Error(`Nome de listagem final invalido: ${viewName}`);
  }
  return viewName;
}

async function dropPortalFinalViewBySlug(client: PoolClient, portalSlug: string) {
  if (!portalSlug) return;
  await dropPortalFinalRelation(client, portalFinalViewName(portalSlug));
}

async function dropPortalFinalRelation(client: PoolClient, relationName: string) {
  const relation = await client.query<{ relkind: string }>(
    `
      select c.relkind
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = $1
        and c.relkind in ('r', 'v', 'm')
      limit 1
    `,
    [relationName]
  );
  const relkind = relation.rows[0]?.relkind;
  if (relkind === "m") {
    await client.query(`drop materialized view if exists public.${quoteIdentifier(relationName)}`);
  } else if (relkind === "v") {
    await client.query(`drop view if exists public.${quoteIdentifier(relationName)}`);
  } else if (relkind === "r") {
    await client.query(`drop table if exists public.${quoteIdentifier(relationName)}`);
  }
}

async function listRelationColumns(client: PoolClient, relationName: string) {
  const result = await client.query<{ column_name: string }>(
    `
      select a.attname as column_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
      where n.nspname = 'public'
        and c.relkind in ('r', 'v', 'm')
        and c.relname = $1
        and a.attnum > 0
        and not a.attisdropped
      order by a.attnum
    `,
    [relationName]
  );
  return result.rows.map((row) => row.column_name);
}

async function listPublishSelectableColumns(client: PoolClient, relationName: string) {
  const columns = await listRelationColumns(client, relationName);
  const selectable = columns.filter((column) => !FINAL_VIEW_RESERVED_COLUMNS.has(column));
  if (!selectable.length) throw new Error(`Nenhuma coluna publicavel encontrada em ${relationName}.`);
  return selectable;
}

async function listPortalFinalColumns(client: PoolClient, viewNames: string[]) {
  const relationNames = viewNames.length ? viewNames : ["base_imoveis"];
  const allColumns: string[][] = [];
  for (const relationName of relationNames) {
    allColumns.push(await listPublishSelectableColumns(client, relationName));
  }

  const commonColumns = allColumns[0].filter((column) => allColumns.every((columns) => columns.includes(column)));
  const missingColumns = FINAL_VIEW_REQUIRED_COLUMNS.filter((column) => !commonColumns.includes(column));
  if (missingColumns.length) {
    throw new Error(`As views candidatas precisam expor ${missingColumns.join(", ")} para consolidacao final.`);
  }
  return FINAL_VIEW_REQUIRED_COLUMNS;
}

async function listPortalFinalAdTypes(client: PoolClient, portalId: number): Promise<PortalFinalAdType[]> {
  const result = await client.query<PortalFinalAdType>(
    `
      select a.name as ad_type_name,
             a.slug as ad_type_slug,
             a.tier,
             a.quantity
      from publish_portal_ad_types a
      where a.portal_id = $1
      order by a.tier desc, a.slug asc
    `,
    [portalId]
  );
  return result.rows;
}

async function listPortalFinalCandidateRules(client: PoolClient, portalId: number) {
  const result = await client.query<PortalFinalCandidateRule>(
    `
      select r.id as rule_id,
             r.view_name,
             case
               when r.use_ad_limit = true
                and coalesce(r.ad_limit_type, '') <> ''
                and r.ad_limit_type <> 'total'
               then a.slug
               else null
             end as candidate_ad_type_slug,
             case
               when r.use_ad_limit = true
                and coalesce(r.ad_limit_type, '') <> ''
                and r.ad_limit_type <> 'total'
               then a.tier
               else null
             end as candidate_tier
      from publish_rules r
      left join publish_portal_ad_types a
        on a.portal_id = r.portal_id
       and a.slug = r.ad_limit_type
      where r.portal_id = $1
        and r.active = true
        and r.view_name is not null
        and r.use_ad_limit = true
        and coalesce(r.ad_limit_type, '') <> ''
        and r.ad_limit_type <> 'total'
        and a.slug is not null
      order by
        case
          when r.use_ad_limit = true
           and coalesce(r.ad_limit_type, '') <> ''
           and r.ad_limit_type <> 'total'
          then coalesce(a.tier, -2147483648)
          else -2147483648
        end desc,
        r.id asc
    `,
    [portalId]
  );
  return result.rows.filter((rule): rule is PortalFinalCandidateRule & { view_name: string } => Boolean(rule.view_name));
}

function quotedColumnList(columns: string[], alias?: string) {
  return columns.map((column) => `${alias ? `${quoteIdentifier(alias)}.` : ""}${quoteIdentifier(column)}`).join(", ");
}

function buildEmptyPortalFinalViewSql(viewName: string, columns: string[]) {
  const outputColumns = portalFinalOutputColumns(columns);
  return `create table public.${quoteIdentifier(viewName)} as
select ${quotedColumnList(outputColumns, "b")},
  null::text as ${quoteIdentifier(FINAL_VIEW_AD_TYPE_NAME_COLUMN)},
  null::text as ${quoteIdentifier(FINAL_VIEW_AD_TYPE_SLUG_COLUMN)},
  null::integer as ${quoteIdentifier(FINAL_VIEW_TIER_COLUMN)},
  null::integer as ${quoteIdentifier(FINAL_VIEW_PUBLICATION_RANK_COLUMN)},
  ${quoteLiteral(FINAL_VIEW_PUBLISHED_STATUS)}::text as ${quoteIdentifier(FINAL_VIEW_STATUS_COLUMN)},
  b.${quoteIdentifier("publicacao_portais")}::jsonb as ${quoteIdentifier(FINAL_VIEW_CURRENT_PUBLICATION_COLUMN)}
from public.base_imoveis b
where false`;
}

function portalFinalAdTypesCteSql(adTypes: PortalFinalAdType[]) {
  if (!adTypes.length) {
    return `select null::text as ${quoteIdentifier(FINAL_VIEW_AD_TYPE_NAME_COLUMN)},
    null::text as ${quoteIdentifier(FINAL_VIEW_AD_TYPE_SLUG_COLUMN)},
    null::integer as ${quoteIdentifier(FINAL_VIEW_TIER_COLUMN)},
    null::integer as quantity
  where false`;
  }

  return `values
  ${adTypes
    .map((adType) => `(
    ${quoteLiteral(adType.ad_type_name)}::text,
    ${quoteLiteral(adType.ad_type_slug)}::text,
    ${Math.trunc(Number(adType.tier) || 0)}::integer,
    ${Math.max(0, Math.trunc(Number(adType.quantity) || 0))}::integer
  )`)
    .join(",\n  ")}`;
}

function portalFinalOutputColumns(columns: string[]) {
  return columns.filter((column) => column !== "publicacao_portais");
}

function portalPublishedFromSql(publicationSql: string, portalSlug: string) {
  return `coalesce((${publicationSql} -> ${quoteLiteral(portalSlug)} ->> 'publicado')::boolean, false) is true`;
}

function portalPublicationTypeSlugFromSql(publicationSql: string, portalSlug: string) {
  return `public.publish_publication_type_slug(${publicationSql}, ${quoteLiteral(portalSlug)})`;
}

function buildPortalFinalSelect(columns: string[]) {
  const finalColumnSql = quotedColumnList(portalFinalOutputColumns(columns), "expected");
  return `select ${finalColumnSql},
  expected.${quoteIdentifier(FINAL_VIEW_AD_TYPE_NAME_COLUMN)},
  expected.${quoteIdentifier(FINAL_VIEW_AD_TYPE_SLUG_COLUMN)},
  expected.${quoteIdentifier(FINAL_VIEW_TIER_COLUMN)},
  expected.${quoteIdentifier(FINAL_VIEW_PUBLICATION_RANK_COLUMN)},
  expected.${quoteIdentifier(FINAL_VIEW_STATUS_COLUMN)},
  expected.${quoteIdentifier(FINAL_VIEW_CURRENT_PUBLICATION_COLUMN)}
from ${quoteIdentifier("expected_publications")} expected
order by
  case expected.${quoteIdentifier(FINAL_VIEW_STATUS_COLUMN)}
    when ${quoteLiteral(FINAL_VIEW_PENDING_STATUS)} then 0
    when ${quoteLiteral(FINAL_VIEW_PUBLISHED_STATUS)} then 2
    else 2
  end,
  expected.${quoteIdentifier(FINAL_VIEW_PUBLICATION_RANK_COLUMN)} asc nulls last,
  expected.${quoteIdentifier(FINAL_VIEW_TIER_COLUMN)} desc nulls last,
  expected.${quoteIdentifier("codigo_crm")} asc`;
}

function buildPortalFinalViewSql(
  viewName: string,
  portalSlug: string,
  candidateRules: PortalFinalCandidateRule[],
  adTypes: PortalFinalAdType[],
  columns: string[]
) {
  if (!candidateRules.length || !adTypes.length) {
    return `create table public.${quoteIdentifier(viewName)} as
with ad_types(${quoteIdentifier(FINAL_VIEW_AD_TYPE_NAME_COLUMN)}, ${quoteIdentifier(FINAL_VIEW_AD_TYPE_SLUG_COLUMN)}, ${quoteIdentifier(FINAL_VIEW_TIER_COLUMN)}, quantity) as (
  ${portalFinalAdTypesCteSql(adTypes)}
),
${quoteIdentifier("expected_publications")} as (
  select ${quotedColumnList(columns, "b")},
    null::text as ${quoteIdentifier(FINAL_VIEW_AD_TYPE_NAME_COLUMN)},
    null::text as ${quoteIdentifier(FINAL_VIEW_AD_TYPE_SLUG_COLUMN)},
    null::integer as ${quoteIdentifier(FINAL_VIEW_TIER_COLUMN)},
    null::integer as ${quoteIdentifier(FINAL_VIEW_PUBLICATION_RANK_COLUMN)},
    ${quoteLiteral(FINAL_VIEW_PUBLISHED_STATUS)}::text as ${quoteIdentifier(FINAL_VIEW_STATUS_COLUMN)},
    b.${quoteIdentifier("publicacao_portais")}::jsonb as ${quoteIdentifier(FINAL_VIEW_CURRENT_PUBLICATION_COLUMN)}
  from public.base_imoveis b
  where false
)
${buildPortalFinalSelect(columns)}`;
  }

  const candidateColumnSql = quotedColumnList(columns, "b");
  const eligibleColumnSql = quotedColumnList(columns, "c");
  const rankedColumnSql = quotedColumnList(columns, "ranked");
  const mergedPublicationSql = `coalesce(current_base.${quoteIdentifier("publicacao_portais")}::jsonb, ranked.${quoteIdentifier("publicacao_portais")}::jsonb)`;
  const candidateSql = candidateRules
    .map((rule, index) => {
      const ruleIndexSql = rule.has_rule_index
        ? `coalesce(b.${quoteIdentifier(RULE_INDEX_COLUMN)}, 2147483647)::integer`
        : "row_number() over ()::integer";
      return `select ${index}::integer as ${quoteIdentifier("__allocation_rule_order")},
  ${rule.candidate_ad_type_slug ? quoteLiteral(rule.candidate_ad_type_slug) : "null"}::text as ${quoteIdentifier("__candidate_ad_type_slug")},
  ${rule.candidate_tier == null ? "null" : Math.trunc(Number(rule.candidate_tier) || 0)}::integer as ${quoteIdentifier("__candidate_tier")},
  ${ruleIndexSql} as ${quoteIdentifier(RULE_INDEX_COLUMN)},
  ${candidateColumnSql}
from public.${quoteIdentifier(rule.view_name)} b
where b.codigo_crm is not null`;
    })
    .join("\nunion all\n");

  const allocatedCtes: string[] = [];
  const allocatedNames: string[] = [];
  for (const [index, adType] of adTypes.entries()) {
    const cteName = `allocated_${index}`;
    const exclusions = allocatedNames
      .map((previousCte) => `and not exists (select 1 from ${quoteIdentifier(previousCte)} previous where previous.codigo_crm = d.codigo_crm)`)
      .join("\n  ");
    allocatedCtes.push(`${quoteIdentifier(cteName)} as (
  select *
  from deduped d
  where d.${quoteIdentifier(FINAL_VIEW_AD_TYPE_SLUG_COLUMN)} = ${quoteLiteral(adType.ad_type_slug)}
    ${exclusions}
  order by d.${quoteIdentifier(RULE_INDEX_COLUMN)} asc,
    d.${quoteIdentifier("__allocation_rule_order")} asc,
    d.${quoteIdentifier("codigo_crm")} asc
  limit ${Math.max(0, Math.trunc(Number(adType.quantity) || 0))}
)`);
    allocatedNames.push(cteName);
  }

  return `create table public.${quoteIdentifier(viewName)} as
with ad_types(${quoteIdentifier(FINAL_VIEW_AD_TYPE_NAME_COLUMN)}, ${quoteIdentifier(FINAL_VIEW_AD_TYPE_SLUG_COLUMN)}, ${quoteIdentifier(FINAL_VIEW_TIER_COLUMN)}, quantity) as (
  ${portalFinalAdTypesCteSql(adTypes)}
),
candidates as (
${candidateSql}
),
eligible as (
  select c.${quoteIdentifier("__allocation_rule_order")},
    a.${quoteIdentifier(FINAL_VIEW_AD_TYPE_NAME_COLUMN)},
    a.${quoteIdentifier(FINAL_VIEW_AD_TYPE_SLUG_COLUMN)},
    a.${quoteIdentifier(FINAL_VIEW_TIER_COLUMN)},
    case
      when c.${quoteIdentifier("__candidate_ad_type_slug")} = a.${quoteIdentifier(FINAL_VIEW_AD_TYPE_SLUG_COLUMN)} then 0
      when c.${quoteIdentifier("__candidate_ad_type_slug")} is null then 2
      else 1
    end::integer as ${quoteIdentifier("__allocation_match_rank")},
    abs(coalesce(c.${quoteIdentifier("__candidate_tier")}, a.${quoteIdentifier(FINAL_VIEW_TIER_COLUMN)}) - a.${quoteIdentifier(FINAL_VIEW_TIER_COLUMN)})::integer as ${quoteIdentifier("__allocation_tier_distance")},
    c.${quoteIdentifier("__candidate_tier")},
    c.${quoteIdentifier(RULE_INDEX_COLUMN)},
    ${eligibleColumnSql}
  from candidates c
  join ad_types a
    on c.${quoteIdentifier("__candidate_ad_type_slug")} = a.${quoteIdentifier(FINAL_VIEW_AD_TYPE_SLUG_COLUMN)}
),
deduped as (
  select *
  from (
    select eligible.*,
      row_number() over (
        partition by codigo_crm, ${quoteIdentifier(FINAL_VIEW_AD_TYPE_SLUG_COLUMN)}
        order by ${quoteIdentifier(RULE_INDEX_COLUMN)} asc,
          ${quoteIdentifier("__allocation_rule_order")} asc
      ) as ${quoteIdentifier("__ad_type_duplicate_rank")}
    from eligible
  ) ranked
  where ${quoteIdentifier("__ad_type_duplicate_rank")} = 1
),
${allocatedCtes.join(",\n")},
final_allocation as (
  ${allocatedNames.map((cteName) => `select * from ${quoteIdentifier(cteName)}`).join("\n  union all\n  ")}
),
${quoteIdentifier("ranked_expected")} as (
  select final_allocation.*,
    row_number() over (
      order by ${quoteIdentifier(FINAL_VIEW_TIER_COLUMN)} desc,
        ${quoteIdentifier(RULE_INDEX_COLUMN)} asc,
        ${quoteIdentifier("__allocation_rule_order")} asc,
        ${quoteIdentifier("__allocation_match_rank")} asc,
        ${quoteIdentifier("__allocation_tier_distance")} asc,
        ${quoteIdentifier("codigo_crm")} asc
    )::integer as ${quoteIdentifier(FINAL_VIEW_PUBLICATION_RANK_COLUMN)}
  from final_allocation
),
${quoteIdentifier("expected_publications")} as (
  select ${rankedColumnSql},
    ranked.${quoteIdentifier(FINAL_VIEW_AD_TYPE_NAME_COLUMN)},
    ranked.${quoteIdentifier(FINAL_VIEW_AD_TYPE_SLUG_COLUMN)},
    ranked.${quoteIdentifier(FINAL_VIEW_TIER_COLUMN)},
    ranked.${quoteIdentifier(FINAL_VIEW_PUBLICATION_RANK_COLUMN)},
    case
      when ${portalPublishedFromSql(mergedPublicationSql, portalSlug)}
       and ${portalPublicationTypeSlugFromSql(mergedPublicationSql, portalSlug)} = ranked.${quoteIdentifier(FINAL_VIEW_AD_TYPE_SLUG_COLUMN)}
      then ${quoteLiteral(FINAL_VIEW_PUBLISHED_STATUS)}::text
      else ${quoteLiteral(FINAL_VIEW_PENDING_STATUS)}::text
    end as ${quoteIdentifier(FINAL_VIEW_STATUS_COLUMN)},
    ${mergedPublicationSql} as ${quoteIdentifier(FINAL_VIEW_CURRENT_PUBLICATION_COLUMN)}
  from ${quoteIdentifier("ranked_expected")} ranked
  left join public.base_imoveis current_base
    on current_base.${quoteIdentifier("codigo_crm")} = ranked.${quoteIdentifier("codigo_crm")}
)
${buildPortalFinalSelect(columns)}`;
}

async function createPortalFinalIndexes(client: PoolClient, viewName: string, columns: string[]) {
  const hasCodigoCrm = columns.includes("codigo_crm");
  await client.query(
    `create index on public.${quoteIdentifier(viewName)} (${quoteIdentifier(FINAL_VIEW_AD_TYPE_SLUG_COLUMN)})`
  );
  await client.query(
    `create index on public.${quoteIdentifier(viewName)} (${quoteIdentifier(FINAL_VIEW_PUBLICATION_RANK_COLUMN)})`
  );
  await client.query(
    `create index on public.${quoteIdentifier(viewName)} (${quoteIdentifier(FINAL_VIEW_STATUS_COLUMN)})`
  );
  if (hasCodigoCrm) {
    await client.query(
      `create unique index on public.${quoteIdentifier(viewName)} (${quoteIdentifier("codigo_crm")})`
    );
    await client.query(
      `create index on public.${quoteIdentifier(viewName)} (${quoteIdentifier(FINAL_VIEW_AD_TYPE_SLUG_COLUMN)}, ${quoteIdentifier("codigo_crm")})`
    );
  }
  await client.query(`grant select on public.${quoteIdentifier(viewName)} to service_role`);
}

async function refreshPortalFinalView(client: PoolClient, portalId: number, reason = "change") {
  await acquirePublishRefreshLock(client);
  const portal = await client.query<Pick<Portal, "slug">>("select slug from publish_portals where id = $1", [portalId]);
  if (!portal.rows[0]?.slug) return null;

  const viewName = portalFinalViewName(portal.rows[0].slug);
  const [candidateRules, adTypes] = await Promise.all([
    listPortalFinalCandidateRules(client, portalId),
    listPortalFinalAdTypes(client, portalId)
  ]);
  const candidateRulesWithIndex: Array<PortalFinalCandidateRule & { view_name: string; has_rule_index: boolean }> = [];
  for (const rule of candidateRules) {
    candidateRulesWithIndex.push({
      ...rule,
      has_rule_index: (await listRelationColumns(client, rule.view_name)).includes(RULE_INDEX_COLUMN)
    });
  }
  const columns = await listPortalFinalColumns(client, candidateRules.map((rule) => rule.view_name));
  const sql = buildPortalFinalViewSql(viewName, portal.rows[0].slug, candidateRulesWithIndex, adTypes, columns);
  await dropPortalFinalRelation(client, viewName);
  await client.query(sql);
  await createPortalFinalIndexes(client, viewName, columns);
  await client.query(
    "update publish_portals set final_view_refreshed_at = now(), final_view_refresh_reason = $2 where id = $1",
    [portalId, reason]
  );
  return { viewName, sql };
}

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

function healthcheckPendingQuery(rule: HealthcheckReportRuleRow, adTypeSlug: string) {
  if (!rule.portal_slug) return null;
  const shouldFilterType = rule.use_ad_limit && Boolean(rule.ad_limit_type && rule.ad_limit_type !== "total");
  const finalViewName = portalFinalViewName(rule.portal_slug);
  return `
select b.codigo_crm::text as codigo_crm
from public.${quoteIdentifier(finalViewName)} b
where b.${quoteIdentifier(FINAL_VIEW_STATUS_COLUMN)} = ${quoteLiteral(FINAL_VIEW_PENDING_STATUS)}
  ${shouldFilterType ? `and b.${quoteIdentifier(FINAL_VIEW_AD_TYPE_SLUG_COLUMN)} = ${quoteLiteral(adTypeSlug)}` : ""}
order by b.${quoteIdentifier(FINAL_VIEW_PUBLICATION_RANK_COLUMN)} asc nulls last,
  b.codigo_crm asc
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

  const pendingQuery = healthcheckPendingQuery(rule, adType.slug);
  baseReport.queries.pending_codes = pendingQuery;
  baseReport.queries.unexpected_codes = null;

  try {
    const pending = pendingQuery
      ? await query<{ codigo_crm: string }>(pendingQuery)
      : ({ rows: [] } as { rows: Array<{ codigo_crm: string }> });

    return {
      ...baseReport,
      codes: {
        pending: pending.rows.map((row) => row.codigo_crm),
        unexpected: []
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

async function runSingleRuleHealthcheck(
  client: PoolClient,
  rule: HealthcheckRuleRow,
  portalStatusError: string | null = null
): Promise<RuleHealthcheckStatus> {
  const checkedAt = new Date().toISOString();

  try {
    if (!rule.portal_id || !rule.portal_slug) {
      return updateRuleHealthcheckStatus(client, rule, null, null, null, null, checkedAt, "Regra sem portal vinculado.");
    }

    const finalViewName = portalFinalViewName(rule.portal_slug);
    if (portalStatusError) {
      return updateRuleHealthcheckStatus(client, rule, null, null, null, null, checkedAt, portalStatusError);
    }

    const viewExists = await client.query<{ exists: boolean }>(
      `
        select exists (
          select 1
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and c.relkind in ('r', 'v', 'm')
            and c.relname = $1
        ) as exists
      `,
      [finalViewName]
    );
    if (!viewExists.rows[0]?.exists) {
      return updateRuleHealthcheckStatus(client, rule, null, null, null, null, checkedAt, "Listagem final do portal nao encontrada.");
    }

    const finalViewReady = await client.query<{ ready: boolean }>(
      `
        select not exists (
          select 1
            from (values ('codigo_crm'), ($2), ($3), ($4), ($5)) as required(column_name)
          where not exists (
            select 1
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            join pg_attribute a on a.attrelid = c.oid
              where n.nspname = 'public'
              and c.relkind in ('r', 'v', 'm')
              and c.relname = $1
              and a.attnum > 0
              and not a.attisdropped
              and a.attname = required.column_name
          )
        ) as ready
      `,
      [
        finalViewName,
        FINAL_VIEW_AD_TYPE_SLUG_COLUMN,
        FINAL_VIEW_PUBLICATION_RANK_COLUMN,
        FINAL_VIEW_STATUS_COLUMN,
        FINAL_VIEW_CURRENT_PUBLICATION_COLUMN
      ]
    );
    if (!finalViewReady.rows[0]?.ready) {
      return updateRuleHealthcheckStatus(
        client,
        rule,
        null,
        null,
        null,
        null,
        checkedAt,
        "Listagem final do portal sem codigo_crm, ad_type_slug, publication_rank, status ou current_publication."
      );
    }

    const shouldFilterType = rule.use_ad_limit && Boolean(rule.ad_limit_type && rule.ad_limit_type !== "total");
    const adLimitTypeFilter = shouldFilterType && rule.ad_limit_type ? adLimitTypeSlug(rule.ad_limit_type) : null;
    const expected = await client.query<{ count: number }>(
      `
        select count(*)::int as count
        from public.${quoteIdentifier(finalViewName)} b
        where b.${quoteIdentifier(FINAL_VIEW_STATUS_COLUMN)} in ($1, $2)
          ${shouldFilterType ? `and b.${quoteIdentifier(FINAL_VIEW_AD_TYPE_SLUG_COLUMN)} = $3` : ""}
      `,
      shouldFilterType
        ? [FINAL_VIEW_PUBLISHED_STATUS, FINAL_VIEW_PENDING_STATUS, adLimitTypeFilter]
        : [FINAL_VIEW_PUBLISHED_STATUS, FINAL_VIEW_PENDING_STATUS]
    );
    const expectedCount = expected.rows[0]?.count ?? 0;
    const published = await client.query<{ count: number }>(
      `
        select count(*)::int as count
        from public.${quoteIdentifier(finalViewName)} b
        where b.${quoteIdentifier(FINAL_VIEW_STATUS_COLUMN)} = $1
          ${shouldFilterType ? `and b.${quoteIdentifier(FINAL_VIEW_AD_TYPE_SLUG_COLUMN)} = $2` : ""}
      `,
      shouldFilterType ? [FINAL_VIEW_PUBLISHED_STATUS, adLimitTypeFilter] : [FINAL_VIEW_PUBLISHED_STATUS]
    );
    const publishedCount = published.rows[0]?.count ?? 0;
    const pending = await client.query<{ count: number }>(
      `
        select count(*)::int as count
        from public.${quoteIdentifier(finalViewName)} b
        where b.${quoteIdentifier(FINAL_VIEW_STATUS_COLUMN)} = $1
          ${shouldFilterType ? `and b.${quoteIdentifier(FINAL_VIEW_AD_TYPE_SLUG_COLUMN)} = $2` : ""}
      `,
      shouldFilterType ? [FINAL_VIEW_PENDING_STATUS, adLimitTypeFilter] : [FINAL_VIEW_PENDING_STATUS]
    );
    const pendingCount = pending.rows[0]?.count ?? 0;
    return updateRuleHealthcheckStatus(
      client,
      rule,
      expectedCount,
      publishedCount,
      pendingCount,
      0,
      checkedAt,
      null
    );
  } catch (error) {
    return updateRuleHealthcheckStatus(
      client,
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
  client: PoolClient,
  rule: HealthcheckRuleRow,
  expectedCount: number | null,
  publishedCount: number | null,
  pendingCount: number | null,
  unexpectedCount: number | null,
  checkedAt: string,
  error: string | null
): Promise<RuleHealthcheckStatus> {
  await client.query(
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
  await acquirePublishRefreshLock(client);
  const targetViewName = viewName ?? `pc_rule_${id}`;
  assertRuleViewName(targetViewName);
  const columns = await getBaseColumns(client);
  const sourceColumns = await listPublishSelectableColumns(client, rule.source_table);
  const sql = buildViewSql(
    targetViewName,
    rule.source_table,
    rule.filters,
    columns,
    rule.include_locked,
    rule.active,
    rule.publication_priority,
    null,
    sourceColumns,
    true
  );
  await createOrRecreateRuleView(client, targetViewName, sql);

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

function assertRuleViewName(viewName: string) {
  if (!/^pc_[a-z0-9_]+$/.test(viewName) || viewName.length > 63) {
    throw new Error(`Nome de view de regra invalido: ${viewName}`);
  }
}

async function createOrRecreateRuleView(client: PoolClient, viewName: string, sql: string) {
  await client.query("savepoint refresh_rule_view_replace");
  try {
    await client.query(sql);
    await client.query("release savepoint refresh_rule_view_replace");
    return;
  } catch (error) {
    await client.query("rollback to savepoint refresh_rule_view_replace");
    await client.query("release savepoint refresh_rule_view_replace");

    if (!shouldRecreateRuleView(error)) throw error;

    logRepository("info", "rule-view.recreate-required", {
      viewName,
      reason: error instanceof Error ? error.message : String(error)
    });
    await client.query(`drop view if exists public.${quoteIdentifier(viewName)} cascade`);
    await client.query(sql);
  }
}

function shouldRecreateRuleView(error: unknown) {
  const candidate = error as { code?: string; message?: string } | null;
  const message = candidate?.message ?? "";
  return (
    candidate?.code === "42P16" ||
    /cannot drop columns from view/i.test(message) ||
    /cannot change name of view column/i.test(message) ||
    /cannot change data type of view column/i.test(message)
  );
}
