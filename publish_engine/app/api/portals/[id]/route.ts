import { NextResponse } from "next/server";
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

    const portal = await updatePortal(Number(id), body);
    if (!portal) return NextResponse.json({ error: "Portal não encontrado." }, { status: 404 });
    return NextResponse.json({ portal });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro ao atualizar portal." },
      { status: 500 }
    );
  }
}

export async function DELETE(_: Request, context: Context) {
  try {
    const { id } = await context.params;
    await deletePortal(Number(id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro ao excluir portal." },
      { status: 500 }
    );
  }
}
