import type { ColumnMetadata } from "@/lib/types";

export const PREVIEW_RULE_ORDER_COLUMN = "__rule_order__";

export const HEALTHCHECK_INTERVAL_MINUTES = Math.max(
  1,
  Number(process.env.NEXT_PUBLIC_RULE_HEALTHCHECK_INTERVAL_MINUTES ?? "5") || 5
);

export const HEALTHCHECK_INTERVAL_MS = HEALTHCHECK_INTERVAL_MINUTES * 60 * 1000;

export const PORTAL_SLUG_HELP =
  "Identificador interno do portal usado pelo sistema. Deve corresponder exatamente a chave em publicacao_portais na base_imoveis, como grupo_zap, imovel_web ou chaves_na_mao. Use minusculas, numeros e _ sem espacos.";

export const AD_TIER_HELP = "Nivel do anuncio.";

export const AD_TYPE_NAME_HELP = "Deve ser exatamente o nome usado no CRM.";

export const FINAL_LISTING_COLUMNS: ColumnMetadata[] = [
  {
    column_name: "codigo_crm",
    data_type: "text",
    udt_name: "text",
    is_nullable: "YES",
    filter_kind: "text",
    json_path: null,
    display_name: "Codigo CRM"
  },
  {
    column_name: "status",
    data_type: "text",
    udt_name: "text",
    is_nullable: "YES",
    filter_kind: "text",
    json_path: null,
    display_name: "Status"
  },
  {
    column_name: "ad_type_name",
    data_type: "text",
    udt_name: "text",
    is_nullable: "YES",
    filter_kind: "text",
    json_path: null,
    display_name: "Tipo de anuncio"
  },
  {
    column_name: "ad_type_slug",
    data_type: "text",
    udt_name: "text",
    is_nullable: "YES",
    filter_kind: "text",
    json_path: null,
    display_name: "Slug do tipo"
  },
  {
    column_name: "tier",
    data_type: "integer",
    udt_name: "int4",
    is_nullable: "YES",
    filter_kind: "number",
    json_path: null,
    display_name: "Tier"
  },
  {
    column_name: "publication_rank",
    data_type: "integer",
    udt_name: "int4",
    is_nullable: "YES",
    filter_kind: "number",
    json_path: null,
    display_name: "Ordem"
  },
  {
    column_name: "current_publication",
    data_type: "jsonb",
    udt_name: "jsonb",
    is_nullable: "YES",
    filter_kind: "json",
    json_path: null,
    display_name: "Publicacao atual"
  }
];

export const FINAL_LISTING_DEFAULT_SUMMARY_COLUMNS = ["status", "ad_type_name", "tier"];
