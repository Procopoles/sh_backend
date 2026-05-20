import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-monitoring";
import { previewRuleRows } from "@/lib/repository";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    return NextResponse.json(await previewRuleRows(body));
  } catch (error) {
    return apiErrorResponse("POST /api/rules/preview/rows", error, "Erro ao pre visualizar linhas.");
  }
}
