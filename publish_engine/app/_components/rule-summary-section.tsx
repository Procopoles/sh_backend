"use client";

import { useMemo, useState } from "react";
import type { ColumnMetadata, RuleSummaryCalculation, RuleSummaryConfigItem, RuleSummaryItemResult, RuleSummaryResponse } from "@/lib/types";
import { formatNumber, isNumericValue } from "../_lib/number-format";
import {
  calculationMeta,
  createSummaryConfigItem,
  summaryColumnForConfig,
  summaryConfigFieldKey
} from "../_lib/rule-summary-defaults";
import { fieldKey, fieldLabel } from "../_lib/rule-filter-utils";
import { ColumnPicker } from "./column-picker";
import { MaterialIcon } from "./material-icon";
import { NumericInput } from "./numeric-input";

type RuleSummarySectionProps = {
  columns: ColumnMetadata[];
  config: RuleSummaryConfigItem[];
  defaultConfig: RuleSummaryConfigItem[];
  data: RuleSummaryResponse | null;
  loading: boolean;
  onConfigChange: (config: RuleSummaryConfigItem[]) => void;
  onRefresh: () => void;
};

const CALCULATIONS: RuleSummaryCalculation[] = ["range", "count", "group"];

export function RuleSummarySection({
  columns,
  config,
  defaultConfig,
  data,
  loading,
  onConfigChange,
  onRefresh
}: RuleSummarySectionProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<RuleSummaryConfigItem[]>([]);
  const activeConfig = config;
  const summaryItems = useMemo(() => {
    const result = new Map<string, RuleSummaryItemResult>();
    for (const item of data?.items ?? []) {
      result.set(summaryResultKey(item), item);
    }
    return result;
  }, [data?.items]);
  const summaryItemsByField = useMemo(() => {
    const result = new Map<string, RuleSummaryItemResult>();
    for (const item of data?.items ?? []) {
      result.set(summaryResultFieldKey(item), item);
    }
    return result;
  }, [data?.items]);

  function openSettings() {
    setDraft(activeConfig);
    setSettingsOpen(true);
  }

  function applySettings() {
    onConfigChange(draft.filter((item) => summaryColumnForConfig(columns, item)));
    setSettingsOpen(false);
  }

  return (
    <section className="rule-summary-card">
      <div className="rule-summary-heading">
        <div>
          <h3>Resumo</h3>
          <span>{loading ? "Atualizando insights" : `${formatNumber(data?.total ?? 0)} imoveis na selecao final`}</span>
        </div>
        <div className="rule-summary-actions">
          <button className="icon-button summary-refresh-button" type="button" title="Atualizar resumo" onClick={onRefresh} disabled={loading}>
            {loading ? <MaterialIcon name="progress_activity" size={17} className="spin" /> : <MaterialIcon name="refresh" size={17} />}
          </button>
          <button
            className="icon-button summary-settings-button"
            type="button"
            title="Configurar resumo"
            aria-label="Configurar resumo"
            onClick={openSettings}
          >
            <MaterialIcon name="settings" size={17} />
          </button>
        </div>
      </div>

      <div className="rule-summary-total">
        <span className="rule-summary-total-icon">
          <MaterialIcon name="home_work" size={22} />
        </span>
        <span>
          <small>Dentro da view final</small>
          <strong>{data ? formatNumber(data.total) : "-"}</strong>
        </span>
      </div>

      {activeConfig.length ? (
        <div className="rule-summary-grid">
          {activeConfig.map((item, index) => {
            const column = summaryColumnForConfig(columns, item);
            const result = summaryItems.get(summaryConfigResultKey(item)) ?? summaryItemsByField.get(summaryConfigFieldKey(item));
            return (
              <SummaryMetric
                key={`${summaryConfigFieldKey(item)}-${item.calculation}-${index}`}
                columnLabel={column ? fieldLabel(column) : item.column}
                config={item}
                result={result}
                loading={loading}
              />
            );
          })}
        </div>
      ) : (
        <div className="empty-state compact-empty summary-empty">Adicione colunas para montar o resumo.</div>
      )}

      {settingsOpen && (
        <SummarySettingsModal
          columns={columns}
          draft={draft}
          onChange={setDraft}
          onClose={() => setSettingsOpen(false)}
          onApply={applySettings}
          onUseDefault={() => setDraft(defaultConfig)}
        />
      )}
    </section>
  );
}

function SummaryMetric({
  columnLabel,
  config,
  result,
  loading
}: {
  columnLabel: string;
  config: RuleSummaryConfigItem;
  result?: RuleSummaryItemResult;
  loading: boolean;
}) {
  const meta = calculationMeta(config.calculation);

  return (
    <article className={`summary-metric-card ${meta.tone}`}>
      <div className="summary-metric-heading">
        <span className={`summary-type-icon ${meta.tone}`}>
          <MaterialIcon name={meta.icon} size={18} />
        </span>
        <span>
          <strong>{columnLabel}</strong>
          <small>{meta.label}</small>
        </span>
      </div>

      {loading && !result ? (
        <div className="summary-skeleton" />
      ) : result?.calculation === "range" ? (
        <div className="summary-range-grid">
          <span>
            <small>Min</small>
            <strong>{displaySummaryValue(result.min)}</strong>
          </span>
          <span>
            <small>Max</small>
            <strong>{displaySummaryValue(result.max)}</strong>
          </span>
        </div>
      ) : result?.calculation === "count" ? (
        <SummaryCountList result={result} />
      ) : result?.calculation === "group" ? (
        <div className="summary-group-list">
          {result.groups.length ? (
            result.groups.map((group, index) => {
              const groupLabel = displaySummaryGroupLabel(group);
              return (
                <div className="summary-group-row" key={`${group.label}-${index}`}>
                  <span className="summary-group-label" title={groupLabel}>{groupLabel}</span>
                  <span className="summary-group-track" aria-hidden="true">
                    <span style={{ width: `${summaryPercent(group.count, result.total_count)}%` }} />
                  </span>
                  <span className="summary-group-count">{formatNumber(group.count)}</span>
                </div>
              );
            })
          ) : (
            <span className="summary-muted-line">Sem valores para agrupar.</span>
          )}
        </div>
      ) : (
        <div className="summary-skeleton muted">Sem dados.</div>
      )}
    </article>
  );
}

function SummaryCountList({ result }: { result: Extract<RuleSummaryItemResult, { calculation: "count" }> }) {
  const values = result.values ?? [];
  const hiddenValues = Math.max(0, result.distinct_count - values.length);

  return (
    <div className="summary-value-list">
      {values.length ? (
        values.map((value, index) => (
          <div className="summary-value-row" key={`${value.label}-${index}`}>
            <span className="summary-value-label" title={displaySummaryValue(value.label)}>{displaySummaryValue(value.label)}</span>
            <span className="summary-value-track" aria-hidden="true">
              <span style={{ width: `${summaryPercent(value.count, result.total_count)}%` }} />
            </span>
            <span className="summary-value-count">{formatNumber(value.count)}</span>
          </div>
        ))
      ) : (
        <span className="summary-muted-line">Sem valores para contar.</span>
      )}
      {hiddenValues > 0 && (
        <span className="summary-more-line">
          + {formatNumber(hiddenValues)} {hiddenValues === 1 ? "valor nao exibido" : "valores nao exibidos"}
        </span>
      )}
    </div>
  );
}

function SummarySettingsModal({
  columns,
  draft,
  onChange,
  onClose,
  onApply,
  onUseDefault
}: {
  columns: ColumnMetadata[];
  draft: RuleSummaryConfigItem[];
  onChange: (draft: RuleSummaryConfigItem[]) => void;
  onClose: () => void;
  onApply: () => void;
  onUseDefault: () => void;
}) {
  function addItem() {
    const selected = new Set(draft.map(summaryConfigFieldKey));
    const nextColumn = columns.find((column) => !selected.has(summaryConfigFieldKey(createSummaryConfigItem(column)))) ?? columns[0];
    if (!nextColumn) return;
    onChange([...draft, createSummaryConfigItem(nextColumn)]);
  }

  function updateItem(index: number, item: RuleSummaryConfigItem) {
    onChange(draft.map((current, itemIndex) => (itemIndex === index ? item : current)));
  }

  function removeItem(index: number) {
    onChange(draft.filter((_, itemIndex) => itemIndex !== index));
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Configurar resumo">
      <section className="filter-modal summary-settings-modal">
        <div className="filter-modal-heading">
          <div>
            <h2>Resumo / insights</h2>
            <span>{formatNumber(draft.length)} coluna{draft.length === 1 ? "" : "s"} no stack</span>
          </div>
          <button className="icon-button" type="button" title="Fechar" onClick={onClose}>
            <MaterialIcon name="close" size={17} />
          </button>
        </div>

        <div className="summary-config-stack">
          {draft.map((item, index) => {
            const column = summaryColumnForConfig(columns, item) ?? columns[0];
            const value = column ? fieldKey(column) : summaryConfigFieldKey(item);
            return (
              <div className="summary-config-row" key={`${summaryConfigFieldKey(item)}-${index}`}>
                <span className="summary-config-rank">{formatNumber(index + 1)}</span>
                <ColumnPicker
                  columns={columns}
                  value={value}
                  onSelect={(nextColumn) =>
                    updateItem(index, {
                      ...createSummaryConfigItem(nextColumn),
                      calculation: item.calculation,
                      groupCount: item.groupCount ?? 5
                    })
                  }
                />
                <div className="summary-calculation-options" aria-label="Tipo de calculo">
                  {CALCULATIONS.map((calculation) => {
                    const meta = calculationMeta(calculation);
                    return (
                      <button
                        className={`summary-calculation-chip ${meta.tone} ${item.calculation === calculation ? "selected" : ""}`}
                        key={calculation}
                        type="button"
                        onClick={() => updateItem(index, { ...item, calculation })}
                      >
                        <MaterialIcon name={meta.icon} size={16} />
                        {meta.label}
                      </button>
                    );
                  })}
                </div>
                {item.calculation === "group" ? (
                  <label className="summary-group-count-field">
                    Grupos
                    <NumericInput
                      allowDecimal={false}
                      allowNegative={false}
                      value={item.groupCount ?? 5}
                      onValueChange={(value) => updateItem(index, { ...item, groupCount: Number(value) || 5 })}
                    />
                  </label>
                ) : (
                  <span className="summary-group-count-placeholder" />
                )}
                <button className="icon-button danger-icon-button" type="button" title="Remover coluna" onClick={() => removeItem(index)}>
                  <MaterialIcon name="delete" size={17} />
                </button>
              </div>
            );
          })}

          {!draft.length && <div className="empty-state compact-empty summary-empty">Nenhuma coluna configurada.</div>}
        </div>

        <div className="summary-settings-actions">
          <button className="secondary-button compact-button" type="button" onClick={addItem} disabled={!columns[0]}>
            <MaterialIcon name="add" size={18} />
            Coluna
          </button>
          <button className="ghost-button compact-button" type="button" onClick={onUseDefault}>
            <MaterialIcon name="auto_awesome" size={17} />
            Padrao da regra
          </button>
        </div>

        <div className="form-actions end filter-modal-actions">
          <button className="ghost-button" type="button" onClick={onClose}>
            <MaterialIcon name="close" size={18} />
            Cancelar
          </button>
          <button className="primary-button" type="button" onClick={onApply}>
            <MaterialIcon name="check" size={18} />
            Aplicar
          </button>
        </div>
      </section>
    </div>
  );
}

function summaryResultKey(item: RuleSummaryItemResult) {
  return JSON.stringify([item.column, item.jsonPath ?? null, item.calculation]);
}

function summaryResultFieldKey(item: RuleSummaryItemResult) {
  return JSON.stringify([item.column, item.jsonPath ?? null]);
}

function summaryConfigResultKey(item: RuleSummaryConfigItem) {
  return JSON.stringify([item.column, item.jsonPath ?? null, item.calculation]);
}

function displaySummaryValue(value: string | number | null | undefined) {
  if (value == null || value === "") return "-";
  if (isNumericValue(value)) return formatNumber(value);
  return String(value);
}

function displaySummaryGroupLabel(group: { label: string; min?: string | null; max?: string | null }) {
  if (group.min == null && group.max == null) return displaySummaryValue(group.label);
  const min = displaySummaryValue(group.min);
  const max = displaySummaryValue(group.max);
  if (min === max) return min;
  return `${min} ate ${max}`;
}

function summaryPercent(value: number, total: number) {
  if (!total) return 0;
  return Math.max(2, Math.min(100, Math.round((value / total) * 100)));
}
