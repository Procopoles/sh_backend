import { Loader2 } from "lucide-react";
import type { PublishAutomation } from "@/lib/types";
import { formatNumber } from "../_lib/number-format";
import { formatTimestamp } from "../_lib/status-monitoring-utils";
import { MaterialIcon } from "./material-icon";

type AutomationDirectoryProps = {
  loading: boolean;
  automations: PublishAutomation[];
  selectedAutomationKey: string | null;
  onSelect: (automation: PublishAutomation) => void;
};

export function AutomationDirectory({
  loading,
  automations,
  selectedAutomationKey,
  onSelect
}: AutomationDirectoryProps) {
  return (
    <section className="automation-directory">
      <div className="portal-directory-heading">
        <div>
          <h2>Todas as automações</h2>
          <span>{formatNumber(automations.length)} na listagem</span>
        </div>
      </div>

      <div className="automation-table">
        <div className="automation-row header">
          <span>Automacao</span>
          <span>Base</span>
          <span>Modo</span>
          <span>Ultima execucao</span>
          <span>Status</span>
        </div>
        {loading ? (
          <div className="empty-state">
            <Loader2 className="spin" size={18} /> Carregando
          </div>
        ) : automations.length ? (
          automations.map((automation) => (
            <button
              className={`automation-row ${automation.key === selectedAutomationKey ? "selected" : ""}`}
              key={automation.key}
              type="button"
              onClick={() => onSelect(automation)}
            >
              <span className="portal-cell">
                <span className="portal-logo automation-node-icon">
                  <MaterialIcon name="bolt" size={18} />
                </span>
                <span>
                  <strong>{automation.name}</strong>
                  <small>{automation.description || automation.key}</small>
                </span>
              </span>
              <span>{`${automation.database_name}.${automation.schema_name}.${automation.table_name}`}</span>
              <span>{automation.run_mode === "trigger_db" ? "Trigger DB" : automation.run_mode}</span>
              <span>{automation.last_run_at ? formatTimestamp(automation.last_run_at) : "-"}</span>
              <span className={`status-pill ${automation.active ? "active" : "inactive"}`}>
                {automation.active ? "Ativa" : "Inativa"}
              </span>
            </button>
          ))
        ) : (
          <div className="empty-state">Nenhuma automacao encontrada.</div>
        )}
      </div>
    </section>
  );
}
