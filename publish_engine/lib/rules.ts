import type { PoolClient } from "pg";
import type {
  ColumnMetadata,
  PublicationPriority,
  PublicationPriorityItem,
  PublicationPrioritySortItem,
  RuleCondition,
  RuleFilterGroup,
  RuleFilterItem,
  RuleFilters,
  RuleOperator
} from "./types";

const TEXT_TYPES = new Set(["text", "character varying", "character", "uuid"]);
const NUMBER_TYPES = new Set([
  "smallint",
  "integer",
  "bigint",
  "numeric",
  "real",
  "double precision"
]);
const DATE_TYPES = new Set([
  "timestamp with time zone",
  "timestamp without time zone",
  "date"
]);
const JSON_PATH_LIMIT = 8;
const JSON_FIELD_LIMIT = 80;
const JSON_FIELD_SAMPLE_LIMIT = 300;
const JSON_VALUE_KINDS: ColumnMetadata["filter_kind"][] = ["text", "number", "boolean", "datetime", "json"];
const BASE_COLUMNS_CACHE_MS = 5 * 60 * 1000;

let baseColumnsCache: { expiresAt: number; columns: ColumnMetadata[] } | null = null;

export const DEFAULT_FILTERS: RuleFilters = { combinator: "and", conditions: [] };
export const DEFAULT_PUBLICATION_PRIORITY: PublicationPriority = [];

export type RuleRowsPreviewColumn = {
  key: string;
  label: string;
};

export const RULE_INDEX_COLUMN = "__publish_rule_index";

export function slugify(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 54) || "regra";
}

export function quoteIdentifier(identifier: string) {
  if (!identifier || identifier.includes("\u0000")) {
    throw new Error(`Identificador SQL inválido: ${identifier}`);
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function quoteLiteral(value: string) {
  if (value.includes("\u0000")) {
    throw new Error("Valor SQL invalido.");
  }
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildAdLimitSql(portalId: number | null | undefined, adLimitType: string | null | undefined) {
  if (!portalId) return null;
  return `public.publish_ad_limit_quota(${Math.trunc(portalId)}, ${quoteLiteral(adLimitType || "total")})`;
}

export function getFilterKind(dataType: string): ColumnMetadata["filter_kind"] {
  if (TEXT_TYPES.has(dataType)) return "text";
  if (NUMBER_TYPES.has(dataType)) return "number";
  if (DATE_TYPES.has(dataType)) return "datetime";
  if (dataType === "boolean") return "boolean";
  if (dataType === "jsonb" || dataType === "json") return "json";
  return "other";
}

export function operatorsForKind(kind: ColumnMetadata["filter_kind"]): RuleOperator[] {
  if (kind === "boolean") return ["is_true", "is_false", "is_null", "is_not_null"];
  if (kind === "number" || kind === "datetime") {
    return ["equals", "not_equals", "gt", "gte", "lt", "lte", "between", "is_null", "is_not_null"];
  }
  if (kind === "json") return ["contains", "is_null", "is_not_null"];
  return ["equals", "not_equals", "contains", "starts_with", "in", "is_null", "is_not_null"];
}

export function sanitizeFilters(filters: unknown, columns: ColumnMetadata[]): RuleFilters {
  const lookup = createColumnLookup(columns);
  const candidate = filters as Partial<RuleFilters> | null;

  return {
    combinator: candidate?.combinator === "or" ? "or" : "and",
    conditions: sanitizeFilterItems(candidate?.conditions, lookup, 0)
  };
}

export function sanitizePublicationPriority(priority: unknown, columns: ColumnMetadata[]): PublicationPriority {
  if (!Array.isArray(priority)) return DEFAULT_PUBLICATION_PRIORITY;

  const lookup = createColumnLookup(columns);
  return priority
    .map((item) => sanitizePublicationPriorityItem(item, lookup))
    .filter((item): item is PublicationPriorityItem => item !== null)
    .slice(0, 8);
}

type ColumnLookup = {
  baseColumns: Map<string, ColumnMetadata>;
  jsonPathKinds: Map<string, ColumnMetadata["filter_kind"]>;
};

function createColumnLookup(columns: ColumnMetadata[]): ColumnLookup {
  const baseColumns = new Map<string, ColumnMetadata>();
  const jsonPathKinds = new Map<string, ColumnMetadata["filter_kind"]>();

  for (const column of columns) {
    const path = sanitizeJsonPath(column.json_path);
    if (path.length) {
      jsonPathKinds.set(jsonPathKey(column.column_name, path), column.filter_kind);
      if (!baseColumns.has(column.column_name)) {
        baseColumns.set(column.column_name, { ...column, json_path: null, display_name: column.column_name, filter_kind: "json" });
      }
      continue;
    }

    baseColumns.set(column.column_name, column);
  }

  return { baseColumns, jsonPathKinds };
}

function sanitizeFilterItems(
  items: unknown,
  lookup: ColumnLookup,
  depth: number
): RuleFilterItem[] {
  if (!Array.isArray(items) || depth > 8) return [];

  return items
    .map((item) => sanitizeFilterItem(item, lookup, depth))
    .filter((item): item is RuleFilterItem => item !== null);
}

function sanitizeFilterItem(
  item: unknown,
  lookup: ColumnLookup,
  depth: number
): RuleFilterItem | null {
  if (isFilterGroup(item)) {
    const group: RuleFilterGroup = {
      type: "group",
      name: sanitizeFilterItemName(item.name),
      combinator: item.combinator === "or" ? "or" : "and",
      conditions: sanitizeFilterItems(item.conditions, lookup, depth + 1)
    };
    return group.conditions.length ? group : null;
  }

  return sanitizeCondition(item as RuleCondition, lookup);
}

function isFilterGroup(item: unknown): item is Partial<RuleFilterGroup> {
  return Boolean(
    item &&
      typeof item === "object" &&
      Array.isArray((item as Partial<RuleFilterGroup>).conditions) &&
      (!(item as Partial<RuleCondition>).column || (item as Partial<RuleFilterGroup>).type === "group")
  );
}

function sanitizeFilterItemName(name: unknown) {
  if (typeof name !== "string") return undefined;
  const normalized = name.normalize("NFC").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 80) : undefined;
}

function sanitizeCondition(
  condition: RuleCondition,
  lookup: ColumnLookup
): RuleCondition | null {
  const column = lookup.baseColumns.get(condition?.column);
  if (!column) return null;

  const jsonPath = column.filter_kind === "json" ? sanitizeJsonPath(condition.jsonPath) : [];
  const filterKind = jsonPath.length
    ? sanitizeJsonValueKind(condition.jsonValueKind) ?? lookup.jsonPathKinds.get(jsonPathKey(column.column_name, jsonPath)) ?? "text"
    : column.filter_kind;
  const operators = operatorsForKind(filterKind);
  const operator = operators.includes(condition.operator) ? condition.operator : operators[0];

  return {
    column: column.column_name,
    jsonPath: jsonPath.length ? jsonPath : null,
    jsonValueKind: jsonPath.length ? filterKind : null,
    operator,
    value: condition.value ?? null,
    secondaryValue: condition.secondaryValue ?? null,
    caseInsensitive: isTextComparison(filterKind, operator) ? condition.caseInsensitive !== false : undefined
  };
}

function sanitizePublicationPriorityItem(
  item: unknown,
  lookup: ColumnLookup
): PublicationPriorityItem | null {
  if (isFilterGroup(item)) {
    const group: RuleFilterGroup = {
      type: "group",
      name: sanitizeFilterItemName(item.name),
      combinator: item.combinator === "or" ? "or" : "and",
      conditions: sanitizeFilterItems(item.conditions, lookup, 1)
    };
    return group.conditions.length ? group : null;
  }

  return sanitizePublicationPrioritySortItem(item as Partial<PublicationPrioritySortItem>, lookup);
}

function sanitizePublicationPrioritySortItem(
  item: Partial<PublicationPrioritySortItem>,
  lookup: ColumnLookup
): PublicationPrioritySortItem | null {
  const column = lookup.baseColumns.get(item?.column ?? "");
  if (!column) return null;

  const jsonPath = column.filter_kind === "json" ? sanitizeJsonPath(item.jsonPath) : [];
  const priorityKind = jsonPath.length
    ? sanitizeJsonValueKind(item.jsonValueKind) ?? lookup.jsonPathKinds.get(jsonPathKey(column.column_name, jsonPath)) ?? "text"
    : column.filter_kind;

  if (!isSortableKind(priorityKind)) return null;

  return {
    type: "sort",
    column: column.column_name,
    jsonPath: jsonPath.length ? jsonPath : null,
    jsonValueKind: jsonPath.length ? priorityKind : null,
    direction: item.direction === "desc" ? "desc" : "asc",
    nulls: item.nulls === "first" ? "first" : "last"
  };
}

export async function getBaseColumns(client: PoolClient): Promise<ColumnMetadata[]> {
  if (baseColumnsCache && baseColumnsCache.expiresAt > Date.now()) {
    return baseColumnsCache.columns;
  }

  const result = await client.query<ColumnMetadata>(`
    select column_name, data_type, udt_name, is_nullable,
      case
        when data_type in ('text', 'character varying', 'character', 'uuid') then 'text'
        when data_type in ('smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision') then 'number'
        when data_type in ('timestamp with time zone', 'timestamp without time zone', 'date') then 'datetime'
        when data_type = 'boolean' then 'boolean'
        when data_type in ('json', 'jsonb') then 'json'
        else 'other'
      end as filter_kind
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'base_imoveis'
    order by ordinal_position
  `);

  const jsonColumns = result.rows.filter((column) => column.filter_kind === "json");
  const jsonFields: ColumnMetadata[] = [];
  for (const column of jsonColumns) {
    jsonFields.push(...(await getJsonColumnFields(client, column)));
  }

  const columns = result.rows.flatMap((column) => [
    column,
    ...jsonFields.filter((field) => field.column_name === column.column_name)
  ]);
  baseColumnsCache = { columns, expiresAt: Date.now() + BASE_COLUMNS_CACHE_MS };
  return columns;
}

export function buildWhereSql(
  filters: RuleFilters,
  columns: ColumnMetadata[],
  includeLocked: boolean,
  useParameters: boolean
) {
  const lookup = createColumnLookup(columns);
  const params: unknown[] = [];
  const filterSql = buildFilterGroupSql(filters, lookup, params, useParameters, true);
  const lockedSql = `exists (
    select 1
    from publish_locks l
    where l.id_imovel::bigint = b.id_interno
      and l.publish_lock_until::date > current_date
      and l.lock_level >= 1
  )`;
  const whereSql = includeLocked ? `((${filterSql}) or ${lockedSql})` : filterSql;

  return { whereSql, params };
}

export function buildViewSql(
  viewName: string,
  sourceTable: string,
  filters: RuleFilters,
  columns: ColumnMetadata[],
  includeLocked: boolean,
  active: boolean,
  publicationPriority: PublicationPriority = DEFAULT_PUBLICATION_PRIORITY,
  limitSql?: string | null,
  selectColumns?: string[],
  includeRuleIndex = false
) {
  const whereSql = active
    ? buildWhereSql(filters, columns, includeLocked, false).whereSql
    : "false";

  return `create or replace view public.${quoteIdentifier(viewName)} as
${buildRuleSelectSql(
  sourceTable,
  filters,
  columns,
  includeLocked,
  active,
  whereSql,
  publicationPriority,
  limitSql,
  selectColumns,
  includeRuleIndex
)}`;
}

export function buildRuleSelectSql(
  sourceTable: string,
  filters: RuleFilters,
  columns: ColumnMetadata[],
  includeLocked: boolean,
  active: boolean,
  resolvedWhereSql?: string,
  publicationPriority: PublicationPriority = DEFAULT_PUBLICATION_PRIORITY,
  limitSql?: string | null,
  selectColumns?: string[],
  includeRuleIndex = false
) {
  const whereSql =
    resolvedWhereSql ??
    (active ? buildWhereSql(filters, columns, includeLocked, false).whereSql : "false");
  const orderBySql = buildOrderBySql(publicationPriority, columns);
  const resolvedLimitSql = limitSql ? `\nlimit ${limitSql}` : "";
  const selectSql = selectColumns?.length
    ? selectColumns.map((column) => `b.${quoteIdentifier(column)}`).join(", ")
    : "b.*";
  const ruleIndexSql = includeRuleIndex
    ? `, row_number() over (${buildWindowOrderBySql(publicationPriority, columns, selectColumns)})::integer as ${quoteIdentifier(RULE_INDEX_COLUMN)}`
    : "";

  return `select ${selectSql}${ruleIndexSql}
from public.${quoteIdentifier(sourceTable)} b
where ${whereSql}${orderBySql}${resolvedLimitSql}`;
}

export function buildRuleRowsPreviewQuery(
  sourceTable: string,
  filters: RuleFilters,
  columns: ColumnMetadata[],
  includeLocked: boolean,
  active: boolean,
  previewLimitInput: number,
  publicationPriority: PublicationPriority = DEFAULT_PUBLICATION_PRIORITY,
  finalLimit: number | null = null,
  previewSortColumnKey: string | null = null,
  previewSortDirection: "asc" | "desc" = "asc",
  crmCodeInput: string | null = null
) {
  const previewLimit = previewLimitInput === 100 ? 100 : 10;
  const where = active ? buildWhereSql(filters, columns, includeLocked, true) : { whereSql: "false", params: [] };
  const previewColumns = previewColumnsForFilters(filters, columns);
  const selectParts = previewColumns.map((column) => `${column.sql} as ${quoteIdentifier(column.key)}`);
  const orderBySql = buildOrderBySql(publicationPriority, columns);
  const finalLimitSql = finalLimit == null ? "" : `\nlimit ${Math.max(0, Math.floor(finalLimit))}`;
  const sortDirection = previewSortDirection === "desc" ? "desc" : "asc";
  const sortColumn = previewColumns.find((column) => column.key === previewSortColumnKey);
  const previewOrderBySql = sortColumn
    ? `${sortColumn.sql} ${sortDirection} nulls last, b.__preview_rule_order asc`
    : `b.__preview_rule_order ${sortDirection}`;
  const crmCode = normalizeCrmCodeFilter(crmCodeInput);
  const hasCrmColumn = columns.some((column) => column.column_name === "codigo_crm" && !sanitizeJsonPath(column.json_path).length);
  const params = [...where.params];
  const crmFilterSql = crmCode && hasCrmColumn
    ? `\nwhere strpos(lower(b.${quoteIdentifier("codigo_crm")}::text), lower($${params.push(crmCode)}::text)) > 0`
    : "";

  return {
    sql: `with final_selection as (
  select b.*, row_number() over () as __preview_rule_order
  from (
    select b.*
    from public.${quoteIdentifier(sourceTable)} b
    where ${where.whereSql}${orderBySql}${finalLimitSql}
  ) b
)
select ${selectParts.join(", ")}
from final_selection b
${crmFilterSql}
order by ${previewOrderBySql}
limit ${previewLimit}`,
    params,
    columns: previewColumns.map(({ key, label }) => ({ key, label }))
  };
}

function buildOrderByParts(priority: PublicationPriority, columns: ColumnMetadata[]) {
  const lookup = createColumnLookup(columns);
  return sanitizePublicationPriority(priority, columns)
    .map((item) => {
      if ("conditions" in item) {
        const groupSql = buildFilterGroupSql(item, lookup, [], false, false);
        return groupSql ? `case when ${groupSql} then 0 else 1 end asc` : null;
      }

      const target = resolveSortableTarget(item, lookup);
      if (!target) return null;

      const direction = item.direction === "desc" ? "desc" : "asc";
      const nulls = item.nulls === "first" ? "nulls first" : "nulls last";
      return `${target.columnSql} ${direction} ${nulls}`;
    })
    .filter((part): part is string => Boolean(part));
}

function buildOrderBySql(priority: PublicationPriority, columns: ColumnMetadata[]) {
  const parts = buildOrderByParts(priority, columns);

  return parts.length ? `\norder by ${parts.join(", ")}` : "";
}

function buildWindowOrderBySql(priority: PublicationPriority, columns: ColumnMetadata[], selectColumns?: string[]) {
  const parts = buildOrderByParts(priority, columns);
  const tieBreaker = selectColumns?.includes("codigo_crm")
    ? "b.codigo_crm asc nulls last"
    : selectColumns?.includes("id_interno")
      ? "b.id_interno asc nulls last"
      : null;

  if (tieBreaker && !parts.includes(tieBreaker)) parts.push(tieBreaker);
  return parts.length ? `order by ${parts.join(", ")}` : "";
}

function previewColumnsForFilters(filters: RuleFilters, columns: ColumnMetadata[]) {
  const lookup = createColumnLookup(columns);
  const seen = new Set<string>();
  const previewColumns: Array<RuleRowsPreviewColumn & { sql: string }> = [];

  const addColumn = (identity: string, label: string, sql: string) => {
    if (seen.has(identity)) return;
    seen.add(identity);
    const key = ["codigo_crm", "codigo_crm", "id_interno"].includes(identity) ? identity : `campo_${previewColumns.length}`;
    previewColumns.push({ key, label, sql });
  };

  const identifierColumn = previewIdentifierColumn(columns);
  if (identifierColumn) {
    addColumn(identifierColumn.column_name, identifierColumn.column_name, `b.${quoteIdentifier(identifierColumn.column_name)}`);
  }

  for (const condition of filterConditions(filters)) {
    const target = resolveConditionTarget(condition, lookup);
    if (!target) continue;

    addColumn(previewColumnKey(condition), previewColumnLabel(condition, columns), target.columnSql);
  }

  return previewColumns;
}

function previewIdentifierColumn(columns: ColumnMetadata[]) {
  return (
    columns.find((column) => column.column_name === "codigo_crm" && !sanitizeJsonPath(column.json_path).length) ??
    columns.find((column) => column.column_name === "id_interno" && !sanitizeJsonPath(column.json_path).length) ??
    columns.find((column) => !sanitizeJsonPath(column.json_path).length)
  );
}

function filterConditions(group: Pick<RuleFilterGroup, "conditions">): RuleCondition[] {
  return group.conditions.flatMap((item) => ("conditions" in item ? filterConditions(item) : [item]));
}

function previewColumnKey(condition: RuleCondition) {
  const path = sanitizeJsonPath(condition.jsonPath);
  return path.length ? `${condition.column}__${path.join("__")}` : condition.column;
}

function previewColumnLabel(condition: RuleCondition, columns: ColumnMetadata[]) {
  const path = sanitizeJsonPath(condition.jsonPath);
  const matchingColumn = columns.find((column) => column.column_name === condition.column && jsonPathKey(column.column_name, sanitizeJsonPath(column.json_path)) === jsonPathKey(condition.column, path));
  return matchingColumn?.display_name ?? (path.length ? `${condition.column}.${path.join(".")}` : condition.column);
}

function buildConditionSql(
  condition: RuleCondition,
  lookup: ColumnLookup,
  params: unknown[],
  useParameters: boolean
) {
  const target = resolveConditionTarget(condition, lookup);
  if (!target) return "";

  const { columnSql, metadata, nullCheckSql, textColumnSql } = target;
  const caseInsensitive = condition.caseInsensitive !== false;

  if (condition.operator === "is_null") return `${nullCheckSql} is null`;
  if (condition.operator === "is_not_null") return `${nullCheckSql} is not null`;
  if (condition.operator === "is_true") return `${columnSql} is true`;
  if (condition.operator === "is_false") return `${columnSql} is false`;

  if (condition.operator === "between") {
    const left = sqlValue(condition.value, metadata, params, useParameters);
    const right = sqlValue(condition.secondaryValue, metadata, params, useParameters);
    return `${columnSql} between ${left} and ${right}`;
  }

  if (condition.operator === "contains") {
    const operator = caseInsensitive ? "ilike" : "like";
    return `${textColumnSql} ${operator} ${sqlValue(`%${condition.value ?? ""}%`, metadata, params, useParameters, "text")}`;
  }

  if (condition.operator === "starts_with") {
    const operator = caseInsensitive ? "ilike" : "like";
    return `${textColumnSql} ${operator} ${sqlValue(`${condition.value ?? ""}%`, metadata, params, useParameters, "text")}`;
  }

  if (condition.operator === "in") {
    const values = String(condition.value ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!values.length) return "false";

    const targetSql = caseInsensitive && metadata.filter_kind === "text" ? `lower(${columnSql})` : columnSql;
    return `${targetSql} in (${values
      .map((value) => sqlValue(value, metadata, params, useParameters))
      .map((valueSql) => (caseInsensitive && metadata.filter_kind === "text" ? `lower(${valueSql})` : valueSql))
      .join(", ")})`;
  }

  const sqlOperator = {
    equals: "=",
    not_equals: "<>",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<="
  }[condition.operator];

  if (!sqlOperator) return "";
  if (isTextComparison(metadata.filter_kind, condition.operator) && caseInsensitive) {
    return `lower(${columnSql}) ${sqlOperator} lower(${sqlValue(condition.value, metadata, params, useParameters)})`;
  }

  return `${columnSql} ${sqlOperator} ${sqlValue(condition.value, metadata, params, useParameters)}`;
}

function buildFilterGroupSql(
  group: Pick<RuleFilterGroup, "combinator" | "conditions">,
  lookup: ColumnLookup,
  params: unknown[],
  useParameters: boolean,
  root: boolean
): string {
  const parts: string[] = group.conditions
    .map((item) => buildFilterItemSql(item, lookup, params, useParameters))
    .filter((part): part is string => Boolean(part));

  if (!parts.length) return root ? "true" : "";

  const combinator = group.combinator === "or" ? " or " : " and ";
  return `(${parts.join(combinator)})`;
}

function buildFilterItemSql(
  item: RuleFilterItem,
  lookup: ColumnLookup,
  params: unknown[],
  useParameters: boolean
): string {
  if ("conditions" in item) {
    return buildFilterGroupSql(item, lookup, params, useParameters, false);
  }

  return buildConditionSql(item, lookup, params, useParameters);
}

function resolveConditionTarget(condition: RuleCondition, lookup: ColumnLookup) {
  return resolveColumnTarget(condition.column, condition.jsonPath, condition.jsonValueKind, lookup);
}

function resolveSortableTarget(item: PublicationPrioritySortItem, lookup: ColumnLookup) {
  const target = resolveColumnTarget(item.column, item.jsonPath, item.jsonValueKind, lookup);
  if (!target || !isSortableKind(target.metadata.filter_kind)) return null;
  return target;
}

export function resolveRuleColumnTarget(
  columns: ColumnMetadata[],
  columnName: string,
  rawJsonPath: unknown,
  rawJsonValueKind: unknown,
  tableAlias = "b"
) {
  return resolveColumnTarget(columnName, rawJsonPath, rawJsonValueKind, createColumnLookup(columns), tableAlias);
}

function resolveColumnTarget(
  columnName: string,
  rawJsonPath: unknown,
  rawJsonValueKind: unknown,
  lookup: ColumnLookup,
  tableAlias = "b"
) {
  const baseMetadata = lookup.baseColumns.get(columnName);
  if (!baseMetadata) return null;

  const baseColumnSql = `${quoteIdentifier(tableAlias)}.${quoteIdentifier(baseMetadata.column_name)}`;
  const jsonPath = baseMetadata.filter_kind === "json" ? sanitizeJsonPath(rawJsonPath) : [];

  if (!jsonPath.length) {
    return {
      metadata: baseMetadata,
      columnSql: baseColumnSql,
      nullCheckSql: baseColumnSql,
      textColumnSql: baseMetadata.filter_kind === "json" ? `${baseColumnSql}::text` : baseColumnSql
    };
  }

  const filterKind =
    sanitizeJsonValueKind(rawJsonValueKind) ??
    lookup.jsonPathKinds.get(jsonPathKey(baseMetadata.column_name, jsonPath)) ??
    "text";
  const textJsonSql = `(${baseColumnSql} #>> ARRAY[${jsonPath.map(literal).join(", ")}])`;
  const jsonSql = `(${baseColumnSql} #> ARRAY[${jsonPath.map(literal).join(", ")}])`;
  const columnSql = jsonColumnSqlForKind(filterKind, textJsonSql, jsonSql);
  const metadata: ColumnMetadata = { ...baseMetadata, filter_kind: filterKind, json_path: jsonPath };

  return {
    metadata,
    columnSql,
    nullCheckSql: filterKind === "json" ? jsonSql : textJsonSql,
    textColumnSql: filterKind === "json" ? `${jsonSql}::text` : textJsonSql
  };
}

function isSortableKind(kind: ColumnMetadata["filter_kind"]) {
  return kind === "text" || kind === "number" || kind === "boolean" || kind === "datetime";
}

function isTextComparison(kind: ColumnMetadata["filter_kind"], operator: RuleOperator) {
  return kind === "text" && ["equals", "not_equals", "contains", "starts_with", "in"].includes(operator);
}

function jsonColumnSqlForKind(kind: ColumnMetadata["filter_kind"], textJsonSql: string, jsonSql: string) {
  if (kind === "number") {
    return `(case when ${textJsonSql} ~ '^-?[0-9]+([.][0-9]+)?$' then (${textJsonSql})::numeric end)`;
  }

  if (kind === "boolean") {
    return `(case when lower(${textJsonSql}) in ('true', 't', '1', 'yes', 'sim') then true when lower(${textJsonSql}) in ('false', 'f', '0', 'no', 'nao') then false end)`;
  }

  if (kind === "json") return jsonSql;
  return textJsonSql;
}

function sanitizeJsonPath(path: unknown): string[] {
  if (!Array.isArray(path)) return [];

  return path
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0 && part.length <= 120 && !part.includes("\u0000"))
    .slice(0, JSON_PATH_LIMIT);
}

function sanitizeJsonValueKind(kind: unknown): ColumnMetadata["filter_kind"] | null {
  return JSON_VALUE_KINDS.includes(kind as ColumnMetadata["filter_kind"]) ? (kind as ColumnMetadata["filter_kind"]) : null;
}

function jsonPathKey(columnName: string, path: string[]) {
  return `${columnName}\u001f${path.join("\u001f")}`;
}

function normalizeCrmCodeFilter(value: unknown) {
  if (value == null) return "";
  return String(value).trim();
}

function jsonFieldDisplayName(columnName: string, path: string[]) {
  return `${columnName}.${path.join(".")}`;
}

async function getJsonColumnFields(client: PoolClient, column: ColumnMetadata): Promise<ColumnMetadata[]> {
  const result = await client.query<{ json_path: string[]; filter_kind: ColumnMetadata["filter_kind"] }>(`
    with recursive sample(value) as (
      select ${quoteIdentifier(column.column_name)}::jsonb
      from public.base_imoveis
      where ${quoteIdentifier(column.column_name)} is not null
      limit ${JSON_FIELD_SAMPLE_LIMIT}
    ),
    walk(path, value) as (
      select array[]::text[], value
      from sample
      union all
      select walk.path || child.key, child.value
      from walk
      cross join lateral jsonb_each(case when jsonb_typeof(walk.value) = 'object' then walk.value else '{}'::jsonb end) as child(key, value)
      where coalesce(array_length(walk.path, 1), 0) < ${JSON_PATH_LIMIT}
    )
    select path as json_path,
      case
        when bool_or(jsonb_typeof(value) = 'number') and bool_and(jsonb_typeof(value) in ('number', 'null')) then 'number'
        when bool_or(jsonb_typeof(value) = 'boolean') and bool_and(jsonb_typeof(value) in ('boolean', 'null')) then 'boolean'
        when bool_or(jsonb_typeof(value) in ('object', 'array')) then 'json'
        else 'text'
      end as filter_kind
    from walk
    where coalesce(array_length(path, 1), 0) > 0
    group by path
    order by array_length(path, 1), array_to_string(path, '.')
    limit ${JSON_FIELD_LIMIT}
  `);

  return result.rows.map((row) => ({
    ...column,
    filter_kind: row.filter_kind,
    json_path: row.json_path,
    display_name: jsonFieldDisplayName(column.column_name, row.json_path)
  }));
}

function sqlValue(
  value: unknown,
  metadata: ColumnMetadata,
  params: unknown[],
  useParameters: boolean,
  forcedKind?: ColumnMetadata["filter_kind"]
) {
  const kind = forcedKind ?? metadata.filter_kind;
  const castValue = castFilterValue(value, kind);

  if (useParameters) {
    params.push(castValue);
    return `$${params.length}`;
  }

  return literal(castValue);
}

function castFilterValue(value: unknown, kind: ColumnMetadata["filter_kind"]) {
  if (kind === "number") {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : 0;
  }

  if (kind === "boolean") return value === true || value === "true";
  return value == null ? "" : String(value);
}

function literal(value: unknown) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return `'${String(value).replace(/'/g, "''")}'`;
}
