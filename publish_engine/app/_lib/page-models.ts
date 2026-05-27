import type {
  ColumnMetadata,
  Portal,
  PortalAdType,
  PublicationPriority,
  PublicationRule,
  RuleFilters,
  RuleSummaryConfigItem,
  SourceViewMetadata
} from "@/lib/types";

export type MetadataResponse = {
  columns: ColumnMetadata[];
  counts: { base_imoveis: number; publish_locks: number };
  source_views: SourceViewMetadata[];
};

export type PortalForm = Pick<Portal, "name" | "slug" | "description" | "logo_url" | "active" | "final_listing_refresh_time"> & {
  id?: number;
  ad_types: Array<Pick<PortalAdType, "name" | "quantity" | "tier">>;
};

export type RuleForm = {
  id?: number;
  portal_id: number | null;
  name: string;
  description: string | null;
  source_table: string;
  view_name?: string | null;
  active: boolean;
  include_locked: boolean;
  use_ad_limit: boolean;
  ad_limit_type: string | null;
  filters: RuleFilters;
  publication_priority: PublicationPriority;
  summary_config?: RuleSummaryConfigItem[] | null;
};

export type ActiveView = "portals" | "rules" | "automations" | "status";
export type PanelMode = "view" | "edit";
export type PreviewSortDirection = "asc" | "desc";

export type RuleRowsPreview = {
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, unknown>>;
};

export type RulePreview = {
  count: number;
  limited_count?: number | null;
};

export type RuleTreeRow = {
  rule: PublicationRule;
  depth: number;
  parentRule?: PublicationRule;
};

export type StatusPortalGroup = {
  portal: Portal | null;
  portalId: number;
  rules: PublicationRule[];
};

export const EMPTY_PORTAL: PortalForm = { name: "", slug: "", description: "", logo_url: null, active: true, final_listing_refresh_time: "00:00", ad_types: [] };
export const EMPTY_FILTERS: RuleFilters = { combinator: "and", conditions: [] };
export const EMPTY_PUBLICATION_PRIORITY: PublicationPriority = [];
