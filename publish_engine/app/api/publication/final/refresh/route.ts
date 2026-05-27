import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-monitoring";
import { refreshPortalFinalListing } from "@/lib/repository";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  let body: any = {};
  const routeRequestId = createRouteRequestId("final-refresh");
  const startedAt = Date.now();
  try {
    body = await request.json().catch(() => ({}));
    console.info("[publish-engine] api.final-refresh.start", {
      routeRequestId,
      clientRequestId: body.client_request_id ?? null,
      portalId: body.portal_id ?? null
    });
    const result = await refreshPortalFinalListing({ portalId: body.portal_id ?? null });
    console.info("[publish-engine] api.final-refresh.ok", {
      routeRequestId,
      clientRequestId: body.client_request_id ?? null,
      portalId: body.portal_id ?? null,
      refreshedCount: result.refreshed.length,
      elapsedMs: Date.now() - startedAt
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[publish-engine] api.final-refresh.error", {
      routeRequestId,
      clientRequestId: body.client_request_id ?? null,
      portalId: body.portal_id ?? null,
      elapsedMs: Date.now() - startedAt,
      error
    });
    return apiErrorResponse("POST /api/publication/final/refresh", error, "Erro ao atualizar listagem final.");
  }
}

function createRouteRequestId(scope: string) {
  const randomPart =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${scope}-${randomPart}`;
}
