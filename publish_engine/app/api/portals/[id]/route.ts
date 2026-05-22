import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-monitoring";
import { deletePortal, updatePortal } from "@/lib/repository";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    if (!body.name?.trim()) {
      return NextResponse.json({ error: "Nome é obrigatório." }, { status: 400 });
    }

    if (!body.slug?.trim()) {
      return NextResponse.json({ error: "Slug e obrigatorio." }, { status: 400 });
    }
    if (!/^[a-z0-9_]+$/.test(body.slug.trim())) {
      return NextResponse.json({ error: "Slug deve usar apenas letras minusculas, numeros e underscore." }, { status: 400 });
    }

    const portal = await updatePortal(Number(id), body);
    if (!portal) return NextResponse.json({ error: "Portal não encontrado." }, { status: 404 });
    return NextResponse.json({ portal });
  } catch (error) {
    return apiErrorResponse("PUT /api/portals/[id]", error, "Erro ao atualizar portal.");
  }
}

export async function DELETE(_: Request, context: Context) {
  try {
    const { id } = await context.params;
    await deletePortal(Number(id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse("DELETE /api/portals/[id]", error, "Erro ao excluir portal.");
  }
}
