import type { ColumnMetadata, Portal, PortalAdType, PublicationPriority, RuleFilters, RuleSummaryConfigItem, SourceViewMetadata } from "@/lib/types";

export type MetadataResponse = {
  columns: ColumnMetadata[];
  counts: { base_imoveis: number; publish_locks: number };
  source_views: SourceViewMetadata[];
};

export type PortalForm = Pick<Portal, "name" | "slug" | "description" | "logo_url" | "active"> & {
  id?: number;
  ad_types: Array<Pick<PortalAdType, "name" | "quantity">>;
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

export type ActiveView = "portals" | "rules" | "status";
export type PanelMode = "view" | "edit";

export const EMPTY_PORTAL: PortalForm = { name: "", slug: "", description: "", logo_url: null, active: true, ad_types: [] };
export const EMPTY_FILTERS: RuleFilters = { combinator: "and", conditions: [] };
export const EMPTY_PUBLICATION_PRIORITY: PublicationPriority = [];
