import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-monitoring";
import { previewRule } from "@/lib/repository";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    return NextResponse.json(await previewRule(body));
  } catch (error) {
    return apiErrorResponse("POST /api/rules/preview", error, "Erro ao calcular previa.");
  }
}
