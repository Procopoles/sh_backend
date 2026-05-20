import { NextResponse } from "next/server";
import { createPortal, listPortals } from "@/lib/repository";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ portals: await listPortals() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro ao listar portais." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.name?.trim()) {
      return NextResponse.json({ error: "Nome é obrigatório." }, { status: 400 });
    }

    return NextResponse.json({ portal: await createPortal(body) }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro ao criar portal." },
      { status: 500 }
    );
  }
}
