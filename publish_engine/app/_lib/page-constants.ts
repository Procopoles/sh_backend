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
