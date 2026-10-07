// Minimal client for the Ogevia AWS API (API Gateway + Cognito JWT authorizer).
// The access token comes from the Cognito session in memory; it is never
// logged or stored. Errors carry the server's safe message and code.
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export interface AwsApiClient {
  get<T>(path: string, query?: Record<string, string | null | undefined>): Promise<T>;
  post<T>(path: string, body: unknown, options?: { idempotencyKey?: string }): Promise<T>;
}

export function createAwsApiClient(options: {
  baseUrl: string;
  getAccessToken?: () => Promise<string | null>;
  requireAuth?: boolean;
  fetch?: typeof fetch;
}): AwsApiClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  async function request<T>(method: "GET" | "POST", path: string, init: { query?: Record<string, string | null | undefined>; body?: unknown; idempotencyKey?: string }): Promise<T> {
    const token = options.getAccessToken ? await options.getAccessToken() : null;
    if ((options.requireAuth ?? true) && !token) throw new ApiRequestError(401, "unauthenticated", "Your session has ended. Please sign in again.");
    const url = new URL(`${base}${path}`, window.location.origin);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v) url.searchParams.set(k, v);
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
    let response: Response;
    try {
      response = await doFetch(url.toString(), {
        method,
        headers,
        body: init.body === undefined ? null : JSON.stringify(init.body),
        credentials: "omit",
        cache: "no-store",
      });
    } catch {
      throw new ApiRequestError(0, "network_error", "Could not reach Ogevia. Check your connection and try again.");
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const err = (payload as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiRequestError(response.status, err?.code ?? "http_error", err?.message ?? "The request failed. Please try again.");
    }
    return payload as T;
  }

  return {
    get: (path, query) => request("GET", path, query ? { query } : {}),
    post: (path, body, opts) => request("POST", path, { body, ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}) }),
  };
}

/** Anonymous client for opaque-token care portal/offer routes only. */
export const createAwsPublicApiClient = (baseUrl: string, fetchImpl?: typeof fetch) =>
  createAwsApiClient({ baseUrl, requireAuth: false, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
