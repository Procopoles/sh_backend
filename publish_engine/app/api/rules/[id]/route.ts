import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-monitoring";
import { deleteRule, updateRule } from "@/lib/repository";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    if (!body.name?.trim()) {
      return NextResponse.json({ error: "Nome e obrigatorio." }, { status: 400 });
    }

    const rule = await updateRule(Number(id), body);
    if (!rule) return NextResponse.json({ error: "Regra nao encontrada." }, { status: 404 });
    return NextResponse.json({ rule });
  } catch (error) {
    return apiErrorResponse("PUT /api/rules/[id]", error, "Erro ao atualizar regra.");
  }
}

export async function DELETE(_: Request, context: Context) {
  try {
    const { id } = await context.params;
    await deleteRule(Number(id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse("DELETE /api/rules/[id]", error, "Erro ao excluir regra.");
  }
}
