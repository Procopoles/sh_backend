import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-monitoring";
import { checkHealth } from "@/lib/repository";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(await checkHealth());
  } catch (error) {
    return apiErrorResponse("GET /api/health", error, "Erro de conexao.", 500, { ok: false });
  }
}
