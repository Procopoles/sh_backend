type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  prefer?: string;
};

export function isDataApiConfigured() {
  return Boolean(process.env.PUBLISH_CONTROL_DATA_API_URL && process.env.PUBLISH_CONTROL_SERVICE_KEY);
}

function getConfig() {
  const baseUrl = process.env.PUBLISH_CONTROL_DATA_API_URL;
  const serviceKey = process.env.PUBLISH_CONTROL_SERVICE_KEY;

  if (!baseUrl || !serviceKey) {
    throw new Error("Gateway PostgREST nao configurado.");
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    serviceKey
  };
}

export async function dataApiRequest<T>(path: string, options: RequestOptions = {}) {
  const { baseUrl, serviceKey } = getConfig();
  const method = options.method ?? "GET";
  const response = await fetch(`${baseUrl}${path}`, {
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

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = data?.message ?? data?.error ?? `Erro HTTP ${response.status} no gateway.`;
    throw new Error(message);
  }

  return data as T;
}

export async function dataApiRpc<T>(name: string, body: Record<string, unknown> = {}) {
  return dataApiRequest<T>(`/rpc/${name}`, {
    method: "POST",
    body,
    prefer: "return=representation"
  });
}
