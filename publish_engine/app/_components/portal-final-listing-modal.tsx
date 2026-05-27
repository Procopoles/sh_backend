"use client";

import { Globe2, Loader2 } from "lucide-react";
import type { ColumnMetadata, Portal, RuleSummaryConfigItem, RuleSummaryResponse } from "@/lib/types";
import type { PreviewSortDirection, RuleRowsPreview } from "../_lib/page-models";
import { formatNumber } from "../_lib/number-format";
import { MaterialIcon } from "./material-icon";
import { RulePreviewRows } from "./rule-preview-rows";
import { RuleSummarySection } from "./rule-summary-section";

type PortalFinalListingModalProps = {
  portal: Portal;
  columns: ColumnMetadata[];
  summaryConfig: RuleSummaryConfigItem[];
  defaultSummaryConfig: RuleSummaryConfigItem[];
  summaryData: RuleSummaryResponse | null;
  summaryLoading: boolean;
  previewRows: RuleRowsPreview | null;
  previewRowsLimit: 10 | 100;
  previewRowsLoading: boolean;
  previewSortColumn: string;
  previewSortDirection: PreviewSortDirection;
  crmCode: string;
  refreshLoading: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onSummaryConfigChange: (config: RuleSummaryConfigItem[]) => void;
  onSummaryRefresh: () => void;
  onSortColumnChange: (sortColumn: string) => void;
  onSortDirectionChange: (sortDirection: PreviewSortDirection) => void;
  onLimitChange: (limit: 10 | 100) => void;
  onCrmCodeChange: (value: string) => void;
  onCrmCodeBlur: () => void;
  onPreview: () => void;
};

export function PortalFinalListingModal({
  portal,
  columns,
  summaryConfig,
  defaultSummaryConfig,
  summaryData,
  summaryLoading,
  previewRows,
  previewRowsLimit,
  previewRowsLoading,
  previewSortColumn,
  previewSortDirection,
  crmCode,
  refreshLoading,
  onClose,
  onRefresh,
  onSummaryConfigChange,
  onSummaryRefresh,
  onSortColumnChange,
  onSortDirectionChange,
  onLimitChange,
  onCrmCodeChange,
  onCrmCodeBlur,
  onPreview
}: PortalFinalListingModalProps) {
  return (
    <div className="modal-backdrop portal-final-backdrop" role="dialog" aria-modal="true" aria-label="Listagem final do portal">
      <section className="filter-modal portal-final-modal">
        <div className="filter-modal-heading portal-final-heading">
          <div className="portal-final-title">
            <span className="portal-logo portal-final-logo">
              {portal.logo_url ? <img src={portal.logo_url} alt="" /> : <Globe2 size={20} />}
            </span>
            <span>
              <h2>Listagem final</h2>
              <small>{portal.name} - pc_{portal.slug}_final</small>
            </span>
          </div>
          <div className="portal-final-actions">
            <button className="primary-button compact-button portal-final-refresh" type="button" onClick={onRefresh} disabled={refreshLoading}>
              {refreshLoading ? <Loader2 className="spin" size={16} /> : <MaterialIcon name="refresh" size={17} />}
              Atualizar listagem
            </button>
            <button className="icon-button" type="button" title="Fechar" onClick={onClose}>
              <MaterialIcon name="close" size={17} />
            </button>
          </div>
        </div>

        <div className="portal-final-content">
          <RuleSummarySection
            columns={columns}
            config={summaryConfig}
            defaultConfig={defaultSummaryConfig}
            data={summaryData}
            loading={summaryLoading}
            onConfigChange={onSummaryConfigChange}
            onRefresh={onSummaryRefresh}
          />

          <RulePreviewRows
            title="Linhas da listagem final"
            unloadedDescription="codigo_crm e dados finais"
            defaultSortLabel="Ordem da listagem"
            previewRows={previewRows}
            previewRowsLimit={previewRowsLimit}
            previewRowsLoading={previewRowsLoading}
            previewSortColumn={previewSortColumn}
            previewSortDirection={previewSortDirection}
            crmCode={crmCode}
            crmPlaceholder="Filtrar codigo CRM"
            onCrmCodeChange={onCrmCodeChange}
            onCrmCodeBlur={onCrmCodeBlur}
            onSortColumnChange={onSortColumnChange}
            onSortDirectionChange={onSortDirectionChange}
            onLimitChange={onLimitChange}
            onPreview={onPreview}
          />
        </div>

        <div className="portal-final-footer">
          <span>{formatNumber(previewRows?.rows.length ?? 0)} linha{previewRows?.rows.length === 1 ? "" : "s"} na pre visualizacao</span>
        </div>
      </section>
    </div>
  );
}
