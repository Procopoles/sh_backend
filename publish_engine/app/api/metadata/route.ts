import { NextResponse } from "next/server";
import { getMetadata } from "@/lib/repository";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(await getMetadata());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro ao carregar metadados." },
      { status: 500 }
    );
  }
}
