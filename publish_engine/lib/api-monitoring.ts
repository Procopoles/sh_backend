import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { getDataApiDiagnostics } from "./data-api";

export function apiErrorResponse(
  route: string,
  error: unknown,
  fallbackMessage: string,
  status = 500,
  extraBody: Record<string, unknown> = {}
) {
  const requestId = randomUUID();
  const message = error instanceof Error ? error.message : fallbackMessage;

  console.error("[publish-engine] api.route.error", {
    requestId,
    route,
    status,
    dataApi: getDataApiDiagnostics(),
    error: serializeError(error)
  });

  return NextResponse.json({ ...extraBody, error: message, requestId }, { status });
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return { message: String(error) };
}
