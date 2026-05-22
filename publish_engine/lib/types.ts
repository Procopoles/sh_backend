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
  portal_slug?: string;
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
  summary_config: RuleSummaryConfigItem[] | null;
  last_sql: string | null;
  last_count: number | null;
  last_limited_count: number | null;
  health_expected_count: number | null;
  health_published_count: number | null;
  health_pending_count: number | null;
  health_unexpected_count: number | null;
  health_checked_at: string | null;
  health_error: string | null;
  created_at: string;
  updated_at: string;
};

export type RuleHealthcheckStatus = {
  rule_id: number;
  portal_id: number | null;
  portal_slug: string | null;
  expected_count: number | null;
  published_count: number | null;
  pending_count: number | null;
  unexpected_count: number | null;
  checked_at: string | null;
  error: string | null;
};

export type RuleHealthcheckReportRule = {
  rule: {
    id: number;
    name: string;
    slug: string;
    view_name: string | null;
    active: boolean;
  };
  portal: {
    id: number;
    name: string;
    slug: string;
  };
  ad_type: {
    name: string;
    slug: string;
    is_total: boolean;
  };
  status: {
    expected_count: number | null;
    published_count: number | null;
    pending_count: number | null;
    unexpected_count: number | null;
    checked_at: string | null;
    error: string | null;
  };
  codes: {
    pending: string[];
    unexpected: string[];
  };
  queries: {
    pending_codes: string | null;
    unexpected_codes: string | null;
  };
  error: string | null;
};

export type RuleHealthcheckReport = {
  generated_at: string;
  cached: boolean;
  cache: {
    ttl_ms: number;
    rule_hits: number;
    rule_misses: number;
  };
  rules: RuleHealthcheckReportRule[];
};

export type RuleSummaryCalculation = "range" | "count" | "group";

export type RuleSummaryConfigItem = {
  column: string;
  jsonPath?: string[] | null;
  jsonValueKind?: ColumnMetadata["filter_kind"] | null;
  calculation: RuleSummaryCalculation;
  groupCount?: number | null;
};

export type RuleSummaryItemResult =
  | {
      column: string;
      jsonPath?: string[] | null;
      label: string;
      calculation: "range";
      data_type: string;
      filter_kind: ColumnMetadata["filter_kind"];
      filled_count: number;
      total_count: number;
      min: string | null;
      max: string | null;
    }
  | {
      column: string;
      jsonPath?: string[] | null;
      label: string;
      calculation: "count";
      data_type: string;
      filter_kind: ColumnMetadata["filter_kind"];
      filled_count: number;
      empty_count: number;
      distinct_count: number;
      total_count: number;
      value_count_limit: number;
      values: Array<{
        label: string;
        count: number;
      }>;
    }
  | {
      column: string;
      jsonPath?: string[] | null;
      label: string;
      calculation: "group";
      data_type: string;
      filter_kind: ColumnMetadata["filter_kind"];
      group_count: number;
      total_count: number;
      groups: Array<{
        label: string;
        count: number;
        min?: string | null;
        max?: string | null;
      }>;
    };

export type RuleSummaryResponse = {
  total: number;
  items: RuleSummaryItemResult[];
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
