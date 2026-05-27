import type { Portal, PortalAdType } from "@/lib/types";
import type { PortalForm } from "./page-models";
import { formatNumber } from "./number-format";

export function displayValue(value: string | number | null | undefined) {
  if (typeof value === "number") return formatNumber(value);
  const text = String(value ?? "").trim();
  return text || "-";
}

export function adLimitTypeLabel(value: string | null | undefined, portal?: Portal | null) {
  if (value === "total" || !value) return "Total";
  return portal?.ad_types?.find((adType) => adType.slug === value)?.name ?? value;
}

export function ruleTotalQuota(portal?: Portal | null) {
  return (portal?.ad_types ?? []).reduce((total, adType) => total + (Number(adType.quantity) || 0), 0);
}

export function ruleAdLimitQuota(portal: Portal | null | undefined, adLimitType: string | null | undefined) {
  if (!portal) return 0;
  if (!adLimitType || adLimitType === "total") return ruleTotalQuota(portal);
  return portal.ad_types?.find((adType) => adType.slug === adLimitType)?.quantity ?? 0;
}

export function compareAdTypesByQuantity<T extends Pick<PortalAdType, "quantity" | "tier" | "name">>(left: T, right: T) {
  const quantityDelta = (Number(right.quantity) || 0) - (Number(left.quantity) || 0);
  if (quantityDelta !== 0) return quantityDelta;
  const tierDelta = (Number(left.tier) || 0) - (Number(right.tier) || 0);
  if (tierDelta !== 0) return tierDelta;
  return left.name.localeCompare(right.name, "pt-BR");
}

export function normalizeAdTier(value: number | string | null | undefined) {
  const tier = Math.trunc(Number(value) || 0);
  if (tier < 1) return 1;
  if (tier > 10) return 10;
  return tier;
}

export function nextAvailableAdTier(adTypes: PortalForm["ad_types"]) {
  const usedTiers = new Set(adTypes.map((adType) => normalizeAdTier(adType.tier)));
  for (let tier = 1; tier <= 10; tier += 1) {
    if (!usedTiers.has(tier)) return tier;
  }
  return 10;
}
