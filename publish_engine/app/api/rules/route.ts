import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-monitoring";
import { createRule, listRules } from "@/lib/repository";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const portalId = searchParams.get("portalId");
    return NextResponse.json({ rules: await listRules(portalId ? Number(portalId) : undefined) });
  } catch (error) {
    return apiErrorResponse("GET /api/rules", error, "Erro ao listar regras.");
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.name?.trim()) {
      return NextResponse.json({ error: "Nome e obrigatorio." }, { status: 400 });
    }

    return NextResponse.json({ rule: await createRule(body) }, { status: 201 });
  } catch (error) {
    return apiErrorResponse("POST /api/rules", error, "Erro ao criar regra.");
  }
}
