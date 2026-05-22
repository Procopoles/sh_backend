import { createHash, createHmac, randomUUID } from "crypto";

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  prefer?: string;
};

type ServiceKeyDiagnostics = {
  configured: boolean;
  length: number;
  jwtParts: number;
  jwtShapeValid: boolean;
  authMode: "missing" | "provided-jwt" | "generated-jwt";
  fingerprint: string | null;
};

type DataApiDiagnostics = {
  baseUrlConfigured: boolean;
  baseUrlOrigin: string | null;
  serviceKey: ServiceKeyDiagnostics;
};

export function isDataApiConfigured() {
  return Boolean(process.env.PUBLISH_CONTROL_DATA_API_URL && process.env.PUBLISH_CONTROL_SERVICE_KEY);
}

export function getDataApiDiagnostics(): DataApiDiagnostics {
  const baseUrl = process.env.PUBLISH_CONTROL_DATA_API_URL?.trim() ?? "";
  const serviceKey = process.env.PUBLISH_CONTROL_SERVICE_KEY?.trim() ?? "";

  return {
    baseUrlConfigured: Boolean(baseUrl),
    baseUrlOrigin: getUrlOrigin(baseUrl),
    serviceKey: describeServiceKey(serviceKey)
  };
}

function getConfig() {
  const baseUrl = process.env.PUBLISH_CONTROL_DATA_API_URL?.trim();
  const configuredServiceKey = process.env.PUBLISH_CONTROL_SERVICE_KEY?.trim();

  if (!baseUrl || !configuredServiceKey) {
    throw new Error("Gateway PostgREST nao configurado.");
  }

  const serviceKey = resolveServiceJwt(configuredServiceKey);

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    serviceKey
  };
}

export async function dataApiRequest<T>(path: string, options: RequestOptions = {}) {
  const { baseUrl, serviceKey } = getConfig();
  const method = options.method ?? "GET";
  const requestId = randomUUID();
  const startedAt = Date.now();
  let response: Response;

  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        "Content-Type": "application/json",
        ...(options.prefer ? { Prefer: options.prefer } : {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
  } catch (error) {
    logDataApi("error", "data-api.request.failed", {
      requestId,
      method,
      path,
      requestBody: summarizeJson(options.body),
      elapsedMs: Date.now() - startedAt,
      dataApi: getDataApiDiagnostics(),
      error: serializeError(error)
    });
    throw new Error(`Falha ao conectar ao gateway PostgREST (${method} ${path}). Referencia: ${requestId}.`);
  }

  const text = await response.text();
  const data = parseResponseBody(text);
  const elapsedMs = Date.now() - startedAt;

  if (!response.ok) {
    const message = getGatewayErrorMessage(data, response.status);
    logDataApi("error", "data-api.response.error", {
      requestId,
      method,
      path,
      status: response.status,
      statusText: response.statusText,
      elapsedMs,
      requestBody: summarizeJson(options.body),
      postgrest: getPostgrestError(data),
      responseBody: summarizeText(text),
      dataApi: getDataApiDiagnostics()
    });
    throw new Error(`Erro no gateway PostgREST (${method} ${path}, HTTP ${response.status}). Referencia: ${requestId}. ${message}`);
  }

  logDataApi("info", "data-api.response.ok", {
    requestId,
    method,
    path,
    status: response.status,
    elapsedMs
  });

  return data as T;
}

export async function dataApiRpc<T>(name: string, body: Record<string, unknown> = {}) {
  return dataApiRequest<T>(`/rpc/${name}`, {
    method: "POST",
    body,
    prefer: "return=representation"
  });
}

function describeServiceKey(serviceKey: string): ServiceKeyDiagnostics {
  const parts = serviceKey ? serviceKey.split(".") : [];
  const jwtShapeValid = parts.length === 3 && parts.every(Boolean);

  return {
    configured: Boolean(serviceKey),
    length: serviceKey.length,
    jwtParts: parts.length,
    jwtShapeValid,
    authMode: !serviceKey ? "missing" : jwtShapeValid ? "provided-jwt" : "generated-jwt",
    fingerprint: serviceKey ? createHash("sha256").update(serviceKey).digest("hex").slice(0, 12) : null
  };
}

function resolveServiceJwt(serviceKeyOrSecret: string) {
  const diagnostics = describeServiceKey(serviceKeyOrSecret);
  if (diagnostics.jwtShapeValid) return serviceKeyOrSecret;
  return signServiceRoleJwt(serviceKeyOrSecret);
}

function signServiceRoleJwt(secret: string) {
  const header = encodeJwtPart({ alg: "HS256", typ: "JWT" });
  const payload = encodeJwtPart({ role: "service_role" });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function encodeJwtPart(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function getUrlOrigin(url: string) {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return "invalid-url";
  }
}

function parseResponseBody(text: string) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function getGatewayErrorMessage(data: unknown, status: number) {
  if (isRecord(data)) {
    return String(data.message ?? data.error ?? `Erro HTTP ${status} no gateway.`);
  }
  return `Erro HTTP ${status} no gateway.`;
}

function getPostgrestError(data: unknown) {
  if (!isRecord(data)) return null;
  return {
    code: data.code ?? null,
    message: data.message ?? null,
    details: data.details ?? null,
    hint: data.hint ?? null
  };
}

function summarizeText(text: string) {
  if (!text) return "";
  return text.length > 2000 ? `${text.slice(0, 2000)}...<truncated>` : text;
}

function summarizeJson(value: unknown) {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  if (!text) return undefined;
  return text.length > 2000 ? `${text.slice(0, 2000)}...<truncated>` : text;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function logDataApi(level: "info" | "error", event: string, details: Record<string, unknown>) {
  console[level](`[publish-engine] ${event}`, details);
}
