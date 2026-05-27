import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-monitoring";
import { refreshScheduledPortalFinalListings } from "@/lib/repository";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    const shouldRequireSecret = process.env.NODE_ENV === "production" || Boolean(secret);
    if (shouldRequireSecret && !secret) {
      return NextResponse.json({ error: "CRON_SECRET nao configurado." }, { status: 500 });
    }
    if (shouldRequireSecret && request.headers.get("authorization") !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Nao autorizado." }, { status: 401 });
    }

    return NextResponse.json(await refreshScheduledPortalFinalListings());
  } catch (error) {
    return apiErrorResponse("GET /api/publication/final/scheduled-refresh", error, "Erro ao executar atualização agendada.");
  }
}
