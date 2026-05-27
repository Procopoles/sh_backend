import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-monitoring";
import { previewPortalFinalRows } from "@/lib/repository";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  let body: any = {};
  const routeRequestId = createRouteRequestId("final-rows");
  const startedAt = Date.now();
  try {
    body = await request.json().catch(() => ({}));
    console.info("[publish-engine] api.final-rows.start", {
      routeRequestId,
      clientRequestId: body.client_request_id ?? null,
      portalId: body.portal_id ?? null,
      limit: body.limit ?? null,
      crmCode: hasCrmCodeFilter(body.crm_code) ? "[filtered]" : null,
      refresh: Boolean(body.refresh)
    });
    const result = await previewPortalFinalRows(body);
    console.info("[publish-engine] api.final-rows.ok", {
      routeRequestId,
      clientRequestId: body.client_request_id ?? null,
      portalId: body.portal_id ?? null,
      columnCount: result.columns.length,
      rowCount: result.rows.length,
      elapsedMs: Date.now() - startedAt
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[publish-engine] api.final-rows.error", {
      routeRequestId,
      clientRequestId: body.client_request_id ?? null,
      portalId: body.portal_id ?? null,
      elapsedMs: Date.now() - startedAt,
      error
    });
    return apiErrorResponse("POST /api/publication/final/preview/rows", error, "Erro ao pre visualizar a listagem final.");
  }
}

function createRouteRequestId(scope: string) {
  const randomPart =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${scope}-${randomPart}`;
}

function hasCrmCodeFilter(value: unknown) {
  return value != null && String(value).trim().length > 0;
}
