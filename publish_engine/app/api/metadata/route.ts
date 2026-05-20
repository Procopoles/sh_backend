import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-monitoring";
import { getMetadata } from "@/lib/repository";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(await getMetadata());
  } catch (error) {
    return apiErrorResponse("GET /api/metadata", error, "Erro ao carregar metadados.");
  }
}
