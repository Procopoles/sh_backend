export type PortalAdType = {
  id?: number;
  portal_id?: number;
  name: string;
  quantity: number;
  created_at?: string;
  updated_at?: string;
};

export type Portal = {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  logo_url: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  rules_count?: number;
  total_quota?: number;
  ad_types?: PortalAdType[];
};

export type RuleCondition = {
  column: string;
  jsonPath?: string[] | null;
  jsonValueKind?: ColumnMetadata["filter_kind"] | null;
  operator: RuleOperator;
  value?: string | number | boolean | null;
  secondaryValue?: string | number | null;
  caseInsensitive?: boolean;
};

export type RuleFilterGroup = {
  type: "group";
  name?: string | null;
  combinator: "and" | "or";
  conditions: RuleFilterItem[];
};

export type RuleFilterItem = RuleCondition | RuleFilterGroup;

export type RuleFilters = {
  combinator: "and" | "or";
  conditions: RuleFilterItem[];
};

export type PublicationPrioritySortItem = {
  type?: "sort";
  column: string;
  jsonPath?: string[] | null;
  jsonValueKind?: ColumnMetadata["filter_kind"] | null;
  direction: "asc" | "desc";
  nulls: "first" | "last";
};

export type PublicationPriorityGroup = RuleFilterGroup;

export type PublicationPriorityItem = PublicationPrioritySortItem | PublicationPriorityGroup;

export type PublicationPriority = PublicationPriorityItem[];

export type PublicationRule = {
  id: number;
  portal_id: number | null;
  portal_name?: string;
  name: string;
  slug: string;
  description: string | null;
  source_table: string;
  view_name: string | null;
  active: boolean;
  include_locked: boolean;
  use_ad_limit: boolean;
  ad_limit_type: string | null;
  filters: RuleFilters;
  publication_priority: PublicationPriority;
  last_sql: string | null;
  last_count: number | null;
  last_limited_count: number | null;
  created_at: string;
  updated_at: string;
};

export type ColumnMetadata = {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: "YES" | "NO";
  filter_kind: "text" | "number" | "boolean" | "datetime" | "json" | "other";
  json_path?: string[] | null;
  display_name?: string | null;
};

export type SourceViewMetadata = {
  view_name: string;
  view_type: "view" | "materialized";
};

export type RuleOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "starts_with"
  | "in"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "is_true"
  | "is_false"
  | "is_null"
  | "is_not_null";
