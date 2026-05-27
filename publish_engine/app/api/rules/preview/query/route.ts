import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-monitoring";
import { previewRuleQuery } from "@/lib/repository";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    return NextResponse.json(await previewRuleQuery(body));
  } catch (error) {
    return apiErrorResponse("POST /api/rules/preview/query", error, "Erro ao gerar preview da query.");
  }
}
