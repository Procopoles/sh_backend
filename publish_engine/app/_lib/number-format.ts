const NUMBER_FORMATTER = new Intl.NumberFormat("pt-BR", {
  maximumFractionDigits: 20
});

export function formatNumber(value: unknown) {
  const numberValue = numericValue(value);
  return numberValue == null ? "-" : NUMBER_FORMATTER.format(numberValue);
}

export function formatOptionalNumber(value: unknown) {
  const numberValue = numericValue(value);
  return numberValue == null ? "" : NUMBER_FORMATTER.format(numberValue);
}

export function formatNumericInput(value: string | number | null | undefined) {
  if (value == null || value === "") return "";
  return formatOptionalNumber(value);
}

export function maskLocalizedNumberInput(value: string, options: { allowDecimal?: boolean; allowNegative?: boolean } = {}) {
  const { allowDecimal = true, allowNegative = true } = options;
  const trimmed = value.trim();
  const isNegative = allowNegative && trimmed.startsWith("-");
  const unsigned = trimmed.replace(/-/g, "");
  const commaIndex = allowDecimal ? unsigned.indexOf(",") : -1;
  const integerSource = commaIndex >= 0 ? unsigned.slice(0, commaIndex) : unsigned;
  const decimalSource = commaIndex >= 0 ? unsigned.slice(commaIndex + 1) : "";
  const integerDigits = integerSource.replace(/\D/g, "");
  const decimalDigits = decimalSource.replace(/\D/g, "");
  const integer = integerDigits ? formatIntegerDigits(integerDigits) : "";
  const sign = isNegative ? "-" : "";

  if (commaIndex >= 0) return `${sign}${integer},${decimalDigits}`;
  return `${sign}${integer}`;
}

export function localizedNumberToNormalized(value: string) {
  const masked = maskLocalizedNumberInput(value);
  if (!masked || masked === "-") return "";
  const normalized = masked.replace(/\./g, "").replace(",", ".");
  if (normalized.endsWith(".")) return normalized.slice(0, -1);
  const numberValue = Number(normalized);
  return Number.isFinite(numberValue) ? normalized : "";
}

export function localizedNumberToNumber(value: string) {
  const normalized = localizedNumberToNormalized(value);
  if (!normalized) return 0;
  const numberValue = Number(normalized);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

export function isNumericValue(value: unknown) {
  return numericValue(value) != null;
}

function numericValue(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const text = value.trim();
  if (!text || /^0\d+/.test(text)) return null;
  if (!/^-?\d+([.,]\d+)?$/.test(text)) return null;

  const numberValue = Number(text.replace(",", "."));
  return Number.isFinite(numberValue) ? numberValue : null;
}

function formatIntegerDigits(value: string) {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
