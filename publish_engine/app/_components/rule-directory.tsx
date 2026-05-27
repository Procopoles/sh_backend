import { type CSSProperties } from "react";
import { Filter, Loader2 } from "lucide-react";
import type { Portal, PublicationRule } from "@/lib/types";
import type { RuleTreeRow } from "../_lib/page-models";
import { formatNumber } from "../_lib/number-format";
import { MaterialIcon } from "./material-icon";
import { RuleCountCell } from "./rule-count-cell";

type RuleDirectoryProps = {
  loading: boolean;
  rows: RuleTreeRow[];
  visibleRuleCount: number;
  selectedRuleId?: number;
  portalById: Map<number, Portal>;
  onSelect: (rule: PublicationRule) => void;
  onEdit: (rule: PublicationRule) => void;
};

export function RuleDirectory({
  loading,
  rows,
  visibleRuleCount,
  selectedRuleId,
  portalById,
  onSelect,
  onEdit
}: RuleDirectoryProps) {
  return (
    <section className="rule-directory">
      <div className="portal-directory-heading">
        <div>
          <h2>Todas as regras</h2>
          <span>{formatNumber(visibleRuleCount)} na listagem</span>
        </div>
      </div>

      <div className="rule-table">
        <div className="rule-row header">
          <span>Regra</span>
          <span>Portal</span>
          <span>Imoveis</span>
          <span>Status</span>
          <span></span>
        </div>
        {loading ? (
          <div className="empty-state">
            <Loader2 className="spin" size={18} /> Carregando
          </div>
        ) : rows.length ? (
          rows.map(({ rule, depth }) => {
            const portalLogoUrl = portalById.get(rule.portal_id ?? -1)?.logo_url ?? rule.portal_logo_url ?? "";

            return (
              <button
                className={`rule-row nested-rule-row ${depth > 0 ? "child-rule-row" : ""} ${rule.id === selectedRuleId ? "selected" : ""}`}
                key={rule.id}
                style={{ "--rule-indent": `${Math.min(depth, 6) * 24}px` } as CSSProperties}
                type="button"
                onClick={() => onSelect(rule)}
              >
                <span className="portal-cell rule-name-cell">
                  <span className="rule-tree-rail" aria-hidden="true" />
                  <span className={`portal-logo rule-node-icon ${depth > 0 ? "child" : ""}`}>
                    {portalLogoUrl ? (
                      <img src={portalLogoUrl} alt="" />
                    ) : depth > 0 ? (
                      <MaterialIcon name="account_tree" size={18} />
                    ) : (
                      <Filter size={18} />
                    )}
                  </span>
                  <span className="rule-title-copy">
                    <strong>{rule.name}</strong>
                    <small>{rule.description || "Sem descricao"}</small>
                  </span>
                </span>
                <span>{rule.portal_name ?? "Sem portal"}</span>
                <RuleCountCell rule={rule} />
                <span className={`status-pill ${rule.active ? "active" : "inactive"}`}>
                  {rule.active ? "Ativa" : "Inativa"}
                </span>
                <span
                  className="row-action"
                  onClick={(event) => {
                    event.stopPropagation();
                    onEdit(rule);
                  }}
                >
                  <MaterialIcon name="edit" size={17} />
                  Editar
                </span>
              </button>
            );
          })
        ) : (
          <div className="empty-state">Nenhuma regra encontrada.</div>
        )}
      </div>
    </section>
  );
}
