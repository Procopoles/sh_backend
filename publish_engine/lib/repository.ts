import type { PoolClient } from "pg";
import { dataApiRequest, dataApiRpc, isDataApiConfigured } from "./data-api";
import { ensureControlSchema, getPool, query, withTransaction } from "./db";
import {
  buildAdLimitSql,
  buildViewSql,
  buildWhereSql,
  buildRuleRowsPreviewQuery,
  DEFAULT_FILTERS,
  DEFAULT_PUBLICATION_PRIORITY,
  getBaseColumns,
  quoteIdentifier,
  sanitizeFilters,
  sanitizePublicationPriority,
  slugify
} from "./rules";
import type { ColumnMetadata, Portal, PortalAdType, PublicationPriority, PublicationRule, RuleFilters, SourceViewMetadata } from "./types";

type PortalInput = {
  name: string;
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
};

type PreviewRowsInput = RuleInput & {
  limit?: number;
};

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
  return withTransaction(async (client) => {
    const slug = slugify(input.name);
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
}

export async function updatePortal(id: number, input: PortalInput) {
  if (isDataApiConfigured()) return updatePortalViaApi(id, input);

  await ensureControlSchema();
  return withTransaction(async (client) => {
    const slug = slugify(input.name);
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
    return getPortalById(client, id);
  });
}

export async function deletePortal(id: number) {
  if (isDataApiConfigured()) return deletePortalViaApi(id);

  await ensureControlSchema();
  return withTransaction(async (client) => {
    await client.query("update publish_rules set portal_id = null, updated_at = now() where portal_id = $1", [id]);
    await client.query("delete from publish_portals where id = $1", [id]);
  });
}

export async function listRules(portalId?: number) {
  if (isDataApiConfigured()) return listRulesViaApi(portalId);

  await ensureControlSchema();
  const params = portalId ? [portalId] : [];
  const result = await query<PublicationRule>(
    `
      select r.*, p.name as portal_name
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
  return withTransaction(async (client) => {
    const columns = await getBaseColumns(client);
    const portalId = normalizePortalId(input.portal_id);
    const portal = portalId
      ? await client.query<{ slug: string }>("select slug from publish_portals where id = $1", [portalId])
      : ({ rows: [{ slug: "" }] } as { rows: Array<{ slug: string }> });
    if (!portal.rows[0]) throw new Error("Portal nao encontrado.");

    const slug = slugify(input.name);
    const filters = sanitizeFilters(input.filters ?? DEFAULT_FILTERS, columns);
    const publicationPriority = sanitizePublicationPriority(input.publication_priority ?? DEFAULT_PUBLICATION_PRIORITY, columns);
    const sourceTable = await validateSourceTable(client, input.source_table);
    const adLimit = await normalizeRuleAdLimit(client, portalId, input.use_ad_limit ?? false, input.ad_limit_type);
    const inserted = await client.query<PublicationRule>(
      `
        insert into publish_rules
          (portal_id, name, slug, description, source_table, active, include_locked, use_ad_limit, ad_limit_type, filters, publication_priority)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
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
        JSON.stringify(publicationPriority)
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
      publication_priority: publicationPriority
    });
  });
}

export async function updateRule(id: number, input: RuleInput) {
  if (isDataApiConfigured()) return updateRuleViaApi(id, input);

  await ensureControlSchema();
  return withTransaction(async (client) => {
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
        JSON.stringify(publicationPriority)
      ]
    );

    return refreshRuleView(client, id, updated.rows[0].view_name, {
      ...updated.rows[0],
      filters,
      source_table: sourceTable,
      active: input.active ?? true,
      include_locked: input.include_locked ?? true,
      use_ad_limit: adLimit.useAdLimit,
      ad_limit_type: adLimit.adLimitType,
      publication_priority: publicationPriority
    });
  });
}

export async function deleteRule(id: number) {
  if (isDataApiConfigured()) return deleteRuleViaApi(id);

  await ensureControlSchema();
  return withTransaction(async (client) => {
    const existing = await client.query<{ view_name: string | null }>(
      "select view_name from publish_rules where id = $1",
      [id]
    );
    if (existing.rows[0]?.view_name) {
      await client.query(`drop view if exists public."${existing.rows[0].view_name.replace(/"/g, '""')}"`);
    }
    await client.query("delete from publish_rules where id = $1", [id]);
  });
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
      adLimitQuota == null ? input.limit ?? 10 : Math.min(input.limit ?? 10, adLimitQuota),
      publicationPriority
    );
    const result = await client.query<Record<string, unknown>>(preview.sql, preview.params);
    return { columns: preview.columns, rows: result.rows };
  });
}

export async function getMetadata() {
  if (isDataApiConfigured()) {
    const [columns, counts, sourceViews] = await Promise.all([
      dataApiRpc<ColumnMetadata[]>("publish_base_columns"),
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
  const rows = await dataApiRequest<Portal[]>("/publish_portals", {
    method: "POST",
    prefer: "return=representation",
    body: {
      name: input.name.trim(),
      slug: slugify(input.name),
      description: input.description ?? null,
      logo_url: input.logo_url ?? null,
      active: input.active ?? true
    }
  });
  await replacePortalAdTypesViaApi(rows[0].id, input.ad_types ?? []);
  return getPortalByIdViaApi(rows[0].id);
}

async function updatePortalViaApi(id: number, input: PortalInput) {
  const rows = await dataApiRequest<Portal[]>(`/publish_portals?id=eq.${id}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: {
      name: input.name.trim(),
      slug: slugify(input.name),
      description: input.description ?? null,
      logo_url: input.logo_url ?? null,
      active: input.active ?? true,
      updated_at: new Date().toISOString()
    }
  });
  if (!rows[0]) return null;
  await replacePortalAdTypesViaApi(id, input.ad_types ?? []);
  return getPortalByIdViaApi(id);
}

async function deletePortalViaApi(id: number) {
  await dataApiRequest(`/publish_rules?portal_id=eq.${id}`, { method: "PATCH", body: { portal_id: null } });
  await dataApiRequest(`/publish_portals?id=eq.${id}`, { method: "DELETE" });
}

async function listRulesViaApi(portalId?: number) {
  const rulePath = portalId
    ? `/publish_rules?portal_id=eq.${portalId}&order=updated_at.desc,id.desc`
    : "/publish_rules?order=updated_at.desc,id.desc";
  const [rules, portals] = await Promise.all([
    dataApiRequest<PublicationRule[]>(rulePath),
    dataApiRequest<Array<Pick<Portal, "id" | "name">>>("/publish_portals?select=id,name")
  ]);
  const portalNames = new Map(portals.map((portal) => [portal.id, portal.name]));
  return rules.map((rule) => ({ ...rule, portal_name: rule.portal_id == null ? undefined : portalNames.get(rule.portal_id) }));
}

async function createRuleViaApi(input: RuleInput) {
  const columns = await listBaseColumnsViaApi();
  const filters = sanitizeFilters(input.filters ?? DEFAULT_FILTERS, columns);
  const publicationPriority = sanitizePublicationPriority(input.publication_priority ?? DEFAULT_PUBLICATION_PRIORITY, columns);
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
      publication_priority: publicationPriority
    }
  });

  const refreshed = await dataApiRpc<PublicationRule[]>("refresh_publish_rule_view", {
    rule_id: inserted[0].id
  });
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
      updated_at: new Date().toISOString()
    }
  });

  if (!updated[0]) return null;
  const refreshed = await dataApiRpc<PublicationRule[]>("refresh_publish_rule_view", { rule_id: id });
  return refreshed[0];
}

async function deleteRuleViaApi(id: number) {
  await dataApiRpc<PublicationRule[]>("drop_publish_rule_view", { rule_id: id });
  await dataApiRequest(`/publish_rules?id=eq.${id}`, { method: "DELETE" });
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
    preview_limit: input.limit === 100 ? 100 : 10
  });
}

async function listBaseColumnsViaApi() {
  return dataApiRpc<ColumnMetadata[]>("publish_base_columns");
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

function normalizeAdLimitType(adLimitType?: string | null) {
  const normalized = normalizeAdTypeName(adLimitType || "total");
  return normalized || "total";
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

async function refreshRuleView(
  client: PoolClient,
  id: number,
  viewName: string | null,
  rule: Pick<
    PublicationRule,
    "portal_id" | "filters" | "source_table" | "active" | "include_locked" | "use_ad_limit" | "ad_limit_type" | "publication_priority"
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
