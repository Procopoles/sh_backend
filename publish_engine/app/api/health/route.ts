import { NextResponse } from "next/server";
import { checkHealth } from "@/lib/repository";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(await checkHealth());
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Erro de conexão." },
      { status: 500 }
    );
  }
}
