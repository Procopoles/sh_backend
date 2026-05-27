import { Globe2, Loader2 } from "lucide-react";
import type { StatusPortalGroup } from "../_lib/page-models";
import { formatNumber } from "../_lib/number-format";
import { ruleHealthTone, statusLabel } from "../_lib/status-monitoring-utils";
import { MaterialIcon } from "./material-icon";

type StatusDirectoryProps = {
  loading: boolean;
  groups: StatusPortalGroup[];
  visibleRuleCount: number;
  selectedRuleId: number | null;
  onSelectRule: (ruleId: number) => void;
};

export function StatusDirectory({ loading, groups, visibleRuleCount, selectedRuleId, onSelectRule }: StatusDirectoryProps) {
  return (
    <section className="status-directory">
      <div className="portal-directory-heading">
        <div>
          <h2>Regras ativas</h2>
          <span>{formatNumber(visibleRuleCount)} monitoradas</span>
        </div>
      </div>

      <div className="status-portal-groups">
        {loading ? (
          <div className="empty-state">
            <Loader2 className="spin" size={18} /> Carregando
          </div>
        ) : groups.length ? (
          groups.map((group) => {
            const portalName = group.portal?.name ?? group.rules[0]?.portal_name ?? "Portal";
            const portalSlug = group.portal?.slug ?? group.rules[0]?.portal_slug ?? "";
            const errorCount = group.rules.filter((rule) => ruleHealthTone(rule) === "error").length;
            const warningCount = group.rules.filter((rule) => ruleHealthTone(rule) === "warning").length;
            const unknownCount = group.rules.filter((rule) => ruleHealthTone(rule) === "unknown").length;
            const pendingTotal = group.rules.reduce((total, rule) => total + (rule.health_pending_count ?? 0), 0);
            const unexpectedTotal = group.rules.reduce((total, rule) => total + (rule.health_unexpected_count ?? 0), 0);
            const groupTone = errorCount ? "error" : warningCount ? "warning" : unknownCount ? "unknown" : "ok";

            return (
              <section className={`status-portal-group ${groupTone}`} key={group.portalId}>
                <div className="status-portal-heading">
                  <span className="portal-logo status-portal-logo">
                    {group.portal?.logo_url ? <img src={group.portal.logo_url} alt="" /> : <Globe2 size={20} />}
                  </span>
                  <div className="status-portal-copy">
                    <h3>{portalName}</h3>
                    <span>{portalSlug || "Slug indisponivel"}</span>
                  </div>
                  <div className="status-portal-summary">
                    <span>
                      <small>Regras</small>
                      <strong>{formatNumber(group.rules.length)}</strong>
                    </span>
                    <span>
                      <small>Pendentes</small>
                      <strong>{formatNumber(pendingTotal)}</strong>
                    </span>
                    <span>
                      <small>Indevidos</small>
                      <strong>{formatNumber(unexpectedTotal)}</strong>
                    </span>
                    <span>
                      <small>Alertas</small>
                      <strong>{formatNumber(errorCount + warningCount + unknownCount)}</strong>
                    </span>
                  </div>
                </div>

                <div className="status-rule-list status-portal-rules">
                  {group.rules.map((rule) => {
                    const portalLogoUrl = group.portal?.logo_url ?? rule.portal_logo_url ?? "";

                    return (
                      <button
                        className={`status-rule-card ${ruleHealthTone(rule)} ${rule.id === selectedRuleId ? "selected" : ""}`}
                        key={rule.id}
                        type="button"
                        onClick={() => onSelectRule(rule.id)}
                      >
                        <span className="status-rule-main">
                          <span className="portal-logo rule-node-icon">
                            {portalLogoUrl ? (
                              <img src={portalLogoUrl} alt="" />
                            ) : (
                              <MaterialIcon name="monitor_heart" size={18} />
                            )}
                          </span>
                          <span>
                            <strong>{rule.name}</strong>
                            <small>{rule.view_name ?? "View indisponivel"}</small>
                          </span>
                        </span>
                        <span className="status-rule-metrics">
                          <span>
                            <small>Esperados</small>
                            <strong>{rule.health_expected_count == null ? "-" : formatNumber(rule.health_expected_count)}</strong>
                          </span>
                          <span>
                            <small>Publicados</small>
                            <strong>{rule.health_published_count == null ? "-" : formatNumber(rule.health_published_count)}</strong>
                          </span>
                          <span>
                            <small>Pendentes</small>
                            <strong>{rule.health_pending_count == null ? "-" : formatNumber(rule.health_pending_count)}</strong>
                          </span>
                          <span>
                            <small>Indevidos</small>
                            <strong>{rule.health_unexpected_count == null ? "-" : formatNumber(rule.health_unexpected_count)}</strong>
                          </span>
                        </span>
                        <span className={`healthcheck-badge ${ruleHealthTone(rule)}`}>{statusLabel(rule)}</span>
                        {rule.health_error && <span className="status-rule-error">{rule.health_error}</span>}
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })
        ) : (
          <div className="empty-state">Nenhuma regra ativa com portal vinculado encontrada.</div>
        )}
      </div>
    </section>
  );
}
