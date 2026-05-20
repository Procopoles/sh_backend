import type {
  ColumnMetadata,
  RuleCondition,
  RuleFilterGroup,
  RuleFilterItem,
  RuleFilters,
  RuleOperator
} from "@/lib/types";
import { formatNumber } from "./number-format";

export const OPERATOR_LABEL: Record<RuleOperator, string> = {
  equals: "Igual a",
  not_equals: "Diferente de",
  contains: "Contem",
  starts_with: "Comeca com",
  in: "Esta na lista",
  gt: "Maior que",
  gte: "Maior ou igual a",
  lt: "Menor que",
  lte: "Menor ou igual a",
  between: "Esta entre",
  is_true: "Verdadeiro",
  is_false: "Falso",
  is_null: "Esta vazio",
  is_not_null: "Esta preenchido"
};

export function operatorsFor(column?: ColumnMetadata): RuleOperator[] {
  if (!column) return ["equals"];
  if (column.filter_kind === "boolean") return ["is_true", "is_false", "is_null", "is_not_null"];
  if (column.filter_kind === "number" || column.filter_kind === "datetime") {
    return ["equals", "not_equals", "gt", "gte", "lt", "lte", "between", "is_null", "is_not_null"];
  }
  if (column.filter_kind === "json") return ["contains", "is_null", "is_not_null"];
  return ["equals", "not_equals", "contains", "starts_with", "in", "is_null", "is_not_null"];
}

export function jsonPathParts(path: ColumnMetadata["json_path"] | RuleCondition["jsonPath"]) {
  return Array.isArray(path) ? path.filter((part): part is string => typeof part === "string" && part.length > 0) : [];
}

export function fieldKey(column: Pick<ColumnMetadata, "column_name" | "json_path">) {
  return JSON.stringify([column.column_name, jsonPathParts(column.json_path)]);
}

export function conditionFieldKey(condition: RuleCondition) {
  return JSON.stringify([condition.column, jsonPathParts(condition.jsonPath)]);
}

export function fieldLabel(column: ColumnMetadata) {
  return column.display_name ?? (jsonPathParts(column.json_path).length ? `${column.column_name}.${jsonPathParts(column.json_path).join(".")}` : column.column_name);
}

export function createConditionFromColumn(column?: ColumnMetadata): RuleCondition {
  const path = jsonPathParts(column?.json_path);
  return {
    column: column?.column_name ?? "",
    jsonPath: path.length ? path : null,
    jsonValueKind: path.length ? column?.filter_kind ?? "text" : null,
    operator: operatorsFor(column)[0],
    value: "",
    secondaryValue: null,
    caseInsensitive: column?.filter_kind === "text"
  };
}

export function columnForCondition(columns: ColumnMetadata[], condition: RuleCondition) {
  const exact = columns.find((item) => fieldKey(item) === conditionFieldKey(condition));
  if (exact) return exact;

  const baseColumn = columns.find((item) => item.column_name === condition.column && !jsonPathParts(item.json_path).length);
  const conditionPath = jsonPathParts(condition.jsonPath);
  if (baseColumn?.filter_kind === "json" && conditionPath.length) {
    return {
      ...baseColumn,
      filter_kind: condition.jsonValueKind ?? "text",
      json_path: conditionPath,
      display_name: `${condition.column}.${conditionPath.join(".")}`
    } satisfies ColumnMetadata;
  }

  return baseColumn ?? columns[0];
}

export function isFilterGroup(item: unknown): item is RuleFilterGroup {
  return Boolean(item && typeof item === "object" && "conditions" in item);
}

export function createDefaultCondition(columns: ColumnMetadata[]): RuleCondition {
  return createConditionFromColumn(columns[0]);
}

export function createDefaultGroup(columns: ColumnMetadata[]): RuleFilterGroup {
  return {
    type: "group",
    name: "",
    combinator: "and",
    conditions: columns[0] ? [createDefaultCondition(columns)] : []
  };
}

export function cloneGroup(group: RuleFilterGroup): RuleFilterGroup {
  return JSON.parse(JSON.stringify(group)) as RuleFilterGroup;
}

function countFilterItems(group: Pick<RuleFilterGroup, "conditions">): { filters: number; groups: number } {
  return group.conditions.reduce(
    (total, item) => {
      if (isFilterGroup(item)) {
        const nested = countFilterItems(item);
        return { filters: total.filters + nested.filters, groups: total.groups + nested.groups + 1 };
      }

      return { ...total, filters: total.filters + 1 };
    },
    { filters: 0, groups: 0 }
  );
}

export function groupSummary(group: RuleFilterGroup | RuleFilters) {
  const count = countFilterItems(group);
  const relation = group.combinator === "or" ? "OU" : "E";
  const filterLabel = count.filters === 1 ? "1 filtro" : `${formatNumber(count.filters)} filtros`;
  const groupLabel = count.groups ? `, ${formatNumber(count.groups)} ${count.groups === 1 ? "grupo" : "grupos"}` : "";
  return `${filterLabel}${groupLabel} com ${relation}`;
}

export function conditionValueLabel(condition: RuleCondition) {
  if (["is_null", "is_not_null", "is_true", "is_false"].includes(condition.operator)) return "";
  if (condition.operator === "between") {
    return `${String(condition.value ?? "")} e ${String(condition.secondaryValue ?? "")}`.trim();
  }
  return String(condition.value ?? "");
}

export function getGroupAtPath(filters: RuleFilters, path: number[]): RuleFilterGroup | null {
  let current: RuleFilters | RuleFilterGroup = filters;
  for (const index of path) {
    const next: RuleFilterItem | undefined = current.conditions[index];
    if (!next || !isFilterGroup(next)) return null;
    current = next;
  }
  return current === filters ? null : (current as RuleFilterGroup);
}

export function replaceGroupAtPath(filters: RuleFilters, path: number[], replacement: RuleFilterGroup): RuleFilters {
  if (!path.length) return filters;

  const replaceInGroup = (group: RuleFilters | RuleFilterGroup, depth: number): RuleFilterItem[] =>
    group.conditions.map((item, index) => {
      if (index !== path[depth]) return item;
      if (depth === path.length - 1) return replacement;
      if (!isFilterGroup(item)) return item;
      return { ...item, conditions: replaceInGroup(item, depth + 1) };
    });

  return { ...filters, conditions: replaceInGroup(filters, 0) };
}

export function insertItemAtPath(filters: RuleFilters, path: number[], insertIndex: number, itemToInsert: RuleFilterItem): RuleFilters {
  const insertInto = (items: RuleFilterItem[]) => {
    const index = Math.max(0, Math.min(insertIndex, items.length));
    return [...items.slice(0, index), itemToInsert, ...items.slice(index)];
  };

  if (!path.length) return { ...filters, conditions: insertInto(filters.conditions) };

  const insertInGroup = (group: RuleFilters | RuleFilterGroup, depth: number): RuleFilterItem[] =>
    group.conditions.map((item, index) => {
      if (index !== path[depth]) return item;
      if (!isFilterGroup(item)) return item;
      if (depth === path.length - 1) return { ...item, conditions: insertInto(item.conditions) };
      return { ...item, conditions: insertInGroup(item, depth + 1) };
    });

  return { ...filters, conditions: insertInGroup(filters, 0) };
}
