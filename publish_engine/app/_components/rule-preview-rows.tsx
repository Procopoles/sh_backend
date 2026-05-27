import { ArrowDownAZ, ArrowUpAZ, ListOrdered, Loader2 } from "lucide-react";
import type { PreviewSortDirection, RuleRowsPreview } from "../_lib/page-models";
import { PREVIEW_RULE_ORDER_COLUMN } from "../_lib/page-constants";
import { displayPreviewValue } from "../_lib/rule-preview-utils";
import { formatNumber } from "../_lib/number-format";
import { MaterialIcon } from "./material-icon";

type RulePreviewRowsProps = {
  previewRows: RuleRowsPreview | null;
  previewRowsLimit: 10 | 100;
  previewRowsLoading: boolean;
  previewSortColumn: string;
  previewSortDirection: PreviewSortDirection;
  onSortColumnChange: (sortColumn: string) => void;
  onSortDirectionChange: (sortDirection: PreviewSortDirection) => void;
  onLimitChange: (limit: 10 | 100) => void;
  onPreview: () => void;
};

export function RulePreviewRows({
  previewRows,
  previewRowsLimit,
  previewRowsLoading,
  previewSortColumn,
  previewSortDirection,
  onSortColumnChange,
  onSortDirectionChange,
  onLimitChange,
  onPreview
}: RulePreviewRowsProps) {
  return (
    <section className="preview-rows-card">
      <div className="preview-rows-heading">
        <div>
          <h3>Linhas do filtro</h3>
          <span>
            {previewRows
              ? `${formatNumber(previewRows.rows.length)} linha${previewRows.rows.length === 1 ? "" : "s"}`
              : "codigo_crm e campos filtrados"}
          </span>
        </div>
        <div className="preview-rows-actions">
          <div className="preview-sort-controls">
            <label className="preview-sort-select-wrap">
              <ListOrdered size={15} />
              <select
                aria-label="Coluna para ordenar a pre visualizacao"
                value={previewSortColumn}
                onChange={(event) => onSortColumnChange(event.target.value)}
                disabled={!previewRows?.columns.length}
              >
                <option value={PREVIEW_RULE_ORDER_COLUMN}>Ordem da regra</option>
                {previewRows?.columns.map((column) => (
                  <option key={column.key} value={column.key}>
                    {column.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              className={`preview-sort-direction ${previewSortDirection}`}
              type="button"
              aria-label={`Ordenar em ordem ${previewSortDirection === "asc" ? "crescente" : "decrescente"}`}
              title={`Ordem ${previewSortDirection === "asc" ? "crescente" : "decrescente"}`}
              disabled={previewRowsLoading}
              onClick={() => onSortDirectionChange(previewSortDirection === "asc" ? "desc" : "asc")}
            >
              {previewSortDirection === "asc" ? <ArrowUpAZ size={16} /> : <ArrowDownAZ size={16} />}
              <span>{previewSortDirection === "asc" ? "Asc" : "Desc"}</span>
            </button>
          </div>
          <div className="segmented preview-limit-toggle" aria-label="Quantidade de linhas">
            <button
              className={previewRowsLimit === 10 ? "selected" : ""}
              type="button"
              onClick={() => onLimitChange(10)}
            >
              {formatNumber(10)}
            </button>
            <button
              className={previewRowsLimit === 100 ? "selected" : ""}
              type="button"
              onClick={() => onLimitChange(100)}
            >
              {formatNumber(100)}
            </button>
          </div>
          <button className="secondary-button compact-button" type="button" onClick={onPreview} disabled={previewRowsLoading}>
            {previewRowsLoading ? <Loader2 className="spin" size={16} /> : <MaterialIcon name="table_rows" size={17} />}
            Pre visualizar
          </button>
        </div>
      </div>

      {previewRows ? (
        previewRows.rows.length ? (
          <div className="preview-rows-table-wrap">
            <table className="preview-rows-table">
              <thead>
                <tr>
                  {previewRows.columns.map((column) => (
                    <th key={column.key}>{column.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {previewRows.columns.map((column) => {
                      const value = displayPreviewValue(row[column.key], column);
                      return (
                        <td key={column.key} title={value}>
                          {value}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state compact-empty preview-rows-empty">Nenhuma linha encontrada.</div>
        )
      ) : (
        <div className="empty-state compact-empty preview-rows-empty">Pre visualize 10 ou 100 linhas.</div>
      )}
    </section>
  );
}
