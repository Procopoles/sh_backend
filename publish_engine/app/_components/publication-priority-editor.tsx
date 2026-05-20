"use client";

import { useState } from "react";
import type { ColumnMetadata, PublicationPriority, PublicationPriorityItem, PublicationPrioritySortItem, RuleFilterGroup } from "@/lib/types";
import { formatNumber } from "../_lib/number-format";
import { cloneGroup, createDefaultGroup, fieldKey, fieldLabel, groupSummary, isFilterGroup, jsonPathParts } from "../_lib/rule-filter-utils";
import { ColumnPicker } from "./column-picker";
import { FilterGroupBuilder } from "./filter-group-builder";
import { MaterialIcon } from "./material-icon";

type PublicationPriorityEditorProps = {
  columns: ColumnMetadata[];
  value: PublicationPriority;
  onChange: (value: PublicationPriority) => void;
  readOnly?: boolean;
};

export function PublicationPriorityEditor({
  columns,
  value,
  onChange,
  readOnly = false
}: PublicationPriorityEditorProps) {
  const sortableColumns = columns.filter(isSortableColumn);
  const normalizedValue = value.filter((item): item is PublicationPriorityItem =>
    isFilterGroup(item) ? item.conditions.length > 0 : Boolean(columnForPriority(sortableColumns, item))
  );
  const [groupEditor, setGroupEditor] = useState<{ index: number; draft: RuleFilterGroup } | null>(null);

  function addPriority() {
    const column = sortableColumns[0];
    if (!column) return;
    onChange([...normalizedValue, createPriorityItem(column)]);
  }

  function addPriorityGroup() {
    if (!columns[0]) return;
    const draft = createDefaultGroup(columns);
    onChange([...normalizedValue, draft]);
    setGroupEditor({ index: normalizedValue.length, draft });
  }

  function updatePriority(index: number, item: PublicationPriorityItem) {
    onChange(normalizedValue.map((current, itemIndex) => (itemIndex === index ? item : current)));
  }

  function movePriority(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= normalizedValue.length) return;

    const next = [...normalizedValue];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    onChange(next);
  }

  function removePriority(index: number) {
    onChange(normalizedValue.filter((_, itemIndex) => itemIndex !== index));
  }

  function applyGroupEditor() {
    if (!groupEditor) return;
    if (!groupEditor.draft.conditions.length) {
      removePriority(groupEditor.index);
      setGroupEditor(null);
      return;
    }

    updatePriority(groupEditor.index, groupEditor.draft);
    setGroupEditor(null);
  }

  if (readOnly) {
    return (
      <div className="publication-priority-editor read-only">
        {normalizedValue.length ? (
          <div className="priority-list">
            {normalizedValue.map((item, index) => {
              if (isFilterGroup(item)) {
                return (
                  <div className="priority-row priority-view-row" key={`priority-group-${index}`}>
                    <span className="priority-rank">{formatNumber(index + 1)}</span>
                    <span>
                      <strong>{item.name?.trim() || "Grupo de prioridade"}</strong>
                      <small>{groupSummary(item)} - primeiro quem atender ao grupo</small>
                    </span>
                  </div>
                );
              }

              const column = columnForPriority(sortableColumns, item);
              return (
                <div className="priority-row priority-view-row" key={`${priorityFieldKey(item)}-${index}`}>
                  <span className="priority-rank">{formatNumber(index + 1)}</span>
                  <span>
                    <strong>{column ? fieldLabel(column) : item.column}</strong>
                    <small>{item.direction === "desc" ? "Decrescente" : "Crescente"} - vazios {item.nulls === "first" ? "no inicio" : "no fim"}</small>
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="empty-state compact-empty priority-empty">Sem prioridade definida.</div>
        )}
      </div>
    );
  }

  return (
    <div className="publication-priority-editor">
      <div className="priority-list">
        {normalizedValue.map((item, index) => {
          if (isFilterGroup(item)) {
            return (
              <div className="priority-item" key={`priority-group-${index}`}>
                <div className="priority-row priority-group-row">
                  <span className="priority-rank">{formatNumber(index + 1)}</span>
                  <span className="group-preview-icon">
                    <MaterialIcon name="account_tree" size={20} />
                  </span>
                  <span className="priority-group-copy">
                    <strong>{item.name?.trim() || "Grupo de prioridade"}</strong>
                    <small>{groupSummary(item)} - ordena como CASE WHEN</small>
                  </span>
                </div>
                <div className="priority-actions">
                  <button className="ghost-button compact-button" type="button" onClick={() => setGroupEditor({ index, draft: cloneGroup(item) })}>
                    <MaterialIcon name="edit" size={17} />
                    Editar
                  </button>
                  <button className="icon-button" type="button" title="Subir prioridade" onClick={() => movePriority(index, -1)} disabled={index === 0}>
                    <MaterialIcon name="keyboard_arrow_up" size={18} />
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    title="Descer prioridade"
                    onClick={() => movePriority(index, 1)}
                    disabled={index === normalizedValue.length - 1}
                  >
                    <MaterialIcon name="keyboard_arrow_down" size={18} />
                  </button>
                  <button className="icon-button danger-icon-button" type="button" title="Remover prioridade" onClick={() => removePriority(index)}>
                    <MaterialIcon name="delete" size={17} />
                  </button>
                </div>
              </div>
            );
          }

          const column = columnForPriority(sortableColumns, item);
          const selectableColumns =
            column && !sortableColumns.some((current) => fieldKey(current) === fieldKey(column))
              ? [...sortableColumns, column]
              : sortableColumns;

          return (
            <div className="priority-item" key={`${priorityFieldKey(item)}-${index}`}>
              <div className="priority-row">
                <span className="priority-rank">{formatNumber(index + 1)}</span>
                <ColumnPicker
                  columns={selectableColumns}
                  value={priorityFieldKey(item)}
                  onSelect={(nextColumn) => updatePriority(index, { ...createPriorityItem(nextColumn), direction: item.direction, nulls: item.nulls })}
                />
                <div className="segmented priority-direction" aria-label="Direcao da prioridade">
                  <button
                    className={item.direction === "asc" ? "selected" : ""}
                    type="button"
                    onClick={() => updatePriority(index, { ...item, direction: "asc" })}
                  >
                    Cresc.
                  </button>
                  <button
                    className={item.direction === "desc" ? "selected" : ""}
                    type="button"
                    onClick={() => updatePriority(index, { ...item, direction: "desc" })}
                  >
                    Decresc.
                  </button>
                </div>
                <select
                  value={item.nulls}
                  aria-label="Posicao dos vazios"
                  onChange={(event) => updatePriority(index, { ...item, nulls: event.target.value === "first" ? "first" : "last" })}
                >
                  <option value="last">Vazios no fim</option>
                  <option value="first">Vazios no inicio</option>
                </select>
              </div>
              <div className="priority-actions">
                <button className="icon-button" type="button" title="Subir prioridade" onClick={() => movePriority(index, -1)} disabled={index === 0}>
                  <MaterialIcon name="keyboard_arrow_up" size={18} />
                </button>
                <button
                  className="icon-button"
                  type="button"
                  title="Descer prioridade"
                  onClick={() => movePriority(index, 1)}
                  disabled={index === normalizedValue.length - 1}
                >
                  <MaterialIcon name="keyboard_arrow_down" size={18} />
                </button>
                <button className="icon-button danger-icon-button" type="button" title="Remover prioridade" onClick={() => removePriority(index)}>
                  <MaterialIcon name="delete" size={17} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {!normalizedValue.length && <div className="empty-state compact-empty priority-empty">Sem prioridade definida.</div>}

      <div className="priority-add-actions">
        <button className="secondary-button compact-button add-priority-button" type="button" onClick={addPriority} disabled={!sortableColumns[0]}>
          <MaterialIcon name="add" size={18} />
          Prioridade
        </button>
        <button className="secondary-button compact-button add-group-button" type="button" onClick={addPriorityGroup} disabled={!columns[0]}>
          <MaterialIcon name="account_tree" size={17} />
          Grupo de prioridade
        </button>
      </div>

      {groupEditor && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Editar grupo de prioridade">
          <section className="filter-modal">
            <div className="filter-modal-heading">
              <div>
                <h2>Editar grupo de prioridade</h2>
                <span>{groupSummary(groupEditor.draft)}</span>
              </div>
              <button className="icon-button" type="button" title="Fechar" onClick={() => setGroupEditor(null)}>
                <MaterialIcon name="close" size={17} />
              </button>
            </div>

            <label>
              Nome do grupo
              <input
                value={groupEditor.draft.name ?? ""}
                maxLength={80}
                placeholder="Grupo de prioridade"
                onChange={(event) =>
                  setGroupEditor((current) =>
                    current ? { ...current, draft: { ...current.draft, name: event.target.value } } : current
                  )
                }
              />
            </label>

            <FilterGroupBuilder
              columns={columns}
              group={groupEditor.draft}
              onChange={(draft) =>
                setGroupEditor((current) =>
                  current ? { ...current, draft: draft as RuleFilterGroup } : current
                )
              }
            />

            <div className="form-actions end filter-modal-actions">
              <button className="ghost-button" type="button" onClick={() => setGroupEditor(null)}>
                <MaterialIcon name="close" size={18} />
                Cancelar
              </button>
              <button className="primary-button" type="button" onClick={applyGroupEditor}>
                <MaterialIcon name="check" size={18} />
                Aplicar grupo
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export function publicationPrioritySummary(priority: PublicationPriority, columns: ColumnMetadata[]) {
  const sortableColumns = columns.filter(isSortableColumn);
  const count = priority.filter((item) => isFilterGroup(item) ? item.conditions.length > 0 : columnForPriority(sortableColumns, item)).length;
  if (!count) return "Ordenacao padrao da origem";
  return count === 1 ? "1 criterio de ordenacao" : `${formatNumber(count)} criterios de ordenacao`;
}

function createPriorityItem(column: ColumnMetadata): PublicationPrioritySortItem {
  const path = jsonPathParts(column.json_path);
  return {
    type: "sort",
    column: column.column_name,
    jsonPath: path.length ? path : null,
    jsonValueKind: path.length ? column.filter_kind : null,
    direction: "desc",
    nulls: "last"
  };
}

function columnForPriority(columns: ColumnMetadata[], item: PublicationPrioritySortItem) {
  const exact = columns.find((column) => fieldKey(column) === priorityFieldKey(item));
  if (exact) return exact;

  const path = jsonPathParts(item.jsonPath);
  const baseColumn = columns.find((column) => column.column_name === item.column && !jsonPathParts(column.json_path).length);
  if (baseColumn && path.length && isSortableKind(item.jsonValueKind ?? "text")) {
    return {
      ...baseColumn,
      filter_kind: item.jsonValueKind ?? "text",
      json_path: path,
      display_name: `${item.column}.${path.join(".")}`
    } satisfies ColumnMetadata;
  }

  return baseColumn;
}

function priorityFieldKey(item: Pick<PublicationPrioritySortItem, "column" | "jsonPath">) {
  return JSON.stringify([item.column, jsonPathParts(item.jsonPath)]);
}

function isSortableColumn(column: ColumnMetadata) {
  return isSortableKind(column.filter_kind);
}

function isSortableKind(kind: ColumnMetadata["filter_kind"] | null | undefined) {
  return kind === "text" || kind === "number" || kind === "boolean" || kind === "datetime";
}
