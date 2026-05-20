"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ColumnMetadata } from "@/lib/types";
import { MaterialIcon } from "./material-icon";
import { formatNumber } from "../_lib/number-format";
import { fieldKey, fieldLabel, jsonPathParts } from "../_lib/rule-filter-utils";

type ColumnPickerGroupId = "text" | "quantity" | "value" | "datetime" | "boolean" | "nested" | "json" | "other";

const COLUMN_PICKER_GROUPS: Array<{
  id: ColumnPickerGroupId;
  label: string;
  detail: string;
  icon: string;
}> = [
  { id: "text", label: "Texto", detail: "varchar, text e campos descritivos", icon: "notes" },
  { id: "quantity", label: "Quantidade", detail: "smallint, integer e contagens", icon: "tag" },
  { id: "value", label: "Valores", detail: "numeric, real e decimais", icon: "payments" },
  { id: "datetime", label: "Datas", detail: "date, timestamp e horarios", icon: "event" },
  { id: "boolean", label: "Booleanas", detail: "verdadeiro ou falso", icon: "toggle_on" },
  { id: "nested", label: "Aninhadas", detail: "campos extraidos de json/jsonb", icon: "schema" },
  { id: "json", label: "JSON bruto", detail: "objetos e arrays completos", icon: "data_object" },
  { id: "other", label: "Outras", detail: "tipos sem grupo especifico", icon: "category" }
];

type ColumnPickerProps = {
  columns: ColumnMetadata[];
  value: string;
  onSelect: (column: ColumnMetadata) => void;
};

export function ColumnPicker({ columns, value, onSelect }: ColumnPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedColumn = columns.find((item) => fieldKey(item) === value) ?? columns[0];
  const selectedPath = selectedColumn ? jsonPathParts(selectedColumn.json_path) : [];
  const selectedGroup = selectedColumn ? COLUMN_PICKER_GROUPS.find((group) => group.id === columnPickerGroupId(selectedColumn)) : null;

  useEffect(() => {
    if (!open) return;

    function closeOnOutsideClick(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  const groupedColumns = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const visibleColumns = normalizedQuery
      ? columns.filter((column) => columnSearchText(column).includes(normalizedQuery))
      : columns;

    return COLUMN_PICKER_GROUPS.map((group) => ({
      ...group,
      columns: visibleColumns.filter((column) => columnPickerGroupId(column) === group.id)
    })).filter((group) => group.columns.length > 0);
  }, [columns, query]);

  function chooseColumn(column: ColumnMetadata) {
    onSelect(column);
    setOpen(false);
    setQuery("");
  }

  return (
    <div className={`column-picker ${open ? "open" : ""}`} ref={rootRef}>
      <button
        className="column-picker-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="column-picker-trigger-icon">
          <MaterialIcon name={selectedGroup?.icon ?? "view_column"} size={18} />
        </span>
        <span className="column-picker-trigger-text">
          <strong>{selectedColumn ? fieldLabel(selectedColumn) : "Selecione uma coluna"}</strong>
          <small>
            {selectedGroup?.label ?? "Coluna"}{selectedPath.length ? ` - ${formatNumber(selectedPath.length)} nivel${selectedPath.length > 1 ? "s" : ""}` : ""}
          </small>
        </span>
        <MaterialIcon name={open ? "keyboard_arrow_up" : "keyboard_arrow_down"} size={20} className="column-picker-chevron" />
      </button>

      {open && (
        <div className="column-picker-menu" role="listbox" aria-label="Selecionar coluna">
          <div className="column-picker-search">
            <MaterialIcon name="search" size={17} />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false);
              }}
              placeholder="Buscar coluna"
            />
          </div>

          <div className="column-picker-groups">
            {groupedColumns.length ? (
              groupedColumns.map((group) => (
                <section className="column-picker-group" key={group.id}>
                  <div className="column-picker-group-heading">
                    <span className="column-picker-group-title">
                      <MaterialIcon name={group.icon} size={17} />
                      {group.label}
                    </span>
                    <span>{formatNumber(group.columns.length)}</span>
                  </div>
                  <small>{group.detail}</small>
                  <div className="column-picker-options">
                    {group.columns.map((column) => {
                      const key = fieldKey(column);
                      const path = jsonPathParts(column.json_path);
                      return (
                        <button
                          className={`column-picker-option ${key === value ? "selected" : ""}`}
                          key={key}
                          type="button"
                          role="option"
                          aria-selected={key === value}
                          onClick={() => chooseColumn(column)}
                        >
                          <span>
                            <strong>{fieldLabel(column)}</strong>
                            <small>{path.length ? `${column.column_name} -> ${path.join(" -> ")}` : column.column_name}</small>
                          </span>
                          <span className="column-type-badge">{columnTechnicalLabel(column)}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))
            ) : (
              <div className="column-picker-empty">Nenhuma coluna encontrada.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function columnPickerGroupId(column: ColumnMetadata): ColumnPickerGroupId {
  const dataType = (column.data_type || column.udt_name || "").toLowerCase();
  const path = jsonPathParts(column.json_path);

  if (path.length) return "nested";
  if (column.filter_kind === "text") return "text";
  if (column.filter_kind === "boolean") return "boolean";
  if (column.filter_kind === "datetime") return "datetime";
  if (column.filter_kind === "json") return "json";
  if (column.filter_kind === "number") {
    if (["smallint", "integer", "bigint", "int2", "int4", "int8"].includes(dataType)) return "quantity";
    return "value";
  }

  return "other";
}

function columnSearchText(column: ColumnMetadata) {
  return [fieldLabel(column), column.column_name, column.data_type, column.udt_name, column.filter_kind, jsonPathParts(column.json_path).join(".")]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function columnTechnicalLabel(column: ColumnMetadata) {
  const path = jsonPathParts(column.json_path);
  if (path.length) return column.filter_kind === "json" ? "jsonb" : column.filter_kind;
  return column.data_type || column.udt_name || column.filter_kind;
}
