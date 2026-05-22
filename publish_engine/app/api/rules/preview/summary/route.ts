import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-monitoring";
import { previewRuleSummary } from "@/lib/repository";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    return NextResponse.json(await previewRuleSummary(body));
  } catch (error) {
    return apiErrorResponse("POST /api/rules/preview/summary", error, "Erro ao gerar resumo.");
  }
}
