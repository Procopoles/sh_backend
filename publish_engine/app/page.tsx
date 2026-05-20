"use client";

import { Filter, Globe2, Image, Loader2, Search } from "lucide-react";
import { ChangeEvent, CSSProperties, FormEvent, useEffect, useMemo, useState } from "react";
import "./page.css";
import { FilterGroupBuilder } from "./_components/filter-group-builder";
import { MaterialIcon } from "./_components/material-icon";
import { NumericInput } from "./_components/numeric-input";
import { PublicationPriorityEditor, publicationPrioritySummary } from "./_components/publication-priority-editor";
import { formatNumber, isNumericValue, localizedNumberToNumber } from "./_lib/number-format";
import { EMPTY_FILTERS, EMPTY_PORTAL, EMPTY_PUBLICATION_PRIORITY, type ActiveView, type MetadataResponse, type PanelMode, type PortalForm, type RuleForm } from "./_lib/page-models";
import {
  cloneGroup,
  createDefaultGroup,
  getGroupAtPath,
  groupSummary,
  insertItemAtPath,
  replaceGroupAtPath
} from "./_lib/rule-filter-utils";
import { buildAdLimitSql, buildRuleSelectSql, sanitizeFilters, sanitizePublicationPriority } from "@/lib/rules";
import type { Portal, PortalAdType, PublicationPriority, PublicationRule, RuleFilterGroup, RuleFilters } from "@/lib/types";

type RuleRowsPreview = {
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, unknown>>;
};

type RulePreview = {
  count: number;
  limited_count?: number | null;
};

type RuleTreeRow = {
  rule: PublicationRule;
  depth: number;
  parentRule?: PublicationRule;
};

function displayValue(value: string | number | null | undefined) {
  if (typeof value === "number") return formatNumber(value);
  const text = String(value ?? "").trim();
  return text || "-";
}

function adLimitTypeLabel(value: string | null | undefined) {
  return value === "total" || !value ? "Total" : value;
}

function ruleTotalQuota(portal?: Portal | null) {
  return (portal?.ad_types ?? []).reduce((total, adType) => total + (Number(adType.quantity) || 0), 0);
}

function ruleAdLimitQuota(portal: Portal | null | undefined, adLimitType: string | null | undefined) {
  if (!portal) return 0;
  if (!adLimitType || adLimitType === "total") return ruleTotalQuota(portal);
  return portal.ad_types?.find((adType) => adType.name === adLimitType)?.quantity ?? 0;
}

function formatRuleDelta(value: number) {
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value);
}

function ruleDeltaTone(value: number) {
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "neutral";
}

function RuleCountCell({ rule }: { rule: PublicationRule }) {
  if (rule.use_ad_limit && rule.last_limited_count != null && rule.last_count != null) {
    const delta = rule.last_count - rule.last_limited_count;

    return (
      <span className="rule-count-cell">
        <span className="rule-count-main">
          <MaterialIcon name="lock" size={11} className="rule-count-lock" />
          <strong>{formatNumber(rule.last_limited_count)}</strong>
        </span>
        <span className="rule-count-total">/ {formatNumber(rule.last_count)}</span>
        <span className={`rule-count-delta ${ruleDeltaTone(delta)}`}>{formatRuleDelta(delta)}</span>
      </span>
    );
  }

  return <span className="rule-count-cell plain">{rule.last_count == null ? "-" : formatNumber(rule.last_count)}</span>;
}

function displayPreviewValue(value: unknown, column?: RuleRowsPreview["columns"][number]) {
  if (value == null) return "-";
  if (value instanceof Date) return value.toLocaleString("pt-BR");
  if (column && isIdentifierPreviewColumn(column) && ["number", "string", "bigint", "boolean"].includes(typeof value)) return String(value);
  if (typeof value === "number" || isNumericValue(value)) return formatNumber(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function isIdentifierPreviewColumn(column: RuleRowsPreview["columns"][number]) {
  return [column.key, column.label].some((name) => {
    const normalizedName = name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();

    return /(^|[^a-z0-9])(id|codigo|cod|crm|uuid)([^a-z0-9]|$)/.test(normalizedName);
  });
}

function buildRuleTreeRows(visibleRules: PublicationRule[]): RuleTreeRow[] {
  const ruleByViewName = new Map<string, PublicationRule>();
  for (const rule of visibleRules) {
    if (rule.view_name) ruleByViewName.set(rule.view_name, rule);
  }

  const childrenByParentId = new Map<number, PublicationRule[]>();
  const roots: PublicationRule[] = [];
  for (const rule of visibleRules) {
    const parent = rule.source_table ? ruleByViewName.get(rule.source_table) : undefined;
    if (parent && parent.id !== rule.id) {
      childrenByParentId.set(parent.id, [...(childrenByParentId.get(parent.id) ?? []), rule]);
    } else {
      roots.push(rule);
    }
  }

  const rows: RuleTreeRow[] = [];
  const visited = new Set<number>();
  const appendRule = (rule: PublicationRule, depth: number, parentRule?: PublicationRule) => {
    if (visited.has(rule.id)) return;
    visited.add(rule.id);
    rows.push({ rule, depth, parentRule });
    for (const child of childrenByParentId.get(rule.id) ?? []) {
      appendRule(child, depth + 1, rule);
    }
  };

  for (const root of roots) appendRule(root, 0);
  for (const rule of visibleRules) appendRule(rule, 0);

  return rows;
}

function clonePublicationPriority(priority: PublicationPriority): PublicationPriority {
  return JSON.parse(JSON.stringify(priority)) as PublicationPriority;
}

function prioritySignature(priority: PublicationPriority) {
  return JSON.stringify(priority);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Falha na requisicao.");
  return data;
}

export default function Home() {
  const [portals, setPortals] = useState<Portal[]>([]);
  const [rules, setRules] = useState<PublicationRule[]>([]);
  const [metadata, setMetadata] = useState<MetadataResponse | null>(null);
  const [activeView, setActiveView] = useState<ActiveView>("portals");
  const [selectedPortalId, setSelectedPortalId] = useState<number | null>(null);
  const [portalMode, setPortalMode] = useState<PanelMode>("view");
  const [portalForm, setPortalForm] = useState<PortalForm>(EMPTY_PORTAL);
  const [ruleForm, setRuleForm] = useState<RuleForm | null>(null);
  const [ruleMode, setRuleMode] = useState<PanelMode>("view");
  const [query, setQuery] = useState("");
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewLimitedCount, setPreviewLimitedCount] = useState<number | null>(null);
  const [previewRowsLimit, setPreviewRowsLimit] = useState<10 | 100>(10);
  const [previewRows, setPreviewRows] = useState<RuleRowsPreview | null>(null);
  const [previewRowsLoading, setPreviewRowsLoading] = useState(false);
  const [queryPanelOpen, setQueryPanelOpen] = useState(false);
  const [queryCopied, setQueryCopied] = useState(false);
  const [viewNameCopied, setViewNameCopied] = useState(false);
  const [detailsPanelCollapsed, setDetailsPanelCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groupEditor, setGroupEditor] = useState<{
    mode: "create" | "edit";
    path: number[];
    insertIndex?: number;
    draft: RuleFilterGroup;
  } | null>(null);

  const filterableColumns = useMemo(
    () => metadata?.columns.filter((column) => column.filter_kind !== "other") ?? [],
    [metadata]
  );

  const portalFormTotal = portalForm.ad_types.reduce((total, adType) => total + (Number(adType.quantity) || 0), 0);
  const isPortalEditing = portalMode === "edit" || !portalForm.id;
  const isRuleEditing = ruleMode === "edit" || !ruleForm?.id;
  const visiblePortals = portals.filter((portal) =>
    `${portal.name} ${portal.description ?? ""}`.toLowerCase().includes(query.toLowerCase())
  );
  const visibleRules = rules.filter((rule) =>
    `${rule.name} ${rule.description ?? ""} ${rule.portal_name ?? ""} ${rule.view_name ?? ""} ${rule.source_table ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase())
  );
  const ruleTreeRows = useMemo(() => buildRuleTreeRows(visibleRules), [visibleRules]);
  const selectedPortalRules = rules.filter((rule) => rule.portal_id != null && rule.portal_id === selectedPortalId);
  const selectedRulePortal = portals.find((portal) => portal.id === ruleForm?.portal_id) ?? null;
  const ruleByViewName = useMemo(
    () =>
      new Map(
        rules
          .filter((rule) => rule.view_name)
          .map((rule) => [rule.view_name!, rule])
      ),
    [rules]
  );
  const selectedPresetRule = ruleForm?.source_table ? ruleByViewName.get(ruleForm.source_table) : undefined;
  const inheritedPriorityPresetName = useMemo(() => {
    if (!ruleForm || !selectedPresetRule?.publication_priority?.length || !filterableColumns.length) return null;

    const currentPriority = sanitizePublicationPriority(ruleForm.publication_priority, filterableColumns);
    const presetPriority = sanitizePublicationPriority(selectedPresetRule.publication_priority, filterableColumns);
    if (!currentPriority.length || !presetPriority.length) return null;
    return prioritySignature(currentPriority) === prioritySignature(presetPriority) ? selectedPresetRule.name : null;
  }, [filterableColumns, ruleForm, selectedPresetRule]);
  const adLimitOptions = useMemo(() => {
    if (!selectedRulePortal) return [];
    return [
      { value: "total", label: `Total (${formatNumber(ruleTotalQuota(selectedRulePortal))})` },
      ...(selectedRulePortal.ad_types ?? []).map((adType) => ({
        value: adType.name,
        label: `${adType.name} (${formatNumber(adType.quantity || 0)})`
      }))
    ];
  }, [selectedRulePortal]);
  const currentAdLimitType = adLimitOptions.some((option) => option.value === ruleForm?.ad_limit_type)
    ? ruleForm?.ad_limit_type ?? "total"
    : "total";
  const currentAdLimitQuota = ruleForm?.use_ad_limit ? ruleAdLimitQuota(selectedRulePortal, currentAdLimitType) : null;
  const ruleSourceOptions = useMemo(() => {
    const currentRuleViewName = rules.find((rule) => rule.id === ruleForm?.id)?.view_name;
    const options = [
      { value: "base_imoveis", label: "Base principal" },
      ...(metadata?.source_views ?? [])
        .filter((view) => view.view_name !== currentRuleViewName)
        .map((view) => {
          const rule = ruleByViewName.get(view.view_name);
          return {
            value: view.view_name,
            label: rule ? `${rule.name} (${view.view_name})` : view.view_name
          };
        })
    ];

    if (ruleForm?.source_table && !options.some((option) => option.value === ruleForm.source_table)) {
      options.push({ value: ruleForm.source_table, label: `${ruleForm.source_table} (indisponivel)` });
    }

    return options;
  }, [metadata?.source_views, ruleByViewName, rules, ruleForm?.id, ruleForm?.source_table]);

  const currentRuleQuery = useMemo(() => {
    if (!ruleForm) return "";
    if (!filterableColumns.length) return "Metadados de colunas indisponiveis.";

    try {
      const filters = sanitizeFilters(ruleForm.filters, filterableColumns);
      const publicationPriority = sanitizePublicationPriority(ruleForm.publication_priority, filterableColumns);
      const limitSql = ruleForm.use_ad_limit ? buildAdLimitSql(ruleForm.portal_id, currentAdLimitType) : null;
      return buildRuleSelectSql(
        ruleForm.source_table,
        filters,
        filterableColumns,
        ruleForm.include_locked,
        ruleForm.active,
        undefined,
        publicationPriority,
        limitSql
      );
    } catch (currentError) {
      return currentError instanceof Error ? currentError.message : "Nao foi possivel montar a query.";
    }
  }, [currentAdLimitType, filterableColumns, ruleForm]);

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    setQueryCopied(false);
  }, [currentRuleQuery, queryPanelOpen]);

  useEffect(() => {
    setViewNameCopied(false);
  }, [ruleForm?.view_name]);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [portalData, ruleData, metadataData] = await Promise.all([
        fetchJson<{ portals: Portal[] }>("/api/portals"),
        fetchJson<{ rules: PublicationRule[] }>("/api/rules"),
        fetchJson<MetadataResponse>("/api/metadata")
      ]);
      setPortals(portalData.portals);
      setRules(ruleData.rules);
      setMetadata(metadataData);

      const nextPortal = portalData.portals.find((portal) => portal.id === selectedPortalId) ?? portalData.portals[0];
      setSelectedPortalId((current) => current ?? nextPortal?.id ?? null);
      if (!portalForm.id && nextPortal) {
        editPortal(nextPortal);
        setPortalMode("view");
      }
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : "Erro ao carregar dados.");
    } finally {
      setLoading(false);
    }
  }

  function resetRuleForm(portalId: number | null = null) {
    setPreviewCount(null);
    setPreviewLimitedCount(null);
    setPreviewRows(null);
    setRuleMode("edit");
    setRuleForm({
      portal_id: portalId,
      name: "",
      description: "",
      source_table: "base_imoveis",
      view_name: null,
      active: true,
      include_locked: true,
      use_ad_limit: false,
      ad_limit_type: "total",
      filters: EMPTY_FILTERS,
      publication_priority: EMPTY_PUBLICATION_PRIORITY
    });
  }

  function editPortal(portal: Portal) {
    setPortalForm({
      id: portal.id,
      name: portal.name,
      description: portal.description ?? "",
      logo_url: portal.logo_url ?? null,
      active: portal.active,
      ad_types: (portal.ad_types ?? []).map((adType) => ({
        name: adType.name,
        quantity: adType.quantity
      }))
    });
  }

  function newPortal() {
    setActiveView("portals");
    setPortalForm(EMPTY_PORTAL);
    setPortalMode("edit");
    setSelectedPortalId(null);
    setRuleForm(null);
    setPreviewCount(null);
    setPreviewLimitedCount(null);
    setPreviewRows(null);
  }

  function selectPortal(portal: Portal, mode: PanelMode = "view") {
    setActiveView("portals");
    setSelectedPortalId(portal.id);
    editPortal(portal);
    setPortalMode(mode);
  }

  function openRulesView() {
    setActiveView("rules");
    if (!ruleForm) {
      if (rules[0]) editRule(rules[0], "view");
      else resetRuleForm(null);
    }
  }

  function newRule() {
    setActiveView("rules");
    resetRuleForm(null);
  }

  function priorityFromPresetSource(sourceTable: string, availableRules: PublicationRule[] = rules) {
    const presetRule = availableRules.find((rule) => rule.view_name === sourceTable);
    return presetRule ? clonePublicationPriority(presetRule.publication_priority ?? EMPTY_PUBLICATION_PRIORITY) : null;
  }

  function updateRuleSource(sourceTable: string) {
    if (!ruleForm) return;
    const presetPriority = priorityFromPresetSource(sourceTable);
    setRuleForm({
      ...ruleForm,
      source_table: sourceTable,
      publication_priority: presetPriority ?? ruleForm.publication_priority
    });
  }

  function updatePortalLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Selecione um arquivo de imagem para a logo.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => setPortalForm((current) => ({ ...current, logo_url: String(reader.result) }));
    reader.onerror = () => setError("Nao foi possivel carregar a imagem.");
    reader.readAsDataURL(file);
  }

  function updatePortalAdType(index: number, patch: Partial<Pick<PortalAdType, "name" | "quantity">>) {
    const adTypes = [...portalForm.ad_types];
    adTypes[index] = { ...adTypes[index], ...patch };
    setPortalForm({ ...portalForm, ad_types: adTypes });
  }

  function addPortalAdType() {
    setPortalForm({
      ...portalForm,
      ad_types: [...portalForm.ad_types, { name: "", quantity: 0 }]
    });
  }

  async function savePortal(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      let savedPortal: Portal | null = null;
      if (portalForm.id) {
        const result = await fetchJson<{ portal: Portal }>(`/api/portals/${portalForm.id}`, {
          method: "PUT",
          body: JSON.stringify(portalForm)
        });
        savedPortal = result.portal;
      } else {
        const result = await fetchJson<{ portal: Portal }>("/api/portals", {
          method: "POST",
          body: JSON.stringify(portalForm)
        });
        savedPortal = result.portal;
      }

      await loadAll();
      if (savedPortal) {
        setSelectedPortalId(savedPortal.id);
        editPortal(savedPortal);
        setPortalMode("view");
      }
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : "Erro ao salvar portal.");
    } finally {
      setSaving(false);
    }
  }

  async function removePortal(id: number) {
    if (!confirm("Excluir este portal e suas views de regras?")) return;
    setSaving(true);
    setError(null);
    try {
      await fetchJson(`/api/portals/${id}`, { method: "DELETE" });
      setSelectedPortalId(null);
      setPortalForm(EMPTY_PORTAL);
      setPortalMode("view");
      setRuleForm(null);
      setPreviewLimitedCount(null);
      await loadAll();
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : "Erro ao excluir portal.");
    } finally {
      setSaving(false);
    }
  }

  async function saveRule(event: FormEvent) {
    event.preventDefault();
    if (!ruleForm) return;
    setSaving(true);
    setError(null);
    try {
      let savedRule: PublicationRule | null = null;
      const payload = { ...ruleForm, ad_limit_type: ruleForm.use_ad_limit ? currentAdLimitType : null };
      if (ruleForm.id) {
        const result = await fetchJson<{ rule: PublicationRule }>(`/api/rules/${ruleForm.id}`, {
          method: "PUT",
          body: JSON.stringify(payload)
        });
        savedRule = result.rule;
      } else {
        const result = await fetchJson<{ rule: PublicationRule }>("/api/rules", {
          method: "POST",
          body: JSON.stringify(payload)
        });
        savedRule = result.rule;
      }
      await loadAll();
      if (savedRule) editRule(savedRule, "view");
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : "Erro ao salvar regra.");
    } finally {
      setSaving(false);
    }
  }

  async function removeRule(id: number) {
    if (!confirm("Excluir esta regra e remover sua view?")) return;
    setSaving(true);
    setError(null);
    try {
      await fetchJson(`/api/rules/${id}`, { method: "DELETE" });
      resetRuleForm(null);
      await loadAll();
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : "Erro ao excluir regra.");
    } finally {
      setSaving(false);
    }
  }

  async function previewRule() {
    if (!ruleForm) return;
    setSaving(true);
    setError(null);
    try {
      const result = await fetchJson<RulePreview>("/api/rules/preview", {
        method: "POST",
        body: JSON.stringify({ ...ruleForm, ad_limit_type: currentAdLimitType })
      });
      setPreviewCount(result.count);
      setPreviewLimitedCount(result.limited_count ?? null);
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : "Erro na previa.");
    } finally {
      setSaving(false);
    }
  }

  async function previewRuleRows() {
    if (!ruleForm) return;
    setPreviewRowsLoading(true);
    setError(null);
    try {
      const result = await fetchJson<RuleRowsPreview>("/api/rules/preview/rows", {
        method: "POST",
        body: JSON.stringify({ ...ruleForm, ad_limit_type: currentAdLimitType, limit: previewRowsLimit })
      });
      setPreviewRows(result);
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : "Erro na pre visualizacao.");
    } finally {
      setPreviewRowsLoading(false);
    }
  }

  async function copyCurrentRuleQuery() {
    if (!currentRuleQuery) return;
    try {
      await navigator.clipboard.writeText(currentRuleQuery);
      setQueryCopied(true);
    } catch {
      setError("Nao foi possivel copiar a query.");
    }
  }

  async function copyRuleViewName() {
    const viewName = ruleForm?.view_name?.trim();
    if (!viewName) return;
    try {
      await navigator.clipboard.writeText(viewName);
      setViewNameCopied(true);
    } catch {
      setError("Nao foi possivel copiar o slug da view.");
    }
  }

  function editRule(rule: PublicationRule, mode: PanelMode = "view") {
    const savedPriority = rule.publication_priority ?? EMPTY_PUBLICATION_PRIORITY;
    const presetPriority = savedPriority.length ? null : priorityFromPresetSource(rule.source_table ?? "base_imoveis");
    setPreviewCount(rule.last_count);
    setPreviewLimitedCount(rule.last_limited_count);
    setPreviewRows(null);
    setRuleMode(mode);
    setRuleForm({
      id: rule.id,
      portal_id: rule.portal_id,
      name: rule.name,
      description: rule.description ?? "",
      source_table: rule.source_table ?? "base_imoveis",
      view_name: rule.view_name,
      active: rule.active,
      include_locked: rule.include_locked,
      use_ad_limit: rule.use_ad_limit ?? false,
      ad_limit_type: rule.ad_limit_type ?? "total",
      filters: rule.filters ?? EMPTY_FILTERS,
      publication_priority: savedPriority.length ? savedPriority : presetPriority ?? EMPTY_PUBLICATION_PRIORITY
    });
  }

  function returnToPortalView() {
    if (portalForm.id) {
      const savedPortal = portals.find((portal) => portal.id === portalForm.id);
      if (savedPortal) editPortal(savedPortal);
    }
    setPortalMode("view");
  }

  function returnToRuleView() {
    if (ruleForm?.id) {
      const savedRule = rules.find((rule) => rule.id === ruleForm.id);
      if (savedRule) editRule(savedRule, "view");
      else setRuleMode("view");
    }
    setGroupEditor(null);
  }

  function openCreateGroup(parentPath: number[] = [], insertIndex = ruleForm?.filters.conditions.length ?? 0) {
    if (!ruleForm || !filterableColumns[0]) return;
    setGroupEditor({ mode: "create", path: parentPath, insertIndex, draft: createDefaultGroup(filterableColumns) });
  }

  function openEditGroup(path: number[]) {
    if (!ruleForm) return;
    const group = getGroupAtPath(ruleForm.filters, path);
    if (!group) return;
    setGroupEditor({ mode: "edit", path, draft: cloneGroup(group) });
  }

  function applyGroupEditor() {
    if (!ruleForm || !groupEditor) return;
    const nextFilters =
      groupEditor.mode === "create"
        ? insertItemAtPath(ruleForm.filters, groupEditor.path, groupEditor.insertIndex ?? ruleForm.filters.conditions.length, groupEditor.draft)
        : replaceGroupAtPath(ruleForm.filters, groupEditor.path, groupEditor.draft);

    setRuleForm({ ...ruleForm, filters: nextFilters });
    setGroupEditor(null);
  }

  return (
    <main className={`app-shell ${detailsPanelCollapsed ? "details-panel-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-logo" src="/brand/sh-gerenciamento.png" alt="SH Gerenciamento" />
        </div>

        <nav className="sidebar-nav" aria-label="Menu principal">
          <button className={`nav-item ${activeView === "portals" ? "selected" : ""}`} type="button" onClick={() => setActiveView("portals")}>
            <MaterialIcon name="public" size={18} />
            Portais
          </button>
          <button className={`nav-item ${activeView === "rules" ? "selected" : ""}`} type="button" onClick={openRulesView}>
            <MaterialIcon name="stacks" size={18} />
            Regras
          </button>
        </nav>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <h1>{activeView === "portals" ? "Portais" : "Regras"}</h1>
            <p>
              {metadata
                ? `${formatNumber(portals.length)} portais - ${formatNumber(rules.length)} regras - ${formatNumber(metadata.counts.base_imoveis)} imoveis - ${formatNumber(metadata.counts.publish_locks)} locks`
                : "Carregando metadados"}
            </p>
          </div>
          <div className="topbar-actions">
            <div className="search-box">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={activeView === "portals" ? "Buscar portal" : "Buscar regra"}
              />
            </div>
            <button
              className="secondary-button add-portal-button"
              type="button"
              onClick={activeView === "portals" ? newPortal : newRule}
            >
              <MaterialIcon name="add" size={18} />
              {activeView === "portals" ? "Adicionar portal" : "Nova regra"}
            </button>
            <button className="secondary-button" type="button" onClick={() => void loadAll()} disabled={loading}>
              <MaterialIcon name="refresh" size={18} />
              Atualizar
            </button>
          </div>
        </header>

        {error && <div className="error-banner">{error}</div>}

        {activeView === "portals" ? (
        <section className="portal-directory">
          <div className="portal-directory-heading">
            <div>
              <h2>Todos os portais</h2>
              <span>{formatNumber(visiblePortals.length)} na listagem</span>
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
            ) : visiblePortals.length ? (
              visiblePortals.map((portal) => (
                <button
                  className={`portal-row ${portal.id === selectedPortalId ? "selected" : ""}`}
                  key={portal.id}
                  type="button"
                  onClick={() => selectPortal(portal)}
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
                      selectPortal(portal, "edit");
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
        ) : (
        <section className="rule-directory">
          <div className="portal-directory-heading">
            <div>
              <h2>Todas as regras</h2>
              <span>{formatNumber(visibleRules.length)} na listagem</span>
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
            ) : ruleTreeRows.length ? (
              ruleTreeRows.map(({ rule, depth }) => (
                <button
                  className={`rule-row nested-rule-row ${depth > 0 ? "child-rule-row" : ""} ${rule.id === ruleForm?.id ? "selected" : ""}`}
                  key={rule.id}
                  style={{ "--rule-indent": `${Math.min(depth, 6) * 24}px` } as CSSProperties}
                  type="button"
                  onClick={() => editRule(rule, "view")}
                >
                  <span className="portal-cell rule-name-cell">
                    <span className="rule-tree-rail" aria-hidden="true" />
                    <span className={`portal-logo rule-node-icon ${depth > 0 ? "child" : ""}`}>
                      {depth > 0 ? <MaterialIcon name="account_tree" size={18} /> : <Filter size={18} />}
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
                      editRule(rule, "edit");
                    }}
                  >
                    <MaterialIcon name="edit" size={17} />
                    Editar
                  </span>
                </button>
              ))
            ) : (
              <div className="empty-state">Nenhuma regra encontrada.</div>
            )}
          </div>
        </section>
        )}
      </section>

      <aside className={`portal-editor-panel ${detailsPanelCollapsed ? "collapsed" : ""}`}>
        <div className="details-panel-toggle-bar">
          <button
            className="icon-button details-panel-toggle"
            type="button"
            title={detailsPanelCollapsed ? "Expandir painel" : "Recolher painel"}
            aria-label={detailsPanelCollapsed ? "Expandir painel de detalhes" : "Recolher painel de detalhes"}
            onClick={() => setDetailsPanelCollapsed((current) => !current)}
          >
            <MaterialIcon name={detailsPanelCollapsed ? "keyboard_double_arrow_left" : "keyboard_double_arrow_right"} size={19} />
          </button>
          {!detailsPanelCollapsed && (
            <span>{activeView === "portals" ? "Detalhes do portal" : "Detalhes da regra"}</span>
          )}
        </div>
        {!detailsPanelCollapsed && (activeView === "portals" ? (
        <form className={`portal-form ${isPortalEditing ? "edit-mode" : "view-mode"}`} onSubmit={savePortal}>
          {!isPortalEditing && (
            <div className="panel-mode-actions">
              <button className="secondary-button compact-button" type="button" onClick={() => setPortalMode("edit")}>
                <MaterialIcon name="edit" size={17} />
                Editar
              </button>
            </div>
          )}
          {isPortalEditing && portalForm.id && (
            <div className="panel-mode-actions">
              <button className="secondary-button compact-button" type="button" onClick={returnToPortalView}>
                <MaterialIcon name="arrow_back" size={17} />
                Voltar
              </button>
            </div>
          )}
          <div className="portal-editor-header">
            <div className="logo-uploader">
              <div className="logo-preview">
                {portalForm.logo_url ? <img src={portalForm.logo_url} alt="" /> : <Image size={26} />}
              </div>
              {isPortalEditing && (
              <>
              <label className="secondary-button logo-upload-button" htmlFor="portal-logo-upload">
                <MaterialIcon name="image" size={17} />
                Logo
              </label>
              <input id="portal-logo-upload" type="file" accept="image/*" onChange={updatePortalLogo} />
              </>
              )}
            </div>
            <div className="portal-title-fields">
              <label>
                Nome do portal
                {isPortalEditing ? (
                <input
                  value={portalForm.name}
                  onChange={(event) => setPortalForm({ ...portalForm, name: event.target.value })}
                  required
                />
                ) : (
                  <span className="view-field">{displayValue(portalForm.name)}</span>
                )}
              </label>
              <label>
                Descricao
                {isPortalEditing ? (
                <textarea
                  value={portalForm.description ?? ""}
                  onChange={(event) => setPortalForm({ ...portalForm, description: event.target.value })}
                  rows={2}
                />
                ) : (
                  <span className="view-field multiline">{displayValue(portalForm.description)}</span>
                )}
              </label>
            </div>
          </div>

          <div className="portal-summary-grid">
            <div>
              <span>Cotas</span>
              <strong>{formatNumber(portalFormTotal)}</strong>
            </div>
            <div>
              <span>Regras</span>
              <strong>{formatNumber(selectedPortalRules.length)}</strong>
            </div>
            {isPortalEditing ? (
            <label className="toggle-field summary-toggle">
              <input
                type="checkbox"
                checked={portalForm.active}
                onChange={(event) => setPortalForm({ ...portalForm, active: event.target.checked })}
              />
              <span className="toggle-switch" aria-hidden="true" />
              <span>
                <strong>Status</strong>
                <small>{portalForm.active ? "Ativo" : "Inativo"}</small>
              </span>
            </label>
            ) : (
              <div className="summary-status">
                <span>Status</span>
                <strong>{portalForm.active ? "Ativo" : "Inativo"}</strong>
              </div>
            )}
          </div>

          <div className="quota-editor">
            <div className="quota-heading">
              <span>Tipos de anuncio</span>
              <strong>{formatNumber(portalFormTotal)}</strong>
            </div>
            <div className="quota-list">
              {portalForm.ad_types.map((adType, index) => (
                <div className={`quota-row ${isPortalEditing ? "" : "view-row"}`} key={index}>
                  {isPortalEditing ? (
                  <>
                  <input
                    value={adType.name}
                    placeholder="Tipo"
                    onChange={(event) => updatePortalAdType(index, { name: event.target.value })}
                  />
                  <NumericInput
                    allowDecimal={false}
                    allowNegative={false}
                    value={adType.quantity}
                    placeholder="Qtd."
                    onValueChange={(value) => updatePortalAdType(index, { quantity: localizedNumberToNumber(value) })}
                  />
                  <button
                    className="icon-button"
                    type="button"
                    title="Remover tipo"
                    onClick={() =>
                      setPortalForm({
                        ...portalForm,
                        ad_types: portalForm.ad_types.filter((_, itemIndex) => itemIndex !== index)
                      })
                    }
                  >
                    <MaterialIcon name="close" size={17} />
                  </button>
                  </>
                  ) : (
                    <>
                      <span className="view-field">{displayValue(adType.name)}</span>
                      <span className="view-field number">{formatNumber(adType.quantity || 0)}</span>
                    </>
                  )}
                </div>
              ))}
              {!portalForm.ad_types.length && <div className="quota-empty">Sem tipos cadastrados.</div>}
            </div>
            {isPortalEditing && (
            <button className="secondary-button full-width" type="button" onClick={addPortalAdType}>
              <MaterialIcon name="add" size={18} />
              Tipo de anuncio
            </button>
            )}
          </div>

          {isPortalEditing && (
          <div className="form-actions">
            <button className="primary-button" type="submit" disabled={saving}>
              <MaterialIcon name="save" size={18} />
              Salvar portal
            </button>
            {portalForm.id && (
              <button className="danger-button" type="button" onClick={() => void removePortal(portalForm.id!)}>
                <MaterialIcon name="delete" size={18} />
              </button>
            )}
          </div>
          )}
        </form>

        ) : ruleForm ? (
            <form className={`rule-form ${isRuleEditing ? "edit-mode" : "view-mode"}`} onSubmit={saveRule}>
              <div className="panel-heading inset">
                <div>
                  <h2>{isRuleEditing ? (ruleForm.id ? "Editar regra" : "Nova regra") : "Detalhes da regra"}</h2>
                  <span>{ruleForm.portal_id ? portals.find((portal) => portal.id === ruleForm.portal_id)?.name : "Sem portal vinculado"}</span>
                </div>
                {!isRuleEditing && (
                  <button className="secondary-button compact-button" type="button" onClick={() => setRuleMode("edit")}>
                    <MaterialIcon name="edit" size={17} />
                    Editar
                  </button>
                )}
                {isRuleEditing && ruleForm.id && (
                  <div className="panel-heading-actions">
                    <button className="secondary-button compact-button" type="button" onClick={returnToRuleView}>
                      <MaterialIcon name="arrow_back" size={17} />
                      Voltar
                    </button>
                    <button className="danger-button" type="button" onClick={() => void removeRule(ruleForm.id!)}>
                      <MaterialIcon name="delete" size={18} />
                    </button>
                  </div>
                )}
              </div>

              <div className="rule-details-grid">
                <label>
                  Nome
                  {isRuleEditing ? (
                  <input
                    value={ruleForm.name}
                    onChange={(event) => setRuleForm({ ...ruleForm, name: event.target.value })}
                    required
                  />
                  ) : (
                    <span className="view-field">{displayValue(ruleForm.name)}</span>
                  )}
                </label>

                <label>
                  Portal vinculado
                  {isRuleEditing ? (
                  <select
                    value={ruleForm.portal_id ?? ""}
                    onChange={(event) =>
                      setRuleForm({
                        ...ruleForm,
                        portal_id: event.target.value ? Number(event.target.value) : null,
                        use_ad_limit: event.target.value ? ruleForm.use_ad_limit : false,
                        ad_limit_type: "total"
                      })
                    }
                  >
                    <option value="">Sem portal</option>
                    {portals.map((portal) => (
                      <option key={portal.id} value={portal.id}>
                        {portal.name}
                      </option>
                    ))}
                  </select>
                  ) : (
                    <span className="view-field">
                      {displayValue(ruleForm.portal_id ? portals.find((portal) => portal.id === ruleForm.portal_id)?.name : "Sem portal")}
                    </span>
                  )}
                </label>

                <label>
                  Descricao
                  {isRuleEditing ? (
                  <textarea
                    value={ruleForm.description ?? ""}
                    onChange={(event) => setRuleForm({ ...ruleForm, description: event.target.value })}
                    rows={2}
                  />
                  ) : (
                    <span className="view-field multiline">{displayValue(ruleForm.description)}</span>
                  )}
                </label>

                <label>
                  Preset inicial
                  {isRuleEditing ? (
                  <select
                    value={ruleForm.source_table}
                    onChange={(event) => updateRuleSource(event.target.value)}
                  >
                    {ruleSourceOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  ) : (
                    <span className="view-field">
                      {displayValue(ruleSourceOptions.find((option) => option.value === ruleForm.source_table)?.label ?? ruleForm.source_table)}
                    </span>
                  )}
                </label>

                <label>
                  Slug da view
                  <span className="view-code-row">
                    <span className="view-field code-view-field">{displayValue(ruleForm.view_name ?? "View sera criada ao salvar")}</span>
                    <button
                      className="slug-copy-button"
                      type="button"
                      onClick={() => void copyRuleViewName()}
                      disabled={!ruleForm.view_name?.trim()}
                      title="Copiar slug da view"
                      aria-label="Copiar slug da view"
                    >
                      <MaterialIcon name={viewNameCopied ? "done" : "content_copy"} size={15} />
                    </button>
                  </span>
                </label>
              </div>

              <div className="toggle-grid">
                {isRuleEditing ? (
                <>
                <label className="toggle-field">
                  <input
                    type="checkbox"
                    checked={ruleForm.active}
                    onChange={(event) => setRuleForm({ ...ruleForm, active: event.target.checked })}
                  />
                  <span className="toggle-switch" aria-hidden="true" />
                  <span>
                    <strong>Regra</strong>
                    <small>{ruleForm.active ? "Ativa" : "Inativa"}</small>
                  </span>
                </label>
                <label className="toggle-field">
                  <input
                    type="checkbox"
                    checked={ruleForm.include_locked}
                    onChange={(event) => setRuleForm({ ...ruleForm, include_locked: event.target.checked })}
                  />
                  <span className="toggle-switch" aria-hidden="true" />
                  <span>
                    <strong>Travados</strong>
                    <small>{ruleForm.include_locked ? "Preservar" : "Ignorar"}</small>
                  </span>
                </label>
                <label className="toggle-field">
                  <input
                    type="checkbox"
                    checked={ruleForm.use_ad_limit && Boolean(ruleForm.portal_id)}
                    disabled={!ruleForm.portal_id}
                    onChange={(event) =>
                      setRuleForm({
                        ...ruleForm,
                        use_ad_limit: event.target.checked,
                        ad_limit_type: event.target.checked ? currentAdLimitType : null
                      })
                    }
                  />
                  <span className="toggle-switch" aria-hidden="true" />
                  <span>
                    <strong>Usar limite de anuncios</strong>
                    <small>{ruleForm.use_ad_limit ? `${adLimitTypeLabel(currentAdLimitType)}: ${formatNumber(currentAdLimitQuota ?? 0)}` : "Sem limite"}</small>
                  </span>
                </label>
                </>
                ) : (
                <>
                <div className="summary-status">
                  <span>Regra</span>
                  <strong>{ruleForm.active ? "Ativa" : "Inativa"}</strong>
                </div>
                <div className="summary-status">
                  <span>Travados</span>
                  <strong>{ruleForm.include_locked ? "Preservar" : "Ignorar"}</strong>
                </div>
                <div className="summary-status">
                  <span>Limite de anuncios</span>
                  <strong>
                    {ruleForm.use_ad_limit
                      ? `${adLimitTypeLabel(currentAdLimitType)} (${formatNumber(currentAdLimitQuota ?? 0)})`
                      : "Sem limite"}
                  </strong>
                </div>
                </>
                )}
              </div>

              {ruleForm.use_ad_limit && (
                <div className="ad-limit-panel">
                  <label>
                    Limite de anuncio do portal
                    {isRuleEditing ? (
                    <select
                      value={currentAdLimitType}
                      disabled={!selectedRulePortal}
                      onChange={(event) => setRuleForm({ ...ruleForm, ad_limit_type: event.target.value })}
                    >
                      {adLimitOptions.length ? (
                        adLimitOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))
                      ) : (
                        <option value="total">Total (0)</option>
                      )}
                    </select>
                    ) : (
                      <span className="view-field">
                        {selectedRulePortal ? `${adLimitTypeLabel(currentAdLimitType)} (${formatNumber(currentAdLimitQuota ?? 0)})` : "Sem portal"}
                      </span>
                    )}
                  </label>
                </div>
              )}

              <section className="filter-editor-card">
                <div className="filter-editor-heading">
                  <div>
                    <h3>Stack de filtros</h3>
                    <span>{groupSummary(ruleForm.filters)}</span>
                  </div>
                  <button
                    className={`ghost-button compact-button query-toggle ${queryPanelOpen ? "selected" : ""}`}
                    type="button"
                    aria-expanded={queryPanelOpen}
                    onClick={() => setQueryPanelOpen((current) => !current)}
                  >
                    <MaterialIcon name="terminal" size={17} />
                    Query
                  </button>
                </div>
                <FilterGroupBuilder
                  columns={filterableColumns}
                  group={ruleForm.filters}
                  onChange={(filters) => setRuleForm({ ...ruleForm, filters: filters as RuleFilters })}
                  onCreateGroup={openCreateGroup}
                  onEditGroup={openEditGroup}
                  stackOnly
                  readOnly={!isRuleEditing}
                />
                <div className="filter-card-divider" />
                <div className="filter-editor-heading priority-heading">
                  <div>
                    <h3>Prioridade de publicacao</h3>
                    <span className="priority-heading-meta">
                      <span>{publicationPrioritySummary(ruleForm.publication_priority, filterableColumns)}</span>
                      {inheritedPriorityPresetName && (
                        <span className="inherited-priority-badge">herdadas de {inheritedPriorityPresetName}</span>
                      )}
                    </span>
                  </div>
                  <MaterialIcon name="swap_vert" size={19} className="priority-heading-icon" />
                </div>
                <PublicationPriorityEditor
                  columns={filterableColumns}
                  value={ruleForm.publication_priority}
                  onChange={(publicationPriority) => setRuleForm({ ...ruleForm, publication_priority: publicationPriority })}
                  readOnly={!isRuleEditing}
                />
                {queryPanelOpen && (
                  <div className="query-preview">
                    <div className="query-preview-heading">
                      <span>Query atual</span>
                      <button className="ghost-button compact-button" type="button" onClick={() => void copyCurrentRuleQuery()}>
                        <MaterialIcon name={queryCopied ? "done" : "content_copy"} size={17} />
                        {queryCopied ? "Copiada" : "Copiar"}
                      </button>
                    </div>
                    <pre>
                      <code>{currentRuleQuery}</code>
                    </pre>
                  </div>
                )}
              </section>

              <div className="preview-strip">
                <div>
                  <span>{ruleForm.use_ad_limit ? "Imoveis limitados" : "Imoveis no filtro"}</span>
                  <strong>
                    {ruleForm.use_ad_limit
                      ? previewLimitedCount == null
                        ? "-"
                        : formatNumber(previewLimitedCount)
                      : previewCount == null
                        ? "-"
                        : formatNumber(previewCount)}
                  </strong>
                </div>
                <div>
                  <span>Total no filtro</span>
                  <strong>{previewCount == null ? "-" : formatNumber(previewCount)}</strong>
                </div>
                {isRuleEditing && (
                <button className="secondary-button" type="button" onClick={() => void previewRule()} disabled={saving}>
                  <MaterialIcon name="visibility" size={18} />
                  Calcular
                </button>
                )}
              </div>

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
                    <div className="segmented preview-limit-toggle" aria-label="Quantidade de linhas">
                      <button
                        className={previewRowsLimit === 10 ? "selected" : ""}
                        type="button"
                        onClick={() => {
                          setPreviewRowsLimit(10);
                          setPreviewRows(null);
                        }}
                      >
                        {formatNumber(10)}
                      </button>
                      <button
                        className={previewRowsLimit === 100 ? "selected" : ""}
                        type="button"
                        onClick={() => {
                          setPreviewRowsLimit(100);
                          setPreviewRows(null);
                        }}
                      >
                        {formatNumber(100)}
                      </button>
                    </div>
                    <button className="secondary-button compact-button" type="button" onClick={() => void previewRuleRows()} disabled={previewRowsLoading}>
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

              {isRuleEditing && (
              <div className="form-actions end">
                <button className="ghost-button" type="button" onClick={() => resetRuleForm(null)}>
                  <MaterialIcon name="close" size={18} />
                  Cancelar
                </button>
                <button className="primary-button" type="submit" disabled={saving}>
                  {saving ? <Loader2 className="spin" size={16} /> : <MaterialIcon name="check" size={18} />}
                  Salvar regra
                </button>
              </div>
              )}

              {isRuleEditing && groupEditor && (
                <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Editar filtro agrupado">
                  <section className="filter-modal">
                    <div className="filter-modal-heading">
                      <div>
                        <h2>{groupEditor.mode === "create" ? "Criar filtro+" : "Editar filtro+"}</h2>
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
                        placeholder="Grupo de filtros"
                        onChange={(event) =>
                          setGroupEditor((current) =>
                            current ? { ...current, draft: { ...current.draft, name: event.target.value } } : current
                          )
                        }
                      />
                    </label>

                    <FilterGroupBuilder
                      columns={filterableColumns}
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
                        Aplicar filtro+
                      </button>
                    </div>
                  </section>
                </div>
              )}
            </form>
        ) : (
          <section className="portal-rules-section">
            <div className="panel-heading">
              <div>
                <h2>Regras</h2>
                <span>Selecione uma regra ou crie uma nova.</span>
              </div>
              <button className="secondary-button" type="button" onClick={newRule}>
                <MaterialIcon name="add" size={18} />
                Nova regra
              </button>
            </div>
          </section>
        ))}
      </aside>
    </main>
  );
}
