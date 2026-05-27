import type { PublicationRule } from "@/lib/types";
import { formatNumber } from "../_lib/number-format";
import { formatRuleDelta, ruleDeltaTone } from "../_lib/rule-list-utils";
import { MaterialIcon } from "./material-icon";

export function RuleCountCell({ rule }: { rule: PublicationRule }) {
  if (rule.use_ad_limit && rule.last_limited_count != null && rule.last_count != null) {
    const delta = rule.last_count - rule.last_limited_count;

    return (
      <span className="rule-count-cell">
        <span className="rule-count-main">
          <MaterialIcon name="lock" size={11} className="rule-count-lock" />
          <strong>{formatNumber(rule.last_limited_count)}</strong>
        </span>
        <span className="rule-count-total">/ {formatNumber(rule.last_count)}</span>
        <span className={`rule-count-delta ${ruleDeltaTone(delta)}`}>{formatRuleDelta(delta)}</span>
      </span>
    );
  }

  return <span className="rule-count-cell plain">{rule.last_count == null ? "-" : formatNumber(rule.last_count)}</span>;
}
