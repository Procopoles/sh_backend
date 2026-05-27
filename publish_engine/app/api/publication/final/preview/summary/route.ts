import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-monitoring";
import { previewPortalFinalSummary } from "@/lib/repository";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  let body: any = {};
  const routeRequestId = createRouteRequestId("final-summary");
  const startedAt = Date.now();
  try {
    body = await request.json().catch(() => ({}));
    console.info("[publish-engine] api.final-summary.start", {
      routeRequestId,
      clientRequestId: body.client_request_id ?? null,
      portalId: body.portal_id ?? null,
      refresh: Boolean(body.refresh),
      itemCount: Array.isArray(body.items) ? body.items.length : 0
    });
    const result = await previewPortalFinalSummary(body);
    console.info("[publish-engine] api.final-summary.ok", {
      routeRequestId,
      clientRequestId: body.client_request_id ?? null,
      portalId: body.portal_id ?? null,
      total: result.total,
      resultItems: result.items.length,
      elapsedMs: Date.now() - startedAt
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[publish-engine] api.final-summary.error", {
      routeRequestId,
      clientRequestId: body.client_request_id ?? null,
      portalId: body.portal_id ?? null,
      elapsedMs: Date.now() - startedAt,
      error
    });
    return apiErrorResponse("POST /api/publication/final/preview/summary", error, "Erro ao gerar resumo da listagem final.");
  }
}

function createRouteRequestId(scope: string) {
  const randomPart =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${scope}-${randomPart}`;
}
