import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-monitoring";
import { getRuleHealthcheckReport } from "@/lib/repository";

export const runtime = "nodejs";

function normalizeRuleId(value: string | number | null | undefined) {
  if (value == null || value === "") return null;
  const ruleId = Number(value);
  if (!Number.isInteger(ruleId) || ruleId <= 0) {
    throw new Error("rule_id invalido.");
  }
  return ruleId;
}

function normalizeRefresh(value: unknown) {
  return value === true || value === "true" || value === "1" || value === 1;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const ruleId = normalizeRuleId(url.searchParams.get("rule_id"));
    const refresh = url.searchParams.has("refresh") ? normalizeRefresh(url.searchParams.get("refresh")) : true;
    return NextResponse.json(await getRuleHealthcheckReport({ ruleId, refresh }));
  } catch (error) {
    const status = error instanceof Error && error.message === "rule_id invalido." ? 400 : 500;
    return apiErrorResponse("GET /api/publication/final/report", error, "Erro ao montar relatorio de publicacao final.", status);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const ruleId = normalizeRuleId(body.rule_id);
    const refresh = Object.hasOwn(body, "refresh") ? normalizeRefresh(body.refresh) : true;
    return NextResponse.json(await getRuleHealthcheckReport({ ruleId, refresh }));
  } catch (error) {
    const status = error instanceof Error && error.message === "rule_id invalido." ? 400 : 500;
    return apiErrorResponse("POST /api/publication/final/report", error, "Erro ao montar relatorio de publicacao final.", status);
  }
}
