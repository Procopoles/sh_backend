import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-monitoring";
import { deleteAutomation, updateAutomationActive } from "@/lib/repository";

export const runtime = "nodejs";

type Context = { params: Promise<{ key: string }> };

export async function PATCH(request: Request, context: Context) {
  try {
    const { key } = await context.params;
    const body = await request.json();
    if (typeof body.active !== "boolean") {
      return NextResponse.json({ error: "active booleano e obrigatorio." }, { status: 400 });
    }

    const automation = await updateAutomationActive(decodeURIComponent(key), body.active);
    if (!automation) return NextResponse.json({ error: "Automacao nao encontrada." }, { status: 404 });
    return NextResponse.json({ automation });
  } catch (error) {
    return apiErrorResponse("PATCH /api/automations/[key]", error, "Erro ao atualizar automacao.");
  }
}

export async function DELETE(_: Request, context: Context) {
  try {
    const { key } = await context.params;
    const automation = await deleteAutomation(decodeURIComponent(key));
    if (!automation) return NextResponse.json({ error: "Automacao nao encontrada." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse("DELETE /api/automations/[key]", error, "Erro ao excluir automacao.");
  }
}
