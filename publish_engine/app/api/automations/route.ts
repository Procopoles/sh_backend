import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-monitoring";
import { listAutomations } from "@/lib/repository";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ automations: await listAutomations() });
  } catch (error) {
    return apiErrorResponse("GET /api/automations", error, "Erro ao listar automacoes.");
  }
}
