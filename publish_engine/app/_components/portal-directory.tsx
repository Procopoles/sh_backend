import { Globe2, Loader2 } from "lucide-react";
import type { Portal } from "@/lib/types";
import { formatNumber } from "../_lib/number-format";
import { MaterialIcon } from "./material-icon";

type PortalDirectoryProps = {
  loading: boolean;
  portals: Portal[];
  selectedPortalId: number | null;
  onSelect: (portal: Portal) => void;
  onEdit: (portal: Portal) => void;
};

export function PortalDirectory({ loading, portals, selectedPortalId, onSelect, onEdit }: PortalDirectoryProps) {
  return (
    <section className="portal-directory">
      <div className="portal-directory-heading">
        <div>
          <h2>Todos os portais</h2>
          <span>{formatNumber(portals.length)} na listagem</span>
        </div>
      </div>

      <div className="portal-table">
        <div className="portal-row header">
          <span>Portal</span>
          <span>Cotas</span>
          <span>Regras</span>
          <span>Status</span>
          <span></span>
        </div>
        {loading ? (
          <div className="empty-state">
            <Loader2 className="spin" size={18} /> Carregando
          </div>
        ) : portals.length ? (
          portals.map((portal) => (
            <button
              className={`portal-row ${portal.id === selectedPortalId ? "selected" : ""}`}
              key={portal.id}
              type="button"
              onClick={() => onSelect(portal)}
            >
              <span className="portal-cell">
                <span className="portal-logo">
                  {portal.logo_url ? <img src={portal.logo_url} alt="" /> : <Globe2 size={18} />}
                </span>
                <span>
                  <strong>{portal.name}</strong>
                  <small>{portal.description || "Sem descricao"}</small>
                </span>
              </span>
              <span>{formatNumber(portal.total_quota ?? 0)}</span>
              <span>{formatNumber(portal.rules_count ?? 0)}</span>
              <span className={`status-pill ${portal.active ? "active" : "inactive"}`}>
                {portal.active ? "Ativo" : "Inativo"}
              </span>
              <span
                className="row-action"
                onClick={(event) => {
                  event.stopPropagation();
                  onEdit(portal);
                }}
              >
                <MaterialIcon name="edit" size={17} />
                Editar
              </span>
            </button>
          ))
        ) : (
          <div className="empty-state">Nenhum portal encontrado.</div>
        )}
      </div>
    </section>
  );
}
