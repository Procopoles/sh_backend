import { NextResponse } from "next/server";
import { previewRule } from "@/lib/repository";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    return NextResponse.json(await previewRule(body));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro ao calcular prévia." },
      { status: 500 }
    );
  }
}
