import type {
  ColumnMetadata,
  PublicationPriority,
  PublicationPriorityItem,
  PublicationPrioritySortItem,
  RuleCondition,
  RuleFilterGroup,
  RuleFilterItem,
  RuleFilters,
  RuleSummaryCalculation,
  RuleSummaryConfigItem
} from "@/lib/types";
import { columnForCondition, fieldKey, isFilterGroup, jsonPathParts } from "./rule-filter-utils";

export function createDefaultRuleSummaryConfig(
  filters: RuleFilters,
  publicationPriority: PublicationPriority,
  columns: ColumnMetadata[]
): RuleSummaryConfigItem[] {
  const byKey = new Map(columns.map((column) => [fieldKey(column), column]));
  const result: RuleSummaryConfigItem[] = [];
  const seen = new Set<string>();

  for (const condition of collectFilterConditions(filters)) {
    const column = columnForCondition(columns, condition);
    if (!column) continue;
    appendSummaryColumn(result, seen, column);
  }

  for (const item of publicationPriority) {
    for (const column of collectPriorityColumns(item, byKey, columns)) {
      appendSummaryColumn(result, seen, column);
    }
  }

  return result.slice(0, 8);
}

export function createSummaryConfigItem(column: ColumnMetadata): RuleSummaryConfigItem {
  const path = jsonPathParts(column.json_path);
  return {
    column: column.column_name,
    jsonPath: path.length ? path : null,
    jsonValueKind: path.length ? column.filter_kind : null,
    calculation: defaultSummaryCalculation(column),
    groupCount: 5
  };
}

export function summaryConfigFieldKey(item: Pick<RuleSummaryConfigItem, "column" | "jsonPath">) {
  return JSON.stringify([item.column, jsonPathParts(item.jsonPath)]);
}

export function summaryColumnForConfig(columns: ColumnMetadata[], item: Pick<RuleSummaryConfigItem, "column" | "jsonPath" | "jsonValueKind">) {
  const exact = columns.find((column) => fieldKey(column) === summaryConfigFieldKey(item));
  if (exact) return exact;

  const path = jsonPathParts(item.jsonPath);
  const baseColumn = columns.find((column) => column.column_name === item.column && !jsonPathParts(column.json_path).length);
  if (baseColumn && path.length) {
    return {
      ...baseColumn,
      filter_kind: item.jsonValueKind ?? "text",
      json_path: path,
      display_name: `${item.column}.${path.join(".")}`
    } satisfies ColumnMetadata;
  }

  return baseColumn;
}

export function calculationMeta(calculation: RuleSummaryCalculation) {
  if (calculation === "range") return { label: "Min/Max", icon: "straighten", tone: "range" };
  if (calculation === "group") return { label: "Agrupar", icon: "donut_large", tone: "group" };
  return { label: "Contar", icon: "format_list_numbered", tone: "count" };
}

function appendSummaryColumn(result: RuleSummaryConfigItem[], seen: Set<string>, column: ColumnMetadata) {
  const key = fieldKey(column);
  if (seen.has(key) || column.filter_kind === "json" || column.filter_kind === "other") return;
  seen.add(key);
  result.push(createSummaryConfigItem(column));
}

function collectFilterConditions(group: Pick<RuleFilterGroup, "conditions">): RuleCondition[] {
  return group.conditions.flatMap((item: RuleFilterItem) => (isFilterGroup(item) ? collectFilterConditions(item) : [item]));
}

function collectPriorityColumns(
  item: PublicationPriorityItem,
  byKey: Map<string, ColumnMetadata>,
  columns: ColumnMetadata[]
): ColumnMetadata[] {
  if (isFilterGroup(item)) {
    return collectFilterConditions(item).flatMap((condition) => {
      const column = columnForCondition(columns, condition);
      return column ? [column] : [];
    });
  }

  const key = priorityFieldKey(item);
  const exact = byKey.get(key);
  if (exact) return [exact];

  const fallback = columns.find((column) => column.column_name === item.column && !jsonPathParts(column.json_path).length);
  return fallback ? [fallback] : [];
}

function priorityFieldKey(item: Pick<PublicationPrioritySortItem, "column" | "jsonPath">) {
  return JSON.stringify([item.column, jsonPathParts(item.jsonPath)]);
}

function defaultSummaryCalculation(column: ColumnMetadata): RuleSummaryCalculation {
  const dataType = (column.data_type || column.udt_name || "").toLowerCase();

  if (column.filter_kind === "text" || column.filter_kind === "boolean") return "count";
  if (column.filter_kind === "datetime") return "range";
  if (column.filter_kind === "number") {
    if (["smallint", "int2"].includes(dataType)) return "range";
    if (isValueDataType(dataType) && !isIdentifierColumn(column)) return "group";
    return "range";
  }

  return "count";
}

function isValueDataType(dataType: string) {
  return ["numeric", "decimal", "real", "double precision", "float4", "float8"].includes(dataType);
}

function isIdentifierColumn(column: ColumnMetadata) {
  const normalizedName = [column.column_name, column.display_name ?? ""]
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  return /(^|[^a-z0-9])(id|codigo|cod|crm|uuid)([^a-z0-9]|$)/.test(normalizedName);
}
