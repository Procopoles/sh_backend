import type { PublicationPriority, PublicationRule } from "@/lib/types";
import type { RuleTreeRow } from "./page-models";
import { formatNumber } from "./number-format";

export function formatRuleDelta(value: number) {
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value);
}

export function ruleDeltaTone(value: number) {
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "neutral";
}

export function buildRuleTreeRows(visibleRules: PublicationRule[]): RuleTreeRow[] {
  const ruleByViewName = new Map<string, PublicationRule>();
  for (const rule of visibleRules) {
    if (rule.view_name) ruleByViewName.set(rule.view_name, rule);
  }

  const childrenByParentId = new Map<number, PublicationRule[]>();
  const roots: PublicationRule[] = [];
  for (const rule of visibleRules) {
    const parent = rule.source_table ? ruleByViewName.get(rule.source_table) : undefined;
    if (parent && parent.id !== rule.id) {
      childrenByParentId.set(parent.id, [...(childrenByParentId.get(parent.id) ?? []), rule]);
    } else {
      roots.push(rule);
    }
  }

  const rows: RuleTreeRow[] = [];
  const visited = new Set<number>();
  const appendRule = (rule: PublicationRule, depth: number, parentRule?: PublicationRule) => {
    if (visited.has(rule.id)) return;
    visited.add(rule.id);
    rows.push({ rule, depth, parentRule });
    for (const child of childrenByParentId.get(rule.id) ?? []) {
      appendRule(child, depth + 1, rule);
    }
  };

  for (const root of roots) appendRule(root, 0);
  for (const rule of visibleRules) appendRule(rule, 0);

  return rows;
}

export function clonePublicationPriority(priority: PublicationPriority): PublicationPriority {
  return JSON.parse(JSON.stringify(priority)) as PublicationPriority;
}

export function prioritySignature(priority: PublicationPriority) {
  return JSON.stringify(priority);
}
