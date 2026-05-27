"use client";

import { Filter, Globe2, Image, Loader2, Search } from "lucide-react";
import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import "./page.css";
import { AutomationDirectory } from "./_components/automation-directory";
import { FilterGroupBuilder } from "./_components/filter-group-builder";
import { MaterialIcon } from "./_components/material-icon";
import { NumericInput } from "./_components/numeric-input";
import { PortalDirectory } from "./_components/portal-directory";
import { PortalFinalListingModal } from "./_components/portal-final-listing-modal";
import { PublicationPriorityEditor, publicationPrioritySummary } from "./_components/publication-priority-editor";
import { RuleDirectory } from "./_components/rule-directory";
import { RulePreviewRows } from "./_components/rule-preview-rows";
import { RuleSummarySection } from "./_components/rule-summary-section";
import { SourceViewPicker, type SourceViewOption } from "./_components/source-view-picker";
import { StatusDirectory } from "./_components/status-directory";
import { fetchJson } from "./_lib/client-api";
import { formatNumber, localizedNumberToNumber } from "./_lib/number-format";
import {
  AD_TIER_HELP,
  AD_TYPE_NAME_HELP,
  FINAL_LISTING_COLUMNS,
  FINAL_LISTING_DEFAULT_SUMMARY_COLUMNS,
  HEALTHCHECK_INTERVAL_MINUTES,
  HEALTHCHECK_INTERVAL_MS,
  PORTAL_SLUG_HELP,
  PREVIEW_RULE_ORDER_COLUMN
} from "./_lib/page-constants";
import {
  EMPTY_FILTERS,
  EMPTY_PORTAL,
  EMPTY_PUBLICATION_PRIORITY,
  type ActiveView,
  type MetadataResponse,
  type PanelMode,
  type PreviewSortDirection,
  type PortalForm,
  type RuleForm,
  type RulePreview,
  type RuleRowsPreview
} from "./_lib/page-models";
import {
  adLimitTypeLabel,
  compareAdTypesByQuantity,
  displayValue,
  nextAvailableAdTier,
  normalizeAdTier,
  ruleAdLimitQuota,
  ruleTotalQuota
} from "./_lib/portal-form-utils";
import { createDefaultRuleSummaryConfig, createSummaryConfigItem } from "./_lib/rule-summary-defaults";
import {
  cloneGroup,
  createDefaultGroup,
  getGroupAtPath,
  groupSummary,
  insertItemAtPath,
  replaceGroupAtPath
} from "./_lib/rule-filter-utils";
import { buildRuleTreeRows, clonePublicationPriority, prioritySignature } from "./_lib/rule-list-utils";
import { matchesSearch } from "./_lib/search-utils";
import {
  buildStatusPublishedQuery,
  buildStatusUnexpectedQuery,
  formatTimestamp,
  groupStatusRules,
  ruleHealthTone,
  statusFinalViewName,
  statusLabel
} from "./_lib/status-monitoring-utils";
import { sanitizePublicationPriority } from "@/lib/rules";
import type {
  Portal,
  PortalAdType,
  PublishAutomation,
  PublicationRule,
  RuleFilterGroup,
  RuleFilters,
  RuleHealthcheckStatus,
  RuleSummaryConfigItem,
  RuleSummaryResponse
} from "@/lib/types";

type RuleQueryPreviewResponse = {
  select_sql: string;
  view_sql: string | null;
  view_name: string | null;
};

export default function Home() {
  const [portals, setPortals] = useState<Portal[]>([]);
  const [rules, setRules] = useState<PublicationRule[]>([]);
  const [automations, setAutomations] = useState<PublishAutomation[]>([]);
  const [metadata, setMetadata] = useState<MetadataResponse | null>(null);
  const [activeView, setActiveView] = useState<ActiveView>("portals");
  const [selectedPortalId, setSelectedPortalId] = useState<number | null>(null);
  const [selectedAutomationKey, setSelectedAutomationKey] = useState<string | null>(null);
  const [portalMode, setPortalMode] = useState<PanelMode>("view");
  const [portalForm, setPortalForm] = useState<PortalForm>(EMPTY_PORTAL);
  const [ruleForm, setRuleForm] = useState<RuleForm | null>(null);
  const [ruleMode, setRuleMode] = useState<PanelMode>("view");
  const [query, setQuery] = useState("");
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewLimitedCount, setPreviewLimitedCount] = useState<number | null>(null);
  const [previewCountLoading, setPreviewCountLoading] = useState(false);
  const [previewRowsLimit, setPreviewRowsLimit] = useState<10 | 100>(10);
  const [previewRows, setPreviewRows] = useState<RuleRowsPreview | null>(null);
  const [previewRowsLoading, setPreviewRowsLoading] = useState(false);
  const [previewSortColumn, setPreviewSortColumn] = useState(PREVIEW_RULE_ORDER_COLUMN);
  const [previewSortDirection, setPreviewSortDirection] = useState<PreviewSortDirection>("asc");
  const [previewCrmCode, setPreviewCrmCode] = useState("");
  const [summaryConfig, setSummaryConfig] = useState<RuleSummaryConfigItem[]>([]);
  const [summaryConfigCustom, setSummaryConfigCustom] = useState(false);
  const [ruleSummary, setRuleSummary] = useState<RuleSummaryResponse | null>(null);
  const [ruleSummaryLoading, setRuleSummaryLoading] = useState(false);
  const [finalListingPortalId, setFinalListingPortalId] = useState<number | null>(null);
  const [finalSummaryConfig, setFinalSummaryConfig] = useState<RuleSummaryConfigItem[]>([]);
  const [finalSummaryConfigCustom, setFinalSummaryConfigCustom] = useState(false);
  const [finalSummary, setFinalSummary] = useState<RuleSummaryResponse | null>(null);
  const [finalSummaryLoading, setFinalSummaryLoading] = useState(false);
  const [finalPreviewRowsLimit, setFinalPreviewRowsLimit] = useState<10 | 100>(10);
  const [finalPreviewRows, setFinalPreviewRows] = useState<RuleRowsPreview | null>(null);
  const [finalPreviewRowsLoading, setFinalPreviewRowsLoading] = useState(false);
  const [finalPreviewSortColumn, setFinalPreviewSortColumn] = useState(PREVIEW_RULE_ORDER_COLUMN);
  const [finalPreviewSortDirection, setFinalPreviewSortDirection] = useState<PreviewSortDirection>("asc");
  const [finalPreviewCrmCode, setFinalPreviewCrmCode] = useState("");
  const [finalRefreshLoading, setFinalRefreshLoading] = useState(false);
  const [healthcheckLoading, setHealthcheckLoading] = useState(false);
  const [selectedStatusRuleId, setSelectedStatusRuleId] = useState<number | null>(null);
  const [queryPanelOpen, setQueryPanelOpen] = useState(false);
  const [ruleQueryPreview, setRuleQueryPreview] = useState<RuleQueryPreviewResponse | null>(null);
  const [ruleQueryLoading, setRuleQueryLoading] = useState(false);
  const [queryCopied, setQueryCopied] = useState(false);
  const [viewNameCopied, setViewNameCopied] = useState(false);
  const [automationSqlCopied, setAutomationSqlCopied] = useState(false);
  const [detailsPanelCollapsed, setDetailsPanelCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const healthcheckInFlightRef = useRef(false);
  const savingRef = useRef(false);
  const summaryRequestIdRef = useRef(0);
  const summaryRequestSignatureRef = useRef("");
  const ruleQueryRequestIdRef = useRef(0);
  const ruleQuerySignatureRef = useRef("");
  const finalSummaryRequestIdRef = useRef(0);
  const finalListingPortalIdRef = useRef<number | null>(null);
  const activeFinalSummaryConfigRef = useRef<RuleSummaryConfigItem[]>([]);
  const finalSummaryConfigByPortalRef = useRef(
    new Map<number, { config: RuleSummaryConfigItem[]; custom: boolean }>()
  );
  const finalPreviewRowsRequestIdRef = useRef(0);
  const previewCountRequestIdRef = useRef(0);
  const previewRowsRequestIdRef = useRef(0);
  const previewRequestSignatureRef = useRef("");
  const lastPreviewRequestSignatureRef = useRef("");
  const previewCountAutoRefreshRef = useRef(false);
  const previewRowsAutoRefreshRef = useRef(false);
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
  const defaultSummaryConfig = useMemo(
    () =>
      ruleForm
        ? createDefaultRuleSummaryConfig(ruleForm.filters, ruleForm.publication_priority, filterableColumns)
        : [],
    [filterableColumns, ruleForm?.filters, ruleForm?.publication_priority]
  );
  const activeSummaryConfig = summaryConfigCustom ? summaryConfig : defaultSummaryConfig;
  const finalSummaryColumns = useMemo(
    () => buildFinalListingSummaryColumns(filterableColumns),
    [filterableColumns]
  );
  const defaultFinalSummaryConfig = useMemo(
    () =>
      FINAL_LISTING_DEFAULT_SUMMARY_COLUMNS.flatMap((columnName) => {
        const column = finalSummaryColumns.find((item) => item.column_name === finalListingSummaryColumnKey("final", columnName));
        return column ? [createSummaryConfigItem(column)] : [];
      }).filter(Boolean),
    [finalSummaryColumns]
  );
  const activeFinalSummaryConfig = finalSummaryConfigCustom ? finalSummaryConfig : defaultFinalSummaryConfig;
  const activeViewTitle =
    activeView === "portals"
      ? "Portais"
      : activeView === "rules"
        ? "Regras"
        : activeView === "automations"
          ? "Automacoes"
          : "Atualizar listagem";
  const searchPlaceholder =
    activeView === "portals"
      ? "Buscar portal"
      : activeView === "rules"
        ? "Buscar regra"
        : activeView === "automations"
          ? "Buscar automacao"
          : "Buscar regra ativa";
  const portalFormTotal = portalForm.ad_types.reduce((total, adType) => total + (Number(adType.quantity) || 0), 0);
  const orderedPortalFormAdTypes = portalForm.ad_types
    .map((adType, index) => ({ adType, index }))
    .sort((left, right) => compareAdTypesByQuantity(left.adType, right.adType));
  const isPortalEditing = portalMode === "edit";
  const isRuleEditing = ruleMode === "edit" || !ruleForm?.id;
  const visiblePortals = useMemo(
    () => portals.filter((portal) => matchesSearch(query, [portal.name, portal.description])),
    [portals, query]
  );
  const visibleRules = useMemo(
    () => rules.filter((rule) => matchesSearch(query, [rule.name, rule.description, rule.portal_name, rule.view_name, rule.source_table])),
    [query, rules]
  );
  const visibleAutomations = useMemo(
    () =>
      automations.filter((automation) =>
        matchesSearch(query, [
          automation.name,
          automation.description,
          automation.key,
          automation.database_name,
          automation.schema_name,
          automation.table_name,
          automation.target_column,
          automation.run_mode
        ])
      ),
    [automations, query]
  );
  const ruleTreeRows = useMemo(() => buildRuleTreeRows(visibleRules), [visibleRules]);
  const activeRules = useMemo(() => rules.filter((rule) => rule.active), [rules]);
  const activeAutomations = useMemo(() => automations.filter((automation) => automation.active), [automations]);
  const monitoredActiveRules = useMemo(
    () => activeRules.filter((rule) => rule.portal_id != null),
    [activeRules]
  );
  const portalById = useMemo(() => new Map(portals.map((portal) => [portal.id, portal])), [portals]);
  const visibleStatusRules = useMemo(
    () =>
      monitoredActiveRules.filter((rule) => matchesSearch(query, [rule.name, rule.description, rule.portal_name, rule.portal_slug, rule.view_name])),
    [monitoredActiveRules, query]
  );
  const statusPortalGroups = useMemo(() => groupStatusRules(visibleStatusRules, portalById), [portalById, visibleStatusRules]);
  const selectedStatusRule =
    (selectedStatusRuleId == null ? null : monitoredActiveRules.find((rule) => rule.id === selectedStatusRuleId)) ?? null;
  const selectedStatusPortal = selectedStatusRule?.portal_id ? portalById.get(selectedStatusRule.portal_id) ?? null : null;
  const selectedAutomation =
    (selectedAutomationKey == null ? null : automations.find((automation) => automation.key === selectedAutomationKey)) ?? null;
  const finalListingPortal =
    (finalListingPortalId == null ? null : portals.find((portal) => portal.id === finalListingPortalId)) ?? null;
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
        value: adType.slug,
        label: `${adType.name} (${formatNumber(adType.quantity || 0)})`
      }))
    ];
  }, [selectedRulePortal]);
  const currentAdLimitType = adLimitOptions.some((option) => option.value === ruleForm?.ad_limit_type)
    ? ruleForm?.ad_limit_type ?? "total"
    : "total";
  const currentAdLimitQuota = ruleForm?.use_ad_limit ? ruleAdLimitQuota(selectedRulePortal, currentAdLimitType) : null;
  const ruleSourceOptions = useMemo<SourceViewOption[]>(() => {
    const currentRuleViewName = rules.find((rule) => rule.id === ruleForm?.id)?.view_name;
    const sourceViewOptions = (metadata?.source_views ?? [])
      .filter((view) => view.view_name !== currentRuleViewName)
      .map((view) => {
        const rule = ruleByViewName.get(view.view_name);
        return buildSourceViewOption(view.view_name, view.view_type, rule, portalById);
      })
      .sort(compareSourceViewOptions);
    const options = [baseSourceViewOption(), ...sourceViewOptions];

    if (ruleForm?.source_table && !options.some((option) => option.value === ruleForm.source_table)) {
      options.push(unavailableSourceViewOption(ruleForm.source_table));
    }

    return options;
  }, [metadata?.source_views, portalById, ruleByViewName, rules, ruleForm?.id, ruleForm?.source_table]);

  const ruleQuerySignature = useMemo(() => {
    if (!ruleForm || !queryPanelOpen) return "";
    return JSON.stringify({
      id: ruleForm.id ?? null,
      view_name: ruleForm.view_name ?? null,
      active: ruleForm.active,
      include_locked: ruleForm.include_locked,
      source_table: ruleForm.source_table,
      portal_id: ruleForm.portal_id,
      use_ad_limit: ruleForm.use_ad_limit,
      ad_limit_type: currentAdLimitType,
      filters: ruleForm.filters,
      publication_priority: ruleForm.publication_priority
    });
  }, [currentAdLimitType, queryPanelOpen, ruleForm]);
  const currentRuleQuery = ruleQueryPreview?.view_sql ?? ruleQueryPreview?.select_sql ?? "";
  const previewRequestSignature = useMemo(() => {
    if (!ruleForm) return "";
    return JSON.stringify({
      active: ruleForm.active,
      include_locked: ruleForm.include_locked,
      source_table: ruleForm.source_table,
      portal_id: ruleForm.portal_id,
      use_ad_limit: ruleForm.use_ad_limit,
      ad_limit_type: currentAdLimitType,
      filters: ruleForm.filters,
      publication_priority: ruleForm.publication_priority
    });
  }, [currentAdLimitType, ruleForm]);
  const summaryRequestSignature = useMemo(() => {
    if (!ruleForm) return "";
    return JSON.stringify({
      active: ruleForm.active,
      include_locked: ruleForm.include_locked,
      source_table: ruleForm.source_table,
      portal_id: ruleForm.portal_id,
      use_ad_limit: ruleForm.use_ad_limit,
      ad_limit_type: currentAdLimitType,
      filters: ruleForm.filters,
      publication_priority: ruleForm.publication_priority,
      items: activeSummaryConfig
    });
  }, [activeSummaryConfig, currentAdLimitType, ruleForm]);
  const finalSummaryRequestSignature = useMemo(() => {
    if (!finalListingPortalId) return "";
    return JSON.stringify({
      portal_id: finalListingPortalId,
      items: activeFinalSummaryConfig
    });
  }, [activeFinalSummaryConfig, finalListingPortalId]);

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  useEffect(() => {
    finalListingPortalIdRef.current = finalListingPortalId;
  }, [finalListingPortalId]);

  useEffect(() => {
    activeFinalSummaryConfigRef.current = activeFinalSummaryConfig;
  }, [activeFinalSummaryConfig]);

  useEffect(() => {
    setQueryCopied(false);
  }, [currentRuleQuery, queryPanelOpen]);

  useEffect(() => {
    ruleQuerySignatureRef.current = ruleQuerySignature;
    ruleQueryRequestIdRef.current += 1;

    if (!queryPanelOpen || !ruleForm || !ruleQuerySignature) {
      setRuleQueryPreview(null);
      setRuleQueryLoading(false);
      return;
    }

    setRuleQueryPreview(null);
    setRuleQueryLoading(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void loadRuleQueryPreview(controller.signal, ruleQuerySignature);
    }, 350);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [queryPanelOpen, ruleQuerySignature]);

  useEffect(() => {
    setViewNameCopied(false);
  }, [ruleForm?.view_name]);

  useEffect(() => {
    setAutomationSqlCopied(false);
  }, [selectedAutomation?.sql_text]);

  useEffect(() => {
    if (activeView !== "automations") return;
    if (selectedAutomationKey && automations.some((automation) => automation.key === selectedAutomationKey)) return;
    setSelectedAutomationKey(automations[0]?.key ?? null);
  }, [activeView, automations, selectedAutomationKey]);

  useEffect(() => {
    if (previewSortColumn === PREVIEW_RULE_ORDER_COLUMN) return;
    if (previewRows?.columns.some((column) => column.key === previewSortColumn)) return;
    setPreviewSortColumn(PREVIEW_RULE_ORDER_COLUMN);
  }, [previewRows, previewSortColumn]);

  useEffect(() => {
    if (finalPreviewSortColumn === PREVIEW_RULE_ORDER_COLUMN) return;
    if (finalPreviewRows?.columns.some((column) => column.key === finalPreviewSortColumn)) return;
    setFinalPreviewSortColumn(PREVIEW_RULE_ORDER_COLUMN);
  }, [finalPreviewRows, finalPreviewSortColumn]);

  useEffect(() => {
    summaryRequestSignatureRef.current = summaryRequestSignature;
    summaryRequestIdRef.current += 1;

    if (!ruleForm || !summaryRequestSignature) {
      setRuleSummary(null);
      setRuleSummaryLoading(false);
      return;
    }

    setRuleSummary(null);
    setRuleSummaryLoading(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void loadRuleSummary(controller.signal, summaryRequestSignature);
    }, 450);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [summaryRequestSignature]);

  useEffect(() => {
    finalSummaryRequestIdRef.current += 1;

    if (!finalListingPortalId || !finalSummaryRequestSignature) {
      setFinalSummary(null);
      setFinalSummaryLoading(false);
      return;
    }

    setFinalSummary(null);
    setFinalSummaryLoading(true);
    const controller = new AbortController();
    const portalId = finalListingPortalId;
    const items = activeFinalSummaryConfig;
    const timeout = window.setTimeout(() => {
      void loadPortalFinalSummary({
        signal: controller.signal,
        portalId,
        items,
        source: "signature-change"
      });
    }, 300);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [finalSummaryRequestSignature]);

  useEffect(() => {
    previewRequestSignatureRef.current = previewRequestSignature;

    if (!ruleForm || !previewRequestSignature) {
      resetRulePreviewState();
      return;
    }

    const previousSignature = lastPreviewRequestSignatureRef.current;
    lastPreviewRequestSignatureRef.current = previewRequestSignature;
    if (!previousSignature || previousSignature === previewRequestSignature) return;

    const shouldRefreshCount = previewCountAutoRefreshRef.current;
    const shouldRefreshRows = previewRowsAutoRefreshRef.current;

    previewCountRequestIdRef.current += 1;
    previewRowsRequestIdRef.current += 1;
    if (shouldRefreshCount) {
      setPreviewCount(null);
      setPreviewLimitedCount(null);
      setPreviewCountLoading(false);
    }
    if (shouldRefreshRows) {
      setPreviewRows(null);
      setPreviewRowsLoading(false);
    }
    if (!shouldRefreshCount && !shouldRefreshRows) return;

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      if (shouldRefreshCount) void previewRule({ signal: controller.signal, requestSignature: previewRequestSignature });
      if (shouldRefreshRows) void previewRuleRows({ signal: controller.signal, requestSignature: previewRequestSignature });
    }, 450);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [previewRequestSignature]);

  useEffect(() => {
    if ((activeView !== "rules" && activeView !== "status") || !rules.length) return;

    void loadRuleHealthchecks();
    const interval = window.setInterval(() => {
      void loadRuleHealthchecks();
    }, HEALTHCHECK_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [activeView, rules.length]);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [portalData, ruleData, automationData, metadataData] = await Promise.all([
        fetchJson<{ portals: Portal[] }>("/api/portals"),
        fetchJson<{ rules: PublicationRule[] }>("/api/rules"),
        fetchJson<{ automations: PublishAutomation[] }>("/api/automations"),
        fetchJson<MetadataResponse>("/api/metadata")
      ]);
      setPortals(portalData.portals);
      setRules(ruleData.rules);
      setAutomations(automationData.automations);
      setMetadata(metadataData);
      setSelectedAutomationKey((current) =>
        current && automationData.automations.some((automation) => automation.key === current)
          ? current
          : automationData.automations[0]?.key ?? null
      );

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

  async function refreshAllData() {
    setLoading(true);
    setError(null);
    try {
      await loadAll();
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : "Erro ao atualizar dados.");
      setLoading(false);
    }
  }

  function resetRulePreviewState() {
    previewCountRequestIdRef.current += 1;
    previewRowsRequestIdRef.current += 1;
    previewRequestSignatureRef.current = "";
    lastPreviewRequestSignatureRef.current = "";
    previewCountAutoRefreshRef.current = false;
    previewRowsAutoRefreshRef.current = false;
    setPreviewCount(null);
    setPreviewLimitedCount(null);
    setPreviewCountLoading(false);
    setPreviewRows(null);
    setPreviewRowsLoading(false);
    setPreviewCrmCode("");
  }

  function resetRuleForm(portalId: number | null = null) {
    resetRulePreviewState();
    setRuleSummary(null);
    setSummaryConfig([]);
    setSummaryConfigCustom(false);
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
      publication_priority: EMPTY_PUBLICATION_PRIORITY,
      summary_config: null
    });
  }

  function editPortal(portal: Portal) {
    setPortalForm({
      id: portal.id,
      name: portal.name,
      slug: portal.slug,
      description: portal.description ?? "",
      logo_url: portal.logo_url ?? null,
      active: portal.active,
      final_listing_refresh_time: normalizePortalRefreshTime(portal.final_listing_refresh_time),
      ad_types: (portal.ad_types ?? []).map((adType) => ({
        name: adType.name,
        quantity: adType.quantity,
        tier: normalizeAdTier(adType.tier)
      })).sort(compareAdTypesByQuantity)
    });
  }

  function newPortal() {
    setActiveView("portals");
    setPortalForm(EMPTY_PORTAL);
    setPortalMode("edit");
    setSelectedPortalId(null);
    setRuleForm(null);
    resetRulePreviewState();
    setRuleSummary(null);
    setSummaryConfig([]);
    setSummaryConfigCustom(false);
  }

  function selectPortal(portal: Portal, mode: PanelMode = "view") {
    setActiveView("portals");
    setSelectedPortalId(portal.id);
    editPortal(portal);
    setPortalMode(mode);
  }

  function openRulesView() {
    setActiveView("rules");
  }

  function openAutomationsView() {
    setActiveView("automations");
  }

  function openStatusView() {
    setActiveView("status");
    void loadRuleHealthchecks();
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
    setSummaryConfigCustom(false);
    setSummaryConfig([]);
    setRuleForm({
      ...ruleForm,
      source_table: sourceTable,
      publication_priority: presetPriority ?? ruleForm.publication_priority,
      summary_config: null
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

  function updatePortalAdType(index: number, patch: Partial<Pick<PortalAdType, "name" | "quantity" | "tier">>) {
    const adTypes = [...portalForm.ad_types];
    adTypes[index] = { ...adTypes[index], ...patch };
    setPortalForm({ ...portalForm, ad_types: adTypes });
  }

  function addPortalAdType() {
    if (portalForm.ad_types.filter((adType) => adType.name.trim()).length >= 10) {
      setError("Um portal pode ter no maximo 10 tipos de anuncio.");
      return;
    }
    setPortalForm({
      ...portalForm,
      ad_types: [...portalForm.ad_types, { name: "", quantity: 0, tier: nextAvailableAdTier(portalForm.ad_types) }]
    });
  }

  function validatePortalAdTypes() {
    const tiers = new Set<number>();
    const adTypes = portalForm.ad_types.filter((adType) => adType.name.trim());
    if (adTypes.length > 10) return "Um portal pode ter no maximo 10 tipos de anuncio.";
    for (const adType of adTypes) {
      const tier = normalizeAdTier(adType.tier);
      if (tiers.has(tier)) return "Nao e permitido repetir o mesmo tier de anuncio para o mesmo portal.";
      tiers.add(tier);
    }
    return null;
  }

  async function savePortal(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const adTypesError = validatePortalAdTypes();
      if (adTypesError) throw new Error(adTypesError);

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
      resetRulePreviewState();
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
      const payload = {
        ...ruleForm,
        ad_limit_type: ruleForm.use_ad_limit ? currentAdLimitType : null,
        summary_config: summaryConfigCustom ? summaryConfig : null
      };
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
      setRuleForm(null);
      resetRulePreviewState();
      setRuleSummary(null);
      setSummaryConfig([]);
      setSummaryConfigCustom(false);
      setGroupEditor(null);
      await loadAll();
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : "Erro ao excluir regra.");
    } finally {
      setSaving(false);
    }
  }

  async function previewRule(options: { signal?: AbortSignal; requestSignature?: string } = {}) {
    if (!ruleForm || !previewRequestSignature) return;
    const requestSignature = options.requestSignature ?? previewRequestSignature;
    const requestId = ++previewCountRequestIdRef.current;
    previewCountAutoRefreshRef.current = true;
    setPreviewCountLoading(true);
    setError(null);
    try {
      const result = await fetchJson<RulePreview>("/api/rules/preview", {
        method: "POST",
        signal: options.signal,
        body: JSON.stringify({ ...ruleForm, ad_limit_type: currentAdLimitType })
      });
      if (requestId === previewCountRequestIdRef.current && requestSignature === previewRequestSignatureRef.current) {
        setPreviewCount(result.count);
        setPreviewLimitedCount(result.limited_count ?? null);
      }
    } catch (currentError) {
      if (options.signal?.aborted) return;
      setError(currentError instanceof Error ? currentError.message : "Erro na previa.");
    } finally {
      if (requestId === previewCountRequestIdRef.current) setPreviewCountLoading(false);
    }
  }

  async function previewRuleRows(options: { sortColumn?: string; sortDirection?: PreviewSortDirection; limit?: 10 | 100; signal?: AbortSignal; requestSignature?: string } = {}) {
    if (!ruleForm || !previewRequestSignature) return;
    const sortColumn = options.sortColumn ?? previewSortColumn;
    const sortDirection = options.sortDirection ?? previewSortDirection;
    const limit = options.limit ?? previewRowsLimit;
    const requestSignature = options.requestSignature ?? previewRequestSignature;
    const requestId = ++previewRowsRequestIdRef.current;
    previewRowsAutoRefreshRef.current = true;
    setPreviewRowsLoading(true);
    setError(null);
    try {
      const result = await fetchJson<RuleRowsPreview>("/api/rules/preview/rows", {
        method: "POST",
        signal: options.signal,
        body: JSON.stringify({
          ...ruleForm,
          ad_limit_type: currentAdLimitType,
          limit,
          preview_sort_column: sortColumn === PREVIEW_RULE_ORDER_COLUMN ? null : sortColumn,
          preview_sort_direction: sortDirection,
          crm_code: normalizeCrmInput(previewCrmCode)
        })
      });
      if (requestId === previewRowsRequestIdRef.current && requestSignature === previewRequestSignatureRef.current) {
        setPreviewRows(result);
      }
    } catch (currentError) {
      if (options.signal?.aborted) return;
      setError(currentError instanceof Error ? currentError.message : "Erro na pre visualizacao.");
    } finally {
      if (requestId === previewRowsRequestIdRef.current) setPreviewRowsLoading(false);
    }
  }

  async function loadRuleSummary(signal?: AbortSignal, requestSignature = summaryRequestSignature) {
    if (!ruleForm || !requestSignature) return;
    const requestId = ++summaryRequestIdRef.current;
    setRuleSummaryLoading(true);
    setError(null);
    try {
      const result = await fetchJson<RuleSummaryResponse>("/api/rules/preview/summary", {
        method: "POST",
        signal,
        body: JSON.stringify({ ...ruleForm, ad_limit_type: currentAdLimitType, items: activeSummaryConfig })
      });
      if (!signal?.aborted && requestId === summaryRequestIdRef.current && requestSignature === summaryRequestSignatureRef.current) {
        setRuleSummary(result);
      }
    } catch (currentError) {
      if (signal?.aborted) return;
      setError(currentError instanceof Error ? currentError.message : "Erro ao gerar resumo.");
    } finally {
      if (!signal?.aborted && requestId === summaryRequestIdRef.current) setRuleSummaryLoading(false);
    }
  }

  async function loadRuleQueryPreview(signal?: AbortSignal, requestSignature = ruleQuerySignature) {
    if (!ruleForm || !requestSignature) return;
    const requestId = ++ruleQueryRequestIdRef.current;
    setRuleQueryLoading(true);
    setError(null);
    try {
      const result = await fetchJson<RuleQueryPreviewResponse>("/api/rules/preview/query", {
        method: "POST",
        signal,
        body: JSON.stringify({ ...ruleForm, ad_limit_type: currentAdLimitType })
      });
      if (!signal?.aborted && requestId === ruleQueryRequestIdRef.current && requestSignature === ruleQuerySignatureRef.current) {
        setRuleQueryPreview(result);
      }
    } catch (currentError) {
      if (signal?.aborted) return;
      setError(currentError instanceof Error ? currentError.message : "Erro ao gerar preview da query.");
    } finally {
      if (!signal?.aborted && requestId === ruleQueryRequestIdRef.current) setRuleQueryLoading(false);
    }
  }

  async function loadRuleHealthchecks(ruleId?: number) {
    if (savingRef.current) return;
    if (healthcheckInFlightRef.current) return;
    healthcheckInFlightRef.current = true;
    setHealthcheckLoading(true);
    setError(null);
    try {
      const result = await fetchJson<{ statuses: RuleHealthcheckStatus[] }>("/api/rules/healthcheck", {
        method: "POST",
        body: JSON.stringify({ rule_id: ruleId ?? null })
      });
      const statuses = new Map(result.statuses.map((status) => [status.rule_id, status]));
      setRules((current) =>
        current.map((rule) => {
          const status = statuses.get(rule.id);
          if (!status) return rule;
          return {
            ...rule,
            health_expected_count: status.expected_count,
            health_published_count: status.published_count,
            health_pending_count: status.pending_count,
            health_unexpected_count: status.unexpected_count,
            health_checked_at: status.checked_at,
            health_error: status.error,
            portal_slug: status.portal_slug ?? rule.portal_slug
          };
        })
      );
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : "Erro ao executar healthcheck.");
    } finally {
      healthcheckInFlightRef.current = false;
      setHealthcheckLoading(false);
    }
  }

  async function updateAutomationActive(automation: PublishAutomation, active: boolean) {
    setSaving(true);
    setError(null);
    try {
      const result = await fetchJson<{ automation: PublishAutomation }>(`/api/automations/${encodeURIComponent(automation.key)}`, {
        method: "PATCH",
        body: JSON.stringify({ active })
      });
      setAutomations((current) =>
        current.map((item) => (item.key === result.automation.key ? result.automation : item))
      );
      setSelectedAutomationKey(result.automation.key);
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : "Erro ao atualizar automacao.");
    } finally {
      setSaving(false);
    }
  }

  async function removeAutomation(automation: PublishAutomation) {
    if (!confirm("Excluir esta automacao? Ela sera desativada e ocultada da listagem.")) return;
    setSaving(true);
    setError(null);
    try {
      await fetchJson(`/api/automations/${encodeURIComponent(automation.key)}`, { method: "DELETE" });
      const nextAutomations = automations.filter((item) => item.key !== automation.key);
      setAutomations(nextAutomations);
      setSelectedAutomationKey(nextAutomations[0]?.key ?? null);
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : "Erro ao excluir automacao.");
    } finally {
      setSaving(false);
    }
  }

  async function saveSummaryConfig(config: RuleSummaryConfigItem[], isCustom: boolean) {
    if (!ruleForm?.id) return;
    setError(null);
    try {
      const result = await fetchJson<{ rule: PublicationRule }>(`/api/rules/${ruleForm.id}`, {
        method: "PATCH",
        body: JSON.stringify({ summary_config: isCustom ? config : null })
      });
      setRuleForm((current) =>
        current?.id === result.rule.id ? { ...current, summary_config: result.rule.summary_config } : current
      );
      setRules((current) =>
        current.map((rule) =>
          rule.id === result.rule.id ? { ...result.rule, portal_name: rule.portal_name } : rule
        )
      );
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : "Erro ao salvar configuracao do resumo.");
    }
  }

  function updateSummaryConfig(config: RuleSummaryConfigItem[]) {
    const isDefaultConfig = JSON.stringify(config) === JSON.stringify(defaultSummaryConfig);
    const nextConfig = isDefaultConfig ? [] : config;
    const isCustom = !isDefaultConfig;
    setSummaryConfig(nextConfig);
    setSummaryConfigCustom(isCustom);
    setRuleForm((current) => (current ? { ...current, summary_config: isCustom ? config : null } : current));
    void saveSummaryConfig(config, isCustom);
  }

  function openPortalFinalListing() {
    if (!portalForm.id) return;
    const portalId = portalForm.id;
    const savedConfig = finalSummaryConfigByPortalRef.current.get(portalId);
    const nextConfig = savedConfig?.config ?? [];
    const nextCustom = savedConfig?.custom ?? false;
    const nextActiveConfig = nextCustom ? nextConfig : defaultFinalSummaryConfig;
    finalListingPortalIdRef.current = portalId;
    activeFinalSummaryConfigRef.current = nextActiveConfig;
    setFinalListingPortalId(portalId);
    setFinalSummaryConfig(nextConfig);
    setFinalSummaryConfigCustom(nextCustom);
    setFinalSummary(null);
    setFinalPreviewRows(null);
    setFinalPreviewRowsLimit(10);
    setFinalPreviewSortColumn(PREVIEW_RULE_ORDER_COLUMN);
    setFinalPreviewSortDirection("asc");
    setFinalPreviewCrmCode("");
    void previewPortalFinalRows({
      portalId,
      limit: 10,
      sortColumn: PREVIEW_RULE_ORDER_COLUMN,
      sortDirection: "asc",
      crmCode: ""
    });
  }

  function closePortalFinalListing() {
    finalSummaryRequestIdRef.current += 1;
    finalPreviewRowsRequestIdRef.current += 1;
    finalListingPortalIdRef.current = null;
    setFinalListingPortalId(null);
    setFinalSummary(null);
    setFinalSummaryLoading(false);
    setFinalPreviewRows(null);
    setFinalPreviewRowsLoading(false);
    setFinalRefreshLoading(false);
  }

  function updateFinalSummaryConfig(config: RuleSummaryConfigItem[]) {
    const isDefaultConfig = JSON.stringify(config) === JSON.stringify(defaultFinalSummaryConfig);
    const nextConfig = isDefaultConfig ? [] : config;
    const nextCustom = !isDefaultConfig;
    const nextActiveConfig = nextCustom ? config : defaultFinalSummaryConfig;
    const portalId = finalListingPortalIdRef.current ?? finalListingPortalId;
    setFinalSummaryConfig(nextConfig);
    setFinalSummaryConfigCustom(nextCustom);
    activeFinalSummaryConfigRef.current = nextActiveConfig;
    if (portalId) {
      finalSummaryConfigByPortalRef.current.set(portalId, { config: nextConfig, custom: nextCustom });
      console.info("[publish-engine] portal-final.summary.config-applied", {
        portalId,
        custom: nextCustom,
        itemCount: nextActiveConfig.length,
        columns: nextActiveConfig.map((item) => item.column)
      });
      void loadPortalFinalSummary({
        portalId,
        items: nextActiveConfig,
        source: "config-apply"
      });
    }
  }

  async function loadPortalFinalSummary(options: {
    signal?: AbortSignal;
    portalId?: number | null;
    items?: RuleSummaryConfigItem[];
    refresh?: boolean;
    source?: string;
  } = {}) {
    const portalId = options.portalId ?? finalListingPortalIdRef.current ?? finalListingPortalId;
    if (!portalId) return;
    const items = options.items ?? activeFinalSummaryConfigRef.current;
    const requestId = ++finalSummaryRequestIdRef.current;
    const clientRequestId = createClientRequestId("portal-final-summary", requestId);
    const startedAt = performance.now();
    setFinalSummaryLoading(true);
    setError(null);
    console.info("[publish-engine] portal-final.summary.start", {
      clientRequestId,
      requestId,
      portalId,
      source: options.source ?? "manual",
      refresh: options.refresh ?? false,
      itemCount: items.length,
      columns: items.map((item) => item.column)
    });
    try {
      const result = await fetchJson<RuleSummaryResponse>("/api/publication/final/preview/summary", {
        method: "POST",
        signal: options.signal,
        body: JSON.stringify({
          portal_id: portalId,
          items,
          refresh: options.refresh ?? false,
          client_request_id: clientRequestId
        })
      });
      if (!options.signal?.aborted && requestId === finalSummaryRequestIdRef.current && portalId === finalListingPortalIdRef.current) {
        setFinalSummary(result);
        console.info("[publish-engine] portal-final.summary.ok", {
          clientRequestId,
          requestId,
          portalId,
          total: result.total,
          resultItems: result.items.length,
          elapsedMs: Math.round(performance.now() - startedAt)
        });
      } else {
        console.info("[publish-engine] portal-final.summary.discarded", {
          clientRequestId,
          requestId,
          portalId,
          aborted: Boolean(options.signal?.aborted),
          latestRequestId: finalSummaryRequestIdRef.current,
          currentPortalId: finalListingPortalIdRef.current,
          elapsedMs: Math.round(performance.now() - startedAt)
        });
      }
    } catch (currentError) {
      if (options.signal?.aborted) return;
      console.error("[publish-engine] portal-final.summary.error", {
        clientRequestId,
        requestId,
        portalId,
        elapsedMs: Math.round(performance.now() - startedAt),
        error: currentError
      });
      setError(currentError instanceof Error ? currentError.message : "Erro ao gerar resumo da listagem final.");
    } finally {
      if (!options.signal?.aborted && requestId === finalSummaryRequestIdRef.current) setFinalSummaryLoading(false);
    }
  }

  async function previewPortalFinalRows(options: {
    portalId?: number;
    sortColumn?: string;
    sortDirection?: PreviewSortDirection;
    limit?: 10 | 100;
    crmCode?: string;
    refresh?: boolean;
  } = {}) {
    const portalId = options.portalId ?? finalListingPortalId;
    if (!portalId) return;
    const sortColumn = options.sortColumn ?? finalPreviewSortColumn;
    const sortDirection = options.sortDirection ?? finalPreviewSortDirection;
    const limit = options.limit ?? finalPreviewRowsLimit;
    const crmCode = normalizeCrmInput(options.crmCode ?? finalPreviewCrmCode);
    const requestId = ++finalPreviewRowsRequestIdRef.current;
    const clientRequestId = createClientRequestId("portal-final-rows", requestId);
    const startedAt = performance.now();
    setFinalPreviewRowsLoading(true);
    setError(null);
    console.info("[publish-engine] portal-final.rows.start", {
      clientRequestId,
      requestId,
      portalId,
      limit,
      sortColumn,
      sortDirection,
      crmCode: crmCode ? "[filtered]" : null,
      refresh: options.refresh ?? false
    });
    try {
      const result = await fetchJson<RuleRowsPreview>("/api/publication/final/preview/rows", {
        method: "POST",
        body: JSON.stringify({
          portal_id: portalId,
          limit,
          preview_sort_column: sortColumn === PREVIEW_RULE_ORDER_COLUMN ? null : sortColumn,
          preview_sort_direction: sortDirection,
          crm_code: crmCode,
          refresh: options.refresh ?? false,
          client_request_id: clientRequestId
        })
      });
      if (requestId === finalPreviewRowsRequestIdRef.current) {
        setFinalPreviewRows(result);
        setFinalPreviewCrmCode(crmCode);
        console.info("[publish-engine] portal-final.rows.ok", {
          clientRequestId,
          requestId,
          portalId,
          rowCount: result.rows.length,
          columnCount: result.columns.length,
          elapsedMs: Math.round(performance.now() - startedAt)
        });
      } else {
        console.info("[publish-engine] portal-final.rows.discarded", {
          clientRequestId,
          requestId,
          portalId,
          latestRequestId: finalPreviewRowsRequestIdRef.current,
          elapsedMs: Math.round(performance.now() - startedAt)
        });
      }
    } catch (currentError) {
      console.error("[publish-engine] portal-final.rows.error", {
        clientRequestId,
        requestId,
        portalId,
        elapsedMs: Math.round(performance.now() - startedAt),
        error: currentError
      });
      setError(currentError instanceof Error ? currentError.message : "Erro na pre visualizacao da listagem final.");
    } finally {
      if (requestId === finalPreviewRowsRequestIdRef.current) setFinalPreviewRowsLoading(false);
    }
  }

  async function refreshPortalFinalListing() {
    const portalId = finalListingPortalIdRef.current ?? finalListingPortalId;
    if (!portalId) return;
    const items = activeFinalSummaryConfigRef.current;
    const requestId = createClientRequestId("portal-final-refresh");
    const startedAt = performance.now();
    setFinalRefreshLoading(true);
    setError(null);
    console.info("[publish-engine] portal-final.refresh.start", {
      clientRequestId: requestId,
      portalId,
      summaryItemCount: items.length,
      summaryColumns: items.map((item) => item.column)
    });
    try {
      await fetchJson("/api/publication/final/refresh", {
        method: "POST",
        body: JSON.stringify({ portal_id: portalId, client_request_id: requestId })
      });
      await Promise.all([
        loadPortalFinalSummary({ portalId, items, refresh: false, source: "refresh-after-final-refresh" }),
        previewPortalFinalRows({ portalId, refresh: false })
      ]);
      console.info("[publish-engine] portal-final.refresh.ok", {
        clientRequestId: requestId,
        portalId,
        elapsedMs: Math.round(performance.now() - startedAt)
      });
    } catch (currentError) {
      console.error("[publish-engine] portal-final.refresh.error", {
        clientRequestId: requestId,
        portalId,
        elapsedMs: Math.round(performance.now() - startedAt),
        error: currentError
      });
      setError(currentError instanceof Error ? currentError.message : "Erro ao atualizar listagem final.");
    } finally {
      setFinalRefreshLoading(false);
    }
  }

  async function refreshStatusListing(rule?: PublicationRule | null) {
    const portalId = rule?.portal_id ?? null;
    const requestId = createClientRequestId("status-final-refresh");
    setFinalRefreshLoading(true);
    setError(null);
    try {
      await fetchJson("/api/publication/final/refresh", {
        method: "POST",
        body: JSON.stringify({ portal_id: portalId, client_request_id: requestId })
      });
      await loadAll();
      await loadRuleHealthchecks(rule?.id);
    } catch (currentError) {
      setError(currentError instanceof Error ? currentError.message : "Erro ao atualizar listagem.");
    } finally {
      setFinalRefreshLoading(false);
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

  async function copyAutomationSql() {
    if (!selectedAutomation?.sql_text) return;
    try {
      await navigator.clipboard.writeText(selectedAutomation.sql_text);
      setAutomationSqlCopied(true);
    } catch {
      setError("Nao foi possivel copiar o SQL da automacao.");
    }
  }

  function editRule(rule: PublicationRule, mode: PanelMode = "view") {
    const savedPriority = rule.publication_priority ?? EMPTY_PUBLICATION_PRIORITY;
    const presetPriority = savedPriority.length ? null : priorityFromPresetSource(rule.source_table ?? "base_imoveis");
    const savedSummaryConfig = Array.isArray(rule.summary_config) ? rule.summary_config : null;
    resetRulePreviewState();
    setPreviewCount(rule.last_count);
    setPreviewLimitedCount(rule.last_limited_count);
    previewCountAutoRefreshRef.current = rule.last_count != null || rule.last_limited_count != null;
    setRuleSummary(null);
    setSummaryConfig(savedSummaryConfig ?? []);
    setSummaryConfigCustom(savedSummaryConfig !== null);
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
      publication_priority: savedPriority.length ? savedPriority : presetPriority ?? EMPTY_PUBLICATION_PRIORITY,
      summary_config: savedSummaryConfig
    });
  }

  function returnToPortalView() {
    if (portalForm.id) {
      const savedPortal = portals.find((portal) => portal.id === portalForm.id);
      if (savedPortal) editPortal(savedPortal);
    }
    setPortalMode("view");
  }

  function cancelPortalEdit() {
    if (portalForm.id) {
      returnToPortalView();
      return;
    }

    const fallbackPortal = selectedPortalId
      ? portals.find((portal) => portal.id === selectedPortalId) ?? portals[0]
      : portals[0];
    if (fallbackPortal) {
      selectPortal(fallbackPortal, "view");
      return;
    }

    setPortalForm(EMPTY_PORTAL);
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

  function cancelRuleEdit() {
    if (ruleForm?.id) {
      returnToRuleView();
      return;
    }

    setRuleForm(null);
    resetRulePreviewState();
    setRuleSummary(null);
    setSummaryConfig([]);
    setSummaryConfigCustom(false);
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

  const portalEditorFullscreen = activeView === "portals" && portalMode === "edit";
  const ruleEditorFullscreen = activeView === "rules" && Boolean(ruleForm) && isRuleEditing;
  const detailsEditorFullscreen = portalEditorFullscreen || ruleEditorFullscreen;

  return (
    <main className={`app-shell ${detailsPanelCollapsed ? "details-panel-collapsed" : ""} ${portalEditorFullscreen ? "portal-editor-fullscreen" : ""} ${ruleEditorFullscreen ? "rule-editor-fullscreen" : ""}`}>
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
          <button className={`nav-item ${activeView === "automations" ? "selected" : ""}`} type="button" onClick={openAutomationsView}>
            <MaterialIcon name="bolt" size={18} />
            Automações
          </button>
        </nav>
        <nav className="sidebar-nav sidebar-nav-bottom" aria-label="Status">
          <button className={`nav-item ${activeView === "status" ? "selected" : ""}`} type="button" onClick={openStatusView}>
            <MaterialIcon name="monitor_heart" size={18} />
            Listagem
          </button>
        </nav>
      </aside>

      <section className="content">
        <header className="topbar">
          <div className="topbar-heading">
            <div className="topbar-title-row">
              <h1>{activeViewTitle}</h1>
              <button
                className="ghost-button topbar-refresh-button"
                type="button"
                onClick={() => void refreshAllData()}
                disabled={loading}
                title="Atualizar dados"
                aria-label="Atualizar dados"
              >
                {loading ? <Loader2 className="spin" size={17} /> : <MaterialIcon name="refresh" size={18} />}
              </button>
            </div>
            <p>
              {activeView === "automations"
                ? `${formatNumber(automations.length)} automacoes - ${formatNumber(activeAutomations.length)} ativas`
                : metadata
                ? `${formatNumber(portals.length)} portais - ${formatNumber(rules.length)} regras - ${formatNumber(activeRules.length)} ativas - ${formatNumber(metadata.counts.base_imoveis)} imoveis - ${formatNumber(metadata.counts.publish_locks)} locks`
                : "Carregando metadados"}
            </p>
          </div>
          <div className="topbar-actions">
            <div className="search-box">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
              />
            </div>
            {activeView === "portals" || activeView === "rules" ? (
            <button
              className={activeView === "rules" ? "primary-button topbar-primary-action new-rule-button" : "secondary-button add-portal-button"}
              type="button"
              onClick={activeView === "portals" ? newPortal : newRule}
            >
              <MaterialIcon name={activeView === "rules" ? "add_circle" : "add"} size={activeView === "rules" ? 20 : 18} />
              {activeView === "portals" ? "Adicionar portal" : "Nova regra"}
            </button>
            ) : activeView === "status" ? (
            <button className="secondary-button add-portal-button" type="button" onClick={() => void refreshStatusListing(null)} disabled={healthcheckLoading || finalRefreshLoading}>
              {healthcheckLoading || finalRefreshLoading ? <Loader2 className="spin" size={16} /> : <MaterialIcon name="refresh" size={18} />}
              Atualizar listagem
            </button>
            ) : null}
          </div>
        </header>

        {error && <div className="error-banner">{error}</div>}

        {activeView === "portals" ? (
        <PortalDirectory
          loading={loading}
          portals={visiblePortals}
          selectedPortalId={selectedPortalId}
          onSelect={(portal) => selectPortal(portal)}
          onEdit={(portal) => selectPortal(portal, "edit")}
        />
        ) : activeView === "automations" ? (
        <AutomationDirectory
          loading={loading}
          automations={visibleAutomations}
          selectedAutomationKey={selectedAutomationKey}
          onSelect={(automation) => setSelectedAutomationKey(automation.key)}
        />
        ) : activeView === "status" ? (
        <StatusDirectory
          loading={loading}
          groups={statusPortalGroups}
          visibleRuleCount={visibleStatusRules.length}
          selectedRuleId={selectedStatusRuleId}
          onSelectRule={setSelectedStatusRuleId}
        />
        ) : (
        <RuleDirectory
          loading={loading}
          rows={ruleTreeRows}
          visibleRuleCount={visibleRules.length}
          selectedRuleId={ruleForm?.id}
          portalById={portalById}
          onSelect={(rule) => editRule(rule, "view")}
          onEdit={(rule) => editRule(rule, "edit")}
        />
        )}
      </section>

      <aside className={`portal-editor-panel ${detailsPanelCollapsed && !detailsEditorFullscreen ? "collapsed" : ""}`}>
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
            <span>
              {activeView === "portals"
                ? "Detalhes do portal"
                : activeView === "automations"
                  ? "Detalhes da automacao"
                  : activeView === "status"
                    ? "Atualizar listagem"
                    : "Detalhes da regra"}
            </span>
          )}
        </div>
        {(detailsEditorFullscreen || !detailsPanelCollapsed) && (activeView === "portals" ? (
        <form className={`portal-form ${isPortalEditing ? "edit-mode portal-edit-fullscreen" : "view-mode"}`} onSubmit={savePortal}>
          {isPortalEditing ? (
          <>
          <div className="panel-heading inset rule-editor-heading portal-editor-heading">
            <div className="rule-editor-heading-copy">
              <span className="portal-logo rule-editor-logo">
                {portalForm.logo_url ? <img src={portalForm.logo_url} alt="" /> : <Globe2 size={22} />}
              </span>
              <span>
                <h2>{portalForm.id ? "Editar portal" : "Novo portal"}</h2>
                <span>{portalForm.slug.trim() || "Configure o identificador do portal"}</span>
              </span>
            </div>
            <div className="panel-heading-actions">
              {portalForm.id && (
              <button className="secondary-button compact-button" type="button" onClick={returnToPortalView}>
                <MaterialIcon name="arrow_back" size={17} />
                Voltar
              </button>
              )}
              {portalForm.id && (
              <button className="danger-button" type="button" onClick={() => void removePortal(portalForm.id!)}>
                <MaterialIcon name="delete" size={18} />
              </button>
              )}
              <button className="ghost-button compact-button" type="button" onClick={cancelPortalEdit}>
                <MaterialIcon name="close" size={18} />
                Cancelar
              </button>
              <button className="primary-button compact-button" type="submit" disabled={saving}>
                {saving ? <Loader2 className="spin" size={16} /> : <MaterialIcon name="check" size={18} />}
                Salvar portal
              </button>
            </div>
          </div>

          <div className="portal-config-band">
            <div className="rule-config-card portal-config-main-card">
              <div className="rule-config-card-heading">
                <span>Configuracao</span>
                <small>Identificacao e marca</small>
              </div>
              <div className="portal-identity-grid">
                <div className="logo-uploader portal-logo-uploader">
                  <div className="logo-preview portal-logo-preview">
                    {portalForm.logo_url ? <img src={portalForm.logo_url} alt="" /> : <Image size={28} />}
                  </div>
                  <label className="secondary-button logo-upload-button" htmlFor="portal-logo-upload">
                    <MaterialIcon name="image" size={17} />
                    Logo
                  </label>
                  <input id="portal-logo-upload" type="file" accept="image/*" onChange={updatePortalLogo} />
                </div>

                <label>
                  Nome do portal
                  <input
                    value={portalForm.name}
                    onChange={(event) => setPortalForm({ ...portalForm, name: event.target.value })}
                    required
                  />
                </label>

                <label>
                  <span className="field-label-with-help">
                    Slug
                    <span className="field-help-icon" title={PORTAL_SLUG_HELP} aria-label={PORTAL_SLUG_HELP}>
                      <MaterialIcon name="info" size={15} />
                    </span>
                  </span>
                  <input
                    value={portalForm.slug}
                    pattern="[a-z0-9_]+"
                    placeholder="grupo_zap"
                    title="Use apenas letras minusculas, numeros e underscore."
                    onChange={(event) => setPortalForm({ ...portalForm, slug: event.target.value })}
                    required
                  />
                </label>

                <label className="portal-description-field">
                  Descricao
                  <textarea
                    value={portalForm.description ?? ""}
                    onChange={(event) => setPortalForm({ ...portalForm, description: event.target.value })}
                    rows={2}
                  />
                </label>
              </div>
            </div>

            <div className="rule-config-card portal-config-toggle-card">
              <div className="rule-config-card-heading">
                <span>Operacao</span>
                <small>Status e volume</small>
              </div>
              <div className="portal-metrics-grid">
                <div className="summary-status">
                  <span>Cotas</span>
                  <strong>{formatNumber(portalFormTotal)}</strong>
                </div>
                <div className="summary-status">
                  <span>Regras</span>
                  <strong>{formatNumber(selectedPortalRules.length)}</strong>
                </div>
                <label className="toggle-field portal-status-toggle">
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
                <label className="portal-refresh-time-field">
                  <span>Atualização completa</span>
                  <input
                    type="time"
                    value={portalForm.final_listing_refresh_time}
                    onChange={(event) =>
                      setPortalForm({ ...portalForm, final_listing_refresh_time: normalizePortalRefreshTime(event.target.value) })
                    }
                  />
                </label>
              </div>
            </div>
          </div>

          <div className="rule-editor-section-divider portal-editor-divider" aria-hidden="true" />

          <section className="rule-editor-panel portal-editor-quota-panel">
            <div className="rule-editor-panel-title">
              <MaterialIcon name="sell" size={42} />
              <span>Tipos de anuncio</span>
            </div>
            <div className="filter-editor-card portal-ad-types-card">
              <div className="filter-editor-heading portal-ad-types-heading">
                <div>
                  <h3>Cotas do portal</h3>
                  <span>{formatNumber(portalForm.ad_types.length)} tipos - {formatNumber(portalFormTotal)} cotas</span>
                </div>
                <button className="secondary-button compact-button" type="button" onClick={addPortalAdType}>
                  <MaterialIcon name="add" size={18} />
                  Tipo
                </button>
              </div>

              <div className="portal-ad-type-list">
                {orderedPortalFormAdTypes.map(({ adType, index }) => (
                  <div className="portal-ad-type-row" key={index}>
                    <label className="portal-ad-type-name-field">
                      Tipo
                      <input
                        value={adType.name}
                        placeholder="Padrao"
                        title={AD_TYPE_NAME_HELP}
                        aria-label={AD_TYPE_NAME_HELP}
                        onChange={(event) => updatePortalAdType(index, { name: event.target.value })}
                      />
                    </label>
                    <label>
                      Cota
                      <NumericInput
                        allowDecimal={false}
                        allowNegative={false}
                        value={adType.quantity}
                        placeholder="Qtd."
                        onValueChange={(value) => updatePortalAdType(index, { quantity: localizedNumberToNumber(value) })}
                      />
                    </label>
                    <label>
                      <span className="field-label-with-help">
                        Tier
                        <span className="field-help-icon" title={AD_TIER_HELP} aria-label={AD_TIER_HELP}>
                          <MaterialIcon name="info" size={14} />
                        </span>
                      </span>
                      <NumericInput
                        allowDecimal={false}
                        allowNegative={false}
                        min={1}
                        max={10}
                        value={adType.tier}
                        placeholder="Tier"
                        onValueChange={(value) => updatePortalAdType(index, { tier: normalizeAdTier(localizedNumberToNumber(value)) })}
                      />
                    </label>
                    <button
                      className="danger-button portal-ad-type-remove"
                      type="button"
                      title="Remover tipo"
                      aria-label="Remover tipo"
                      onClick={() =>
                        setPortalForm({
                          ...portalForm,
                          ad_types: portalForm.ad_types.filter((_, itemIndex) => itemIndex !== index)
                        })
                      }
                    >
                      <MaterialIcon name="delete" size={18} />
                    </button>
                  </div>
                ))}
                {!portalForm.ad_types.length && <div className="quota-empty portal-empty-state">Sem tipos cadastrados.</div>}
              </div>
            </div>
          </section>
          </>
          ) : (
          <>
          <div className="panel-mode-actions">
            <button className="secondary-button compact-button" type="button" onClick={() => setPortalMode("edit")}>
              <MaterialIcon name="edit" size={17} />
              Editar
            </button>
          </div>
          <div className="portal-editor-header">
            <div className="logo-uploader">
              <div className="logo-preview">
                {portalForm.logo_url ? <img src={portalForm.logo_url} alt="" /> : <Image size={26} />}
              </div>
            </div>
            <div className="portal-title-fields">
              <label>
                Nome do portal
                <span className="view-field">{displayValue(portalForm.name)}</span>
              </label>
              <label>
                <span className="field-label-with-help">
                  Slug
                  <span className="field-help-icon" title={PORTAL_SLUG_HELP} aria-label={PORTAL_SLUG_HELP}>
                    <MaterialIcon name="info" size={15} />
                  </span>
                </span>
                <span className="view-field code-view-field portal-slug-view">{displayValue(portalForm.slug)}</span>
              </label>
              <label>
                Descricao
                <span className="view-field multiline">{displayValue(portalForm.description)}</span>
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
            <div className="summary-status">
              <span>Status</span>
              <strong>{portalForm.active ? "Ativo" : "Inativo"}</strong>
            </div>
            <div>
              <span>Atualização</span>
              <strong>{portalForm.final_listing_refresh_time}</strong>
            </div>
          </div>

          <button className="portal-final-listing-button" type="button" onClick={openPortalFinalListing} disabled={!portalForm.id}>
            <span className="portal-final-listing-icon">
              <MaterialIcon name="table_view" size={22} />
            </span>
            <span>
              <strong>Listagem final</strong>
              <small>Resumo e pre visualizacao do portal</small>
            </span>
            <MaterialIcon name="arrow_forward" size={18} />
          </button>

          <div className="quota-editor">
            <div className="quota-heading">
              <span>Tipos de anuncio</span>
              <strong>{formatNumber(portalFormTotal)}</strong>
            </div>
            <div className="quota-list">
              {orderedPortalFormAdTypes.map(({ adType, index }) => (
                <div className="quota-row view-row" key={index}>
                  <span className="view-field">{displayValue(adType.name)}</span>
                  <span className="view-field number">{formatNumber(adType.quantity || 0)}</span>
                  <span className="view-field number">{formatNumber(adType.tier)}</span>
                </div>
              ))}
              {!portalForm.ad_types.length && <div className="quota-empty">Sem tipos cadastrados.</div>}
            </div>
          </div>
          </>
          )}
        </form>

        ) : activeView === "automations" ? (
          <section className="status-side-panel automation-side-panel">
            <div className="panel-heading inset">
              <div>
                <h2>{selectedAutomation ? selectedAutomation.name : "Automacoes"}</h2>
                <span>
                  {selectedAutomation
                    ? `${selectedAutomation.schema_name}.${selectedAutomation.table_name}.${selectedAutomation.target_column}`
                    : `${formatNumber(automations.length)} cadastradas`}
                </span>
              </div>
              {selectedAutomation && (
                <div className="panel-heading-actions">
                  <button
                    className="danger-button compact-button"
                    type="button"
                    onClick={() => void removeAutomation(selectedAutomation)}
                    disabled={saving}
                  >
                    <MaterialIcon name="delete" size={17} />
                    Excluir
                  </button>
                </div>
              )}
            </div>

            {selectedAutomation ? (
              <>
                <div className="status-detail-card automation-detail-card">
                  <div className="status-detail-title">
                    <span className={`status-pill ${selectedAutomation.active ? "active" : "inactive"}`}>
                      {selectedAutomation.active ? "Ativa" : "Inativa"}
                    </span>
                    <span>{selectedAutomation.key}</span>
                  </div>

                  <div className="healthcheck-grid status-detail-grid automation-detail-grid">
                    <div>
                      <span>Base</span>
                      <strong>{selectedAutomation.database_name}</strong>
                    </div>
                    <div>
                      <span>Tabela</span>
                      <strong>{`${selectedAutomation.schema_name}.${selectedAutomation.table_name}`}</strong>
                    </div>
                    <div>
                      <span>Coluna</span>
                      <strong>{selectedAutomation.target_column}</strong>
                    </div>
                    <div>
                      <span>Modo</span>
                      <strong>{selectedAutomation.run_mode === "trigger_db" ? "Trigger DB" : selectedAutomation.run_mode}</strong>
                    </div>
                    <div>
                      <span>Ultima execucao</span>
                      <strong>{selectedAutomation.last_run_at ? formatTimestamp(selectedAutomation.last_run_at) : "-"}</strong>
                    </div>
                    <div>
                      <span>Afetados</span>
                      <strong>
                        {selectedAutomation.last_affected_count == null ? "-" : formatNumber(selectedAutomation.last_affected_count)}
                      </strong>
                    </div>
                  </div>

                  <label className="toggle-field automation-status-toggle">
                    <input
                      type="checkbox"
                      checked={selectedAutomation.active}
                      disabled={saving}
                      onChange={(event) => void updateAutomationActive(selectedAutomation, event.target.checked)}
                    />
                    <span className="toggle-switch" aria-hidden="true" />
                    <span>
                      <strong>Automacao</strong>
                      <small>{selectedAutomation.active ? "Ativa" : "Inativa"}</small>
                    </span>
                  </label>
                </div>

                <div className="status-query-card automation-query-card">
                  <div className="status-query-title-row">
                    <div className="status-query-heading">
                      <span>SQL da automacao</span>
                      <strong>{selectedAutomation.function_name ?? selectedAutomation.trigger_name ?? selectedAutomation.key}</strong>
                    </div>
                    <button className="ghost-button compact-button" type="button" onClick={() => void copyAutomationSql()}>
                      <MaterialIcon name={automationSqlCopied ? "done" : "content_copy"} size={17} />
                      {automationSqlCopied ? "Copiado" : "Copiar"}
                    </button>
                  </div>
                  <pre>{selectedAutomation.sql_text}</pre>
                </div>
              </>
            ) : (
              <>
                <div className="healthcheck-grid status-summary-grid">
                  <div className="ok">
                    <span>Ativas</span>
                    <strong>{formatNumber(activeAutomations.length)}</strong>
                  </div>
                  <div className="unknown">
                    <span>Inativas</span>
                    <strong>{formatNumber(automations.length - activeAutomations.length)}</strong>
                  </div>
                </div>
                <div className="healthcheck-message ok">
                  Selecione uma automacao para ver detalhes e SQL.
                </div>
              </>
            )}
          </section>
        ) : activeView === "status" ? (
          <section className="status-side-panel">
            <div className="panel-heading inset">
              <div>
                <h2>{selectedStatusRule ? selectedStatusRule.name : "Atualizar listagem"}</h2>
                <span>
                  {selectedStatusRule
                    ? `${selectedStatusPortal?.name ?? selectedStatusRule.portal_name ?? "Portal"} - ${statusLabel(selectedStatusRule)}`
                    : `${formatNumber(monitoredActiveRules.length)} monitoradas`}
                </span>
              </div>
              <div className="panel-heading-actions">
                {selectedStatusRule && (
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    onClick={() => {
                      setActiveView("rules");
                      editRule(selectedStatusRule, "view");
                    }}
                  >
                    <MaterialIcon name="open_in_new" size={17} />
                    Regra
                  </button>
                )}
                <button className="secondary-button compact-button" type="button" onClick={() => void refreshStatusListing(selectedStatusRule)} disabled={healthcheckLoading || finalRefreshLoading}>
                  {healthcheckLoading || finalRefreshLoading ? <Loader2 className="spin" size={16} /> : <MaterialIcon name="refresh" size={17} />}
                  Atualizar listagem
                </button>
              </div>
            </div>
            {selectedStatusRule ? (
              <>
                <div className="status-detail-card">
                  <div className="status-detail-title">
                    <span className={`healthcheck-badge ${ruleHealthTone(selectedStatusRule)}`}>{statusLabel(selectedStatusRule)}</span>
                    <span>{formatTimestamp(selectedStatusRule.health_checked_at)}</span>
                  </div>
                  <div className="healthcheck-grid status-detail-grid">
                    <div>
                      <span>Esperados</span>
                      <strong>{selectedStatusRule.health_expected_count == null ? "-" : formatNumber(selectedStatusRule.health_expected_count)}</strong>
                    </div>
                    <div>
                      <span>Publicados</span>
                      <strong>{selectedStatusRule.health_published_count == null ? "-" : formatNumber(selectedStatusRule.health_published_count)}</strong>
                    </div>
                    <div className={(selectedStatusRule.health_pending_count ?? 0) > 0 ? "warning" : "ok"}>
                      <span>Pendentes</span>
                      <strong>{selectedStatusRule.health_pending_count == null ? "-" : formatNumber(selectedStatusRule.health_pending_count)}</strong>
                    </div>
                    <div className={(selectedStatusRule.health_unexpected_count ?? 0) > 0 ? "warning" : "ok"}>
                      <span>Indevidos</span>
                      <strong>{selectedStatusRule.health_unexpected_count == null ? "-" : formatNumber(selectedStatusRule.health_unexpected_count)}</strong>
                    </div>
                    <div>
                      <span>Tipo</span>
                      <strong>{selectedStatusRule.use_ad_limit ? selectedStatusRule.ad_limit_type ?? "total" : "total"}</strong>
                    </div>
                  </div>
                  {selectedStatusRule.health_error && <div className="healthcheck-message error">{selectedStatusRule.health_error}</div>}
                </div>

                <div className="status-query-card">
                  <div className="status-query-heading">
                    <span>Query de publicados</span>
                    <strong>{selectedStatusRule.portal_slug ? statusFinalViewName(selectedStatusRule.portal_slug) : "Listagem final indisponivel"}</strong>
                  </div>
                  <pre>{buildStatusPublishedQuery(selectedStatusRule)}</pre>
                </div>

                <div className="status-query-card">
                  <div className="status-query-heading">
                    <span>Query de publicados indevidos</span>
                    <strong>Fora da listagem final</strong>
                  </div>
                  <pre>{buildStatusUnexpectedQuery(selectedStatusRule)}</pre>
                </div>
              </>
            ) : (
              <>
                <div className="healthcheck-grid status-summary-grid">
                  <div className="ok">
                    <span>OK</span>
                    <strong>{formatNumber(monitoredActiveRules.filter((rule) => ruleHealthTone(rule) === "ok").length)}</strong>
                  </div>
                  <div className="warning">
                    <span>Divergentes</span>
                    <strong>{formatNumber(monitoredActiveRules.filter((rule) => ruleHealthTone(rule) === "warning").length)}</strong>
                  </div>
                  <div className="error">
                    <span>Com erro</span>
                    <strong>{formatNumber(monitoredActiveRules.filter((rule) => ruleHealthTone(rule) === "error").length)}</strong>
                  </div>
                  <div className="unknown">
                    <span>Pendentes</span>
                    <strong>{formatNumber(monitoredActiveRules.filter((rule) => ruleHealthTone(rule) === "unknown").length)}</strong>
                  </div>
                </div>
                <div className="healthcheck-message ok">
                  Verificacao automatica a cada {formatNumber(HEALTHCHECK_INTERVAL_MINUTES)} min.
                </div>
              </>
            )}
          </section>
        ) : ruleForm ? (
            <form className={`rule-form ${isRuleEditing ? "edit-mode rule-edit-fullscreen" : "view-mode"}`} onSubmit={saveRule}>
              <div className="panel-heading inset rule-editor-heading">
                <div className="rule-editor-heading-copy">
                  <span className="portal-logo rule-editor-logo">
                    {selectedRulePortal?.logo_url ? <img src={selectedRulePortal.logo_url} alt="" /> : <Globe2 size={22} />}
                  </span>
                  <span>
                    <h2>{isRuleEditing ? (ruleForm.id ? "Editar regra" : "Nova regra") : "Detalhes da regra"}</h2>
                    <span>{selectedRulePortal?.name ?? "Sem portal vinculado"}</span>
                  </span>
                </div>
                {!isRuleEditing && (
                  <button className="secondary-button compact-button" type="button" onClick={() => setRuleMode("edit")}>
                    <MaterialIcon name="edit" size={17} />
                    Editar
                  </button>
                )}
                {isRuleEditing && (
                  <div className="panel-heading-actions">
                    {ruleForm.id && (
                    <button className="secondary-button compact-button" type="button" onClick={returnToRuleView}>
                      <MaterialIcon name="arrow_back" size={17} />
                      Voltar
                    </button>
                    )}
                    {ruleForm.id && (
                    <button className="danger-button" type="button" onClick={() => void removeRule(ruleForm.id!)}>
                      <MaterialIcon name="delete" size={18} />
                    </button>
                    )}
                    <button className="ghost-button compact-button" type="button" onClick={cancelRuleEdit}>
                      <MaterialIcon name="close" size={18} />
                      Cancelar
                    </button>
                    <button className="primary-button compact-button" type="submit" disabled={saving}>
                      {saving ? <Loader2 className="spin" size={16} /> : <MaterialIcon name="check" size={18} />}
                      Salvar regra
                    </button>
                  </div>
                )}
              </div>

              <div className="rule-config-band">
                <div className="rule-config-card rule-config-main-card">
                  <div className="rule-config-card-heading">
                    <span>Configuração</span>
                    <small>Identificação e origem</small>
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
                    <SourceViewPicker
                      options={ruleSourceOptions}
                      value={ruleForm.source_table}
                      onSelect={updateRuleSource}
                    />
                  ) : (
                    <span className="view-field">
                      {displayValue(sourceViewDisplayLabel(ruleSourceOptions.find((option) => option.value === ruleForm.source_table)) ?? ruleForm.source_table)}
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
                </div>

                <div className="rule-config-card rule-config-toggle-card">
                  <div className="rule-config-card-heading">
                    <span>Configuração</span>
                    <small>Comportamento da regra</small>
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
                    <small>{ruleForm.use_ad_limit ? `${adLimitTypeLabel(currentAdLimitType, selectedRulePortal)}: ${formatNumber(currentAdLimitQuota ?? 0)}` : "Sem limite"}</small>
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
                      ? `${adLimitTypeLabel(currentAdLimitType, selectedRulePortal)} (${formatNumber(currentAdLimitQuota ?? 0)})`
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
                        {selectedRulePortal ? `${adLimitTypeLabel(currentAdLimitType, selectedRulePortal)} (${formatNumber(currentAdLimitQuota ?? 0)})` : "Sem portal"}
                      </span>
                    )}
                  </label>
                </div>
              )}
                </div>
              </div>

              <div className="rule-editor-section-divider rule-editor-left-divider" aria-hidden="true" />

              <div className="rule-editor-stage">
                <section className="rule-editor-panel rule-editor-filters-panel">
                  <div className="rule-editor-panel-title">
                    <Filter size={35} />
                    <span>Filtros</span>
                  </div>

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
                {queryPanelOpen && (
                  <div className="query-preview">
                    <div className="query-preview-heading">
                      <span>{ruleQueryPreview?.view_name ? `View ${ruleQueryPreview.view_name}` : "Query da regra"}</span>
                      <button className="ghost-button compact-button" type="button" onClick={() => void copyCurrentRuleQuery()} disabled={!currentRuleQuery || ruleQueryLoading}>
                        <MaterialIcon name={queryCopied ? "done" : "content_copy"} size={17} />
                        {queryCopied ? "Copiada" : "Copiar"}
                      </button>
                    </div>
                    <pre>
                      <code>{ruleQueryLoading ? "Gerando query..." : currentRuleQuery || "Query indisponivel."}</code>
                    </pre>
                  </div>
                )}
              </section>

                </section>

                <section className="rule-editor-panel rule-editor-priorities-panel">
                  <div className="rule-editor-panel-title">
                    <MaterialIcon name="swap_vert" size={42} />
                    <span>Prioridades</span>
                  </div>
                  <div className="filter-editor-card priority-editor-card">
                    <div className="filter-editor-heading priority-heading">
                      <div>
                        <h3>Stack</h3>
                        <span className="priority-heading-meta">
                          <span>{publicationPrioritySummary(ruleForm.publication_priority, filterableColumns)}</span>
                          {inheritedPriorityPresetName && (
                            <span className="inherited-priority-badge">herdadas de {inheritedPriorityPresetName}</span>
                          )}
                        </span>
                      </div>
                    </div>
                    <PublicationPriorityEditor
                      columns={filterableColumns}
                      value={ruleForm.publication_priority}
                      onChange={(publicationPriority) => setRuleForm({ ...ruleForm, publication_priority: publicationPriority })}
                      readOnly={!isRuleEditing}
                    />
                  </div>
                </section>

                <section className="rule-editor-panel rule-editor-summary-panel">
                  <div className="rule-editor-panel-title">
                    <MaterialIcon name="donut_large" size={42} />
                    <span>Resumo</span>
                  </div>

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
                <button className="secondary-button" type="button" onClick={() => void previewRule()} disabled={previewCountLoading}>
                  {previewCountLoading ? <Loader2 className="spin" size={16} /> : <MaterialIcon name="visibility" size={18} />}
                  Calcular
                </button>
                )}
              </div>

              <RuleSummarySection
                columns={filterableColumns}
                config={activeSummaryConfig}
                defaultConfig={defaultSummaryConfig}
                data={ruleSummary}
                loading={ruleSummaryLoading}
                onConfigChange={updateSummaryConfig}
                onRefresh={() => void loadRuleSummary()}
              />

              <div className="rule-editor-section-divider rule-editor-summary-divider" aria-hidden="true" />

              <RulePreviewRows
                previewRows={previewRows}
                previewRowsLimit={previewRowsLimit}
                previewRowsLoading={previewRowsLoading}
                previewSortColumn={previewSortColumn}
                previewSortDirection={previewSortDirection}
                crmCode={previewCrmCode}
                onCrmCodeChange={setPreviewCrmCode}
                onCrmCodeBlur={() => setPreviewCrmCode((value) => normalizeCrmInput(value))}
                onSortColumnChange={(sortColumn) => {
                  setPreviewSortColumn(sortColumn);
                  if (previewRows) void previewRuleRows({ sortColumn });
                }}
                onSortDirectionChange={(sortDirection) => {
                  setPreviewSortDirection(sortDirection);
                  if (previewRows) void previewRuleRows({ sortDirection });
                }}
                onLimitChange={(limit) => {
                  setPreviewRowsLimit(limit);
                  setPreviewRows(null);
                  if (previewRowsAutoRefreshRef.current) void previewRuleRows({ limit });
                }}
                onPreview={() => void previewRuleRows()}
              />

                </section>
              </div>

              {isRuleEditing && (
              <div className="form-actions end">
                <button className="ghost-button" type="button" onClick={cancelRuleEdit}>
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
              <button className="primary-button topbar-primary-action new-rule-button" type="button" onClick={newRule}>
                <MaterialIcon name="add_circle" size={20} />
                Nova regra
              </button>
            </div>
          </section>
        ))}
      </aside>

      {finalListingPortal && (
        <PortalFinalListingModal
          portal={finalListingPortal}
          columns={finalSummaryColumns}
          summaryConfig={activeFinalSummaryConfig}
          defaultSummaryConfig={defaultFinalSummaryConfig}
          summaryData={finalSummary}
          summaryLoading={finalSummaryLoading}
          previewRows={finalPreviewRows}
          previewRowsLimit={finalPreviewRowsLimit}
          previewRowsLoading={finalPreviewRowsLoading}
          previewSortColumn={finalPreviewSortColumn}
          previewSortDirection={finalPreviewSortDirection}
          crmCode={finalPreviewCrmCode}
          refreshLoading={finalRefreshLoading}
          onClose={closePortalFinalListing}
          onRefresh={() => void refreshPortalFinalListing()}
          onSummaryConfigChange={updateFinalSummaryConfig}
          onSummaryRefresh={() => void loadPortalFinalSummary()}
          onSortColumnChange={(sortColumn) => {
            setFinalPreviewSortColumn(sortColumn);
            if (finalPreviewRows) void previewPortalFinalRows({ sortColumn });
          }}
          onSortDirectionChange={(sortDirection) => {
            setFinalPreviewSortDirection(sortDirection);
            if (finalPreviewRows) void previewPortalFinalRows({ sortDirection });
          }}
          onLimitChange={(limit) => {
            setFinalPreviewRowsLimit(limit);
            setFinalPreviewRows(null);
            void previewPortalFinalRows({ limit });
          }}
          onCrmCodeChange={setFinalPreviewCrmCode}
          onCrmCodeBlur={() => setFinalPreviewCrmCode((value) => normalizeCrmInput(value))}
          onPreview={() => void previewPortalFinalRows()}
        />
      )}
    </main>
  );
}

function baseSourceViewOption(): SourceViewOption {
  return {
    value: "base_imoveis",
    ruleName: "Base principal",
    viewName: "base_imoveis",
    groupId: "base",
    groupLabel: "Origem principal",
    groupDetail: "Tabela base para novas regras",
    groupIcon: "table_view",
    badge: "base"
  };
}

function buildSourceViewOption(
  viewName: string,
  viewType: "view" | "materialized",
  rule: PublicationRule | undefined,
  portalById: Map<number, Portal>
): SourceViewOption {
  if (!rule) {
    return {
      value: viewName,
      ruleName: viewName,
      viewName,
      groupId: "technical",
      groupLabel: "Views tecnicas",
      groupDetail: "Views sem regra cadastrada",
      groupIcon: "schema",
      badge: sourceViewBadge(viewType)
    };
  }

  const portal = rule.portal_id == null ? null : portalById.get(rule.portal_id) ?? null;
  const portalName = portal?.name ?? rule.portal_name ?? "Sem portal";
  const portalSlug = portal?.slug ?? rule.portal_slug;

  return {
    value: viewName,
    ruleName: rule.name,
    viewName,
    groupId: rule.portal_id == null ? "no-portal" : `portal:${rule.portal_id}`,
    groupLabel: portalName,
    groupDetail: portalSlug ? `Portal ${portalSlug}` : rule.portal_id == null ? "Regras sem portal vinculado" : "Regras deste portal",
    groupIcon: rule.portal_id == null ? "link_off" : "public",
    badge: sourceViewBadge(viewType)
  };
}

function unavailableSourceViewOption(viewName: string): SourceViewOption {
  return {
    value: viewName,
    ruleName: viewName,
    viewName,
    groupId: "unavailable",
    groupLabel: "Indisponiveis",
    groupDetail: "Origem salva, mas nao retornada pelo banco",
    groupIcon: "warning",
    badge: "off",
    unavailable: true
  };
}

function compareSourceViewOptions(left: SourceViewOption, right: SourceViewOption) {
  const groupOrder = sourceViewGroupOrder(left) - sourceViewGroupOrder(right);
  if (groupOrder) return groupOrder;

  const groupNameOrder = left.groupLabel.localeCompare(right.groupLabel, "pt-BR");
  if (groupNameOrder) return groupNameOrder;

  return left.ruleName.localeCompare(right.ruleName, "pt-BR");
}

function sourceViewGroupOrder(option: SourceViewOption) {
  if (option.groupId.startsWith("portal:")) return 1;
  if (option.groupId === "no-portal") return 2;
  if (option.groupId === "technical") return 3;
  if (option.groupId === "unavailable") return 4;
  return 0;
}

function sourceViewBadge(viewType: "view" | "materialized") {
  return viewType === "materialized" ? "mat" : "view";
}

function sourceViewDisplayLabel(option: SourceViewOption | undefined) {
  if (!option) return null;
  return option.ruleName === option.viewName ? option.viewName : `${option.ruleName} (${option.viewName})`;
}

function buildFinalListingSummaryColumns(baseColumns: typeof FINAL_LISTING_COLUMNS) {
  return [
    ...FINAL_LISTING_COLUMNS.map((column) => ({
      ...column,
      column_name: finalListingSummaryColumnKey("final", column.column_name),
      display_name: `Listagem final / ${column.display_name ?? column.column_name}`
    })),
    ...baseColumns
      .filter((column) => column.filter_kind !== "other")
      .map((column) => ({
        ...column,
        column_name: finalListingSummaryColumnKey("base", column.column_name),
        display_name: `Base / ${column.display_name ?? column.column_name}`
      }))
  ];
}

function finalListingSummaryColumnKey(source: "final" | "base", columnName: string) {
  return `__${source}_${columnName}`;
}

function createClientRequestId(scope: string, requestId?: number) {
  const randomPart =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return requestId == null ? `${scope}-${randomPart}` : `${scope}-${requestId}-${randomPart}`;
}

function normalizeCrmInput(value: string) {
  return value.trim();
}

function normalizePortalRefreshTime(value: string | null | undefined) {
  const match = (value?.trim() || "00:00").match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  return match ? `${match[1]}:${match[2]}` : "00:00";
}
