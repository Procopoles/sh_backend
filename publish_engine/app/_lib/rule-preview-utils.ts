import type { RuleRowsPreview } from "./page-models";
import { formatNumber, isNumericValue } from "./number-format";

export function displayPreviewValue(value: unknown, column?: RuleRowsPreview["columns"][number]) {
  if (value == null) return "-";
  if (value instanceof Date) return value.toLocaleString("pt-BR");
  if (column && isIdentifierPreviewColumn(column) && ["number", "string", "bigint", "boolean"].includes(typeof value)) return String(value);
  if (typeof value === "number" || isNumericValue(value)) return formatNumber(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function isIdentifierPreviewColumn(column: RuleRowsPreview["columns"][number]) {
  return [column.key, column.label].some((name) => {
    const normalizedName = name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();

    return /(^|[^a-z0-9])(id|codigo|cod|crm|uuid)([^a-z0-9]|$)/.test(normalizedName);
  });
}
