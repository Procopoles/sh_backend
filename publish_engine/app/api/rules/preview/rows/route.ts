import { NextResponse } from "next/server";
import { previewRuleRows } from "@/lib/repository";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    return NextResponse.json(await previewRuleRows(body));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro ao pre visualizar linhas." },
      { status: 500 }
    );
  }
}
