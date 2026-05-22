import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-monitoring";
import { createPortal, listPortals } from "@/lib/repository";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ portals: await listPortals() });
  } catch (error) {
    return apiErrorResponse("GET /api/portals", error, "Erro ao listar portais.");
  }
}

export async function POST(request: Request) {
  try {
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

    return NextResponse.json({ portal: await createPortal(body) }, { status: 201 });
  } catch (error) {
    return apiErrorResponse("POST /api/portals", error, "Erro ao criar portal.");
  }
}
