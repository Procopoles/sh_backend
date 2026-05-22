import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-monitoring";
import { runRuleHealthchecks } from "@/lib/repository";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const ruleId = body.rule_id == null || body.rule_id === "" ? null : Number(body.rule_id);
    if (ruleId != null && (!Number.isInteger(ruleId) || ruleId <= 0)) {
      return NextResponse.json({ error: "rule_id invalido." }, { status: 400 });
    }

    return NextResponse.json({ statuses: await runRuleHealthchecks(ruleId) });
  } catch (error) {
    return apiErrorResponse("POST /api/rules/healthcheck", error, "Erro ao executar healthcheck.");
  }
}
