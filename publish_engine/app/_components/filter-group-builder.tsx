"use client";

import { Fragment, useState } from "react";
import type { ColumnMetadata, RuleFilterGroup, RuleFilterItem, RuleFilters } from "@/lib/types";
import { ConditionEditor } from "./condition-editor";
import { MaterialIcon } from "./material-icon";
import {
  createDefaultCondition,
  createDefaultGroup,
  groupSummary,
  isFilterGroup
} from "../_lib/rule-filter-utils";

type FilterGroupBuilderProps = {
  columns: ColumnMetadata[];
  group: RuleFilters | RuleFilterGroup;
  onChange: (group: RuleFilters | RuleFilterGroup) => void;
  depth?: number;
  onCreateGroup?: (parentPath: number[], insertIndex: number) => void;
  onEditGroup?: (path: number[]) => void;
  path?: number[];
  stackOnly?: boolean;
  readOnly?: boolean;
};

export function FilterGroupBuilder({
  columns,
  group,
  onChange,
  depth = 0,
  onCreateGroup,
  onEditGroup,
  path = [],
  stackOnly = false,
  readOnly = false
}: FilterGroupBuilderProps) {
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<Set<string>>(() => new Set());
  const relationLabel = group.combinator === "or" ? "OU" : "E";
  const isNamedGroup = "type" in group;

  const insertItem = (insertIndex: number, item: RuleFilterItem) => {
    const index = Math.max(0, Math.min(insertIndex, group.conditions.length));
    onChange({ ...group, conditions: [...group.conditions.slice(0, index), item, ...group.conditions.slice(index)] });
  };

  const addConditionAt = (insertIndex: number) => {
    if (!columns[0]) return;
    insertItem(insertIndex, createDefaultCondition(columns));
  };

  const addGroupAt = (insertIndex: number) => {
    if (!columns[0]) return;
    if (stackOnly) {
      onCreateGroup?.(path, insertIndex);
      return;
    }
    insertItem(insertIndex, createDefaultGroup(columns));
  };

  const updateItem = (index: number, item: RuleFilterItem) => {
    onChange({ ...group, conditions: group.conditions.map((current, itemIndex) => (itemIndex === index ? item : current)) });
  };

  const removeItem = (index: number) => {
    onChange({ ...group, conditions: group.conditions.filter((_, itemIndex) => itemIndex !== index) });
  };

  const duplicateItem = (index: number) => {
    const item = group.conditions[index];
    if (!item) return;
    insertItem(index + 1, JSON.parse(JSON.stringify(item)) as RuleFilterItem);
  };

  const toggleGroup = (groupKey: string) => {
    setExpandedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };

  return (
    <div className={`${depth ? "nested-filter-group" : "filter-builder"} ${readOnly ? "read-only" : ""}`}>
      {!readOnly && (
      <div className="filter-builder-toolbar">
        <div className="segmented relation-toggle" aria-label="Relacionamento dos filtros">
          <button
            type="button"
            className={group.combinator === "and" ? "selected" : ""}
            onClick={() => onChange({ ...group, combinator: "and" })}
          >
            E
          </button>
          <button
            type="button"
            className={group.combinator === "or" ? "selected" : ""}
            onClick={() => onChange({ ...group, combinator: "or" })}
          >
            OU
          </button>
        </div>
      </div>
      )}

      <div className="conditions-list modern">
        {group.conditions.map((item, index) => {
          const itemPath = [...path, index];
          const itemKey = itemPath.join(".") || String(index);
          const isExpanded = expandedGroupKeys.has(itemKey);

          return (
          <Fragment key={itemKey}>
            {index > 0 && <div className="relation-separator" aria-label={`Operador ${relationLabel}`}><span>{relationLabel}</span></div>}
            {isFilterGroup(item) ? (
              stackOnly ? (
              <div className="group-preview-item">
                <div className="group-preview">
                  <span className="group-preview-icon">
                    <MaterialIcon name="stacks" size={20} />
                  </span>
                  <span className="group-preview-copy">
                    <strong>{item.name?.trim() || "Grupo de filtros"}</strong>
                    <small>{groupSummary(item)}</small>
                  </span>
                </div>
                {!readOnly && (
                <div className="group-preview-actions">
                  <button className="ghost-button compact-button" type="button" onClick={() => onEditGroup?.([...path, index])}>
                    <MaterialIcon name="edit" size={17} />
                    Editar
                  </button>
                  <button className="secondary-button compact-button add-filter-button row-action-button" type="button" onClick={() => addConditionAt(index + 1)} disabled={!columns[0]}>
                    <MaterialIcon name="add_circle" size={17} />
                    + Filtro
                  </button>
                  <button className="secondary-button compact-button add-group-button row-action-button" type="button" onClick={() => addGroupAt(index + 1)} disabled={!columns[0]}>
                    <MaterialIcon name="stacks" size={17} />
                    Grupo
                  </button>
                  <button className="secondary-button compact-button duplicate-filter-button row-action-button" type="button" onClick={() => duplicateItem(index)}>
                    <MaterialIcon name="content_copy" size={16} />
                    Duplicar
                  </button>
                  <button className="filter-remove-button group-remove-button" type="button" title="Remover grupo" onClick={() => removeItem(index)}>
                    <MaterialIcon name="close" size={16} />
                  </button>
                </div>
                )}
              </div>
            ) : (
              <div className="nested-filter-item">
                <div className={`nested-filter-shell ${isExpanded ? "expanded" : "collapsed"}`}>
                  <div className="nested-filter-heading">
                    <span className="nested-filter-heading-copy">
                      <MaterialIcon name="stacks" size={17} />
                      <span>
                        <strong>{item.name?.trim() || "Grupo aninhado"}</strong>
                        <small>{groupSummary(item)}</small>
                      </span>
                    </span>
                    <button
                      className="icon-button nested-expand-button"
                      type="button"
                      title={isExpanded ? "Recolher grupo" : "Expandir grupo"}
                      aria-expanded={isExpanded}
                      onClick={() => toggleGroup(itemKey)}
                    >
                      <MaterialIcon name={isExpanded ? "keyboard_arrow_up" : "keyboard_arrow_down"} size={20} />
                    </button>
                  </div>
                  {isExpanded && (
                    <>
                    {!readOnly && (
                      <label className="nested-group-name-field">
                        <span>Nome do grupo</span>
                        <input
                          value={item.name ?? ""}
                          maxLength={80}
                          placeholder="Grupo aninhado"
                          onChange={(event) => updateItem(index, { ...item, name: event.target.value })}
                        />
                      </label>
                    )}
                    <FilterGroupBuilder
                      columns={columns}
                      group={item}
                      onChange={(nextGroup) => updateItem(index, nextGroup as RuleFilterGroup)}
                      depth={depth + 1}
                      path={itemPath}
                      readOnly={readOnly}
                    />
                    </>
                  )}
                </div>
                {!readOnly && (
                  <div className="nested-filter-actions">
                    <button className="secondary-button compact-button add-filter-button row-action-button" type="button" onClick={() => addConditionAt(index + 1)} disabled={!columns[0]}>
                      <MaterialIcon name="add_circle" size={17} />
                      + Filtro
                    </button>
                    <button className="secondary-button compact-button add-group-button row-action-button" type="button" onClick={() => addGroupAt(index + 1)} disabled={!columns[0]}>
                      <MaterialIcon name="stacks" size={17} />
                      Grupo
                    </button>
                    <button className="secondary-button compact-button duplicate-filter-button row-action-button" type="button" onClick={() => duplicateItem(index)}>
                      <MaterialIcon name="content_copy" size={16} />
                      Duplicar
                    </button>
                    <button className="filter-remove-button inline-remove-button" type="button" title="Remover grupo" onClick={() => removeItem(index)}>
                      <MaterialIcon name="close" size={16} />
                    </button>
                  </div>
                )}
              </div>
            )
          ) : (
            <ConditionEditor
              key={index}
              columns={columns}
              condition={item}
              onChange={(condition) => updateItem(index, condition)}
              onRemove={() => removeItem(index)}
              onAddConditionAfter={() => addConditionAt(index + 1)}
              onAddGroupAfter={() => addGroupAt(index + 1)}
              onDuplicate={isNamedGroup ? () => duplicateItem(index) : undefined}
              readOnly={readOnly}
            />
          )}
          </Fragment>
          );
        })}
        {!group.conditions.length && (
          <div className="empty-state compact-empty empty-filter-state">
            <span>Sem filtros.</span>
            {!readOnly && (
              <span className="empty-filter-actions">
                <button className="secondary-button compact-button add-filter-button row-action-button" type="button" onClick={() => addConditionAt(0)} disabled={!columns[0]}>
                  <MaterialIcon name="add_circle" size={17} />
                  + Filtro
                </button>
                <button className="secondary-button compact-button add-group-button row-action-button" type="button" onClick={() => addGroupAt(0)} disabled={!columns[0]}>
                  <MaterialIcon name="stacks" size={17} />
                  Grupo
                </button>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
