"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MaterialIcon } from "./material-icon";
import { formatNumber } from "../_lib/number-format";

export type SourceViewOption = {
  value: string;
  ruleName: string;
  viewName: string;
  groupId: string;
  groupLabel: string;
  groupDetail: string;
  groupIcon: string;
  badge: string;
  unavailable?: boolean;
};

type SourceViewPickerProps = {
  options: SourceViewOption[];
  value: string;
  onSelect: (value: string) => void;
};

export function SourceViewPicker({ options, value, onSelect }: SourceViewPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedOption = options.find((option) => option.value === value) ?? options[0] ?? null;

  useEffect(() => {
    if (!open) return;

    function closeOnOutsideClick(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [open]);

  const groups = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const visibleOptions = normalizedQuery
      ? options.filter((option) => sourceViewSearchText(option).includes(normalizedQuery))
      : options;
    const grouped = new Map<string, SourceViewOption[]>();

    for (const option of visibleOptions) {
      grouped.set(option.groupId, [...(grouped.get(option.groupId) ?? []), option]);
    }

    return Array.from(grouped.entries()).map(([groupId, groupOptions]) => ({
      id: groupId,
      label: groupOptions[0]?.groupLabel ?? "Views",
      detail: groupOptions[0]?.groupDetail ?? "Views disponiveis",
      icon: groupOptions[0]?.groupIcon ?? "schema",
      options: groupOptions
    }));
  }, [options, query]);

  function chooseOption(option: SourceViewOption) {
    onSelect(option.value);
    setOpen(false);
    setQuery("");
  }

  return (
    <div className={`column-picker source-view-picker ${open ? "open" : ""}`} ref={rootRef}>
      <button
        className="column-picker-trigger source-view-picker-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="column-picker-trigger-icon">
          <MaterialIcon name={selectedOption?.groupIcon ?? "schema"} size={18} />
        </span>
        <span className="column-picker-trigger-text">
          <strong>{selectedOption?.ruleName ?? "Selecione uma view"}</strong>
          <small>{selectedOption ? selectedOption.viewName : "View de origem"}</small>
        </span>
        <MaterialIcon name={open ? "keyboard_arrow_up" : "keyboard_arrow_down"} size={20} className="column-picker-chevron" />
      </button>

      {open && (
        <div className="column-picker-menu source-view-picker-menu" role="listbox" aria-label="Selecionar preset inicial">
          <div className="column-picker-search">
            <MaterialIcon name="search" size={17} />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false);
              }}
              placeholder="Buscar regra ou view"
            />
          </div>

          <div className="column-picker-groups">
            {groups.length ? (
              groups.map((group) => (
                <section className="column-picker-group source-view-picker-group" key={group.id}>
                  <div className="column-picker-group-heading">
                    <span className="column-picker-group-title">
                      <MaterialIcon name={group.icon} size={17} />
                      {group.label}
                    </span>
                    <span>{formatNumber(group.options.length)}</span>
                  </div>
                  <small>{group.detail}</small>
                  <div className="column-picker-options">
                    {group.options.map((option) => (
                      <button
                        className={`column-picker-option source-view-option ${option.value === value ? "selected" : ""}`}
                        key={option.value}
                        type="button"
                        role="option"
                        aria-selected={option.value === value}
                        onClick={() => chooseOption(option)}
                      >
                        <span>
                          <strong>{option.ruleName}</strong>
                          <small>{option.unavailable ? `${option.viewName} - indisponivel` : option.viewName}</small>
                        </span>
                        <span className="column-type-badge source-view-badge">{option.badge}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ))
            ) : (
              <div className="column-picker-empty">Nenhuma view encontrada.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function sourceViewSearchText(option: SourceViewOption) {
  return [option.ruleName, option.viewName, option.groupLabel, option.groupDetail, option.badge]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
