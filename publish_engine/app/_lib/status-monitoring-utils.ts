import type { Portal, PublicationRule } from "@/lib/types";
import type { StatusPortalGroup } from "./page-models";

export function formatTimestamp(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

export function ruleHealthTone(rule: PublicationRule) {
  if (rule.health_error) return "error";
  if (rule.health_pending_count == null || rule.health_unexpected_count == null) return "unknown";
  return rule.health_pending_count > 0 || rule.health_unexpected_count > 0 ? "warning" : "ok";
}

export function statusLabel(rule: PublicationRule) {
  if (rule.health_error) return "Erro";
  if (rule.health_pending_count == null || rule.health_unexpected_count == null) return "Pendente";
  return rule.health_pending_count > 0 || rule.health_unexpected_count > 0 ? "Divergente" : "OK";
}

export function groupStatusRules(visibleStatusRules: PublicationRule[], portalById: Map<number, Portal>): StatusPortalGroup[] {
  const groups = new Map<number, StatusPortalGroup>();

  for (const rule of visibleStatusRules) {
    if (rule.portal_id == null) continue;
    const currentGroup =
      groups.get(rule.portal_id) ??
      {
        portal: portalById.get(rule.portal_id) ?? null,
        portalId: rule.portal_id,
        rules: []
      };
    currentGroup.rules.push(rule);
    groups.set(rule.portal_id, currentGroup);
  }

  return Array.from(groups.values()).sort((left, right) => {
    const leftName = left.portal?.name ?? left.rules[0]?.portal_name ?? "";
    const rightName = right.portal?.name ?? right.rules[0]?.portal_name ?? "";
    return leftName.localeCompare(rightName, "pt-BR");
  });
}

function quoteSqlIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteSqlLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function statusAdTypeSlug(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function statusFinalViewName(portalSlug: string) {
  return `pc_${portalSlug}_final`;
}

export function buildStatusPublishedQuery(rule: PublicationRule) {
  if (!rule.portal_slug) return "Portal indisponivel para montar a query.";

  const finalViewName = statusFinalViewName(rule.portal_slug);
  const shouldFilterType = rule.use_ad_limit && Boolean(rule.ad_limit_type && rule.ad_limit_type !== "total");
  const typeFilter = shouldFilterType && rule.ad_limit_type
    ? `\n  AND b.ad_type_slug = ${quoteSqlLiteral(statusAdTypeSlug(rule.ad_limit_type))}`
    : "";

  return [
    "SELECT count(*)::int AS count",
    `FROM public.${quoteSqlIdentifier(finalViewName)} b`,
    `WHERE b.status = 'published'${typeFilter};`
  ].join("\n");
}

export function buildStatusUnexpectedQuery(rule: PublicationRule) {
  if (!rule.portal_slug) return "Portal indisponivel para montar a query.";

  const finalViewName = statusFinalViewName(rule.portal_slug);
  return `Publicados indevidos serao tratados fora de public.${quoteSqlIdentifier(finalViewName)}.`;
}
