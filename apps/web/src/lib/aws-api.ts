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

/**
 * Routes that exist only where a release switch is on (infra/aws/lib/service-verification-api-stack.ts, `feature:`; the list is checked against that file by a test).
 * Where a switch is off the route does not exist, API Gateway answers 404 WITHOUT the cross-origin headers, and the browser reports a failed request, not a 404.
 * For these paths only, a failed request is checked against a request that must work (`GET /v1/me`): if the API answers that, the route is not there, which is not a connection problem.
 */
export const SWITCHED_PATHS: readonly RegExp[] = [
  /^\/v1\/care-notifications\/read$/, /^\/v1\/documents\/[^/]+\/cancel$/, /^\/v1\/document-types\/[^/]+\/retire$/,
  /^\/v1\/offices(\/|$)/, /^\/v1\/client-offices$/, /^\/v1\/clients\/[^/]+\/office$/,
  /^\/v1\/people-facets$/, /^\/v1\/assignment-history$/, /^\/v1\/clients\/[^/]+\/(offices|service-county)$/, /^\/v1\/caregivers\/[^/]+\/(offices|service-counties|color)$/,
  /^\/v1\/(notification-center(\/mark)?|notification-preferences|cover-notification-(settings|history)|cover-office-audiences)$/, /^\/v1\/offices\/[^/]+\/cover-audience$/, /^\/v1\/shifts\/[^/]+\/notify-cover$/,
  /^\/v1\/(sms-settings|my-sms|sms-oncall|sms-history)$/,
  /^\/v1\/clients\/[^/]+\/service-location$/,
  /^\/v1\/caregivers\/[^/]+\/readiness-override$/, /^\/v1\/readiness-overrides(\/[^/]+\/revoke)?$/,
  /^\/v1\/office-branding$/, /^\/v1\/operations-readiness$/, /^\/v1\/offices\/[^/]+\/branding$/,
  /^\/v1\/staff\/duplicates$/, /^\/v1\/staff\/merge-preview$/, /^\/v1\/staff-merges(\/[^/]+\/undo)?$/, /^\/v1\/staff\/[^/]+\/merge$/, /^\/v1\/imports(\/[^/]+(\/rollback)?)?$/,
  /^\/v1\/caregivers\/[^/]+\/signin-override$/, /^\/v1\/signin-overrides$/,
  /^\/v1\/reports\/missing-visits$/, /^\/v1\/shifts\/[^/]+\/missing-visit$/, /^\/v1\/business-documents$/, /^\/v1\/checkin$/, /^\/v1\/clients\/[^/]+\/qr-card$/,
  // 0124 (homeLabels switch): home labels, punches, signing, exceptions, corrections and verification reports.
  /^\/v1\/verification-settings$/, /^\/v1\/verification-reports\/[^/]+$/, /^\/v1\/home-labels(\/.*)?$/, /^\/v1\/label-punch(\/preview)?$/, /^\/v1\/visit-punch$/, /^\/v1\/visit-exceptions(\/.*)?$/,
  /^\/v1\/clients\/[^/]+\/service-locations$/, /^\/v1\/services\/[^/]+\/location-rule$/, /^\/v1\/shifts\/[^/]+\/(location-override|expected-locations)$/,
  /^\/v1\/visits\/[^/]+\/(signature-session|sign|sign-later|punch-corrections|signature-followup\/(owner|delivery))$/, /^\/v1\/punch-corrections\/[^/]+\/decide$/,
];
export const isSwitchedPath = (path: string) => SWITCHED_PATHS.some((re) => re.test(path));

const defaultCode = (status: number) => (status === 401 ? "unauthenticated" : status === 403 ? "forbidden" : status === 429 ? "rate_limited" : status >= 500 ? "server_error" : "http_error");
const defaultMessage = (status: number) =>
  status === 401 ? "Your session has ended. Please sign in again."
  : status === 403 ? "You do not have permission to do this."
  : status === 429 ? "Too many requests. Wait a moment and try again."
  : status >= 500 ? "Ogevia had a problem completing that. Try again in a moment; if it keeps happening, tell the office."
  : "The request failed. Please try again.";

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

  /** True when the API answers an always-present route (any HTTP status counts: it was reached). */
  async function apiAnswers(token: string | null): Promise<boolean> {
    try {
      await doFetch(new URL(`${base}/v1/me`, window.location.origin).toString(), { method: "GET", headers: token ? { accept: "application/json", authorization: `Bearer ${token}` } : { accept: "application/json" }, credentials: "omit", cache: "no-store" });
      return true;
    } catch {
      return false;
    }
  }

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
      if (isSwitchedPath(path) && (await apiAnswers(token))) throw new ApiRequestError(404, "not_available", "This is not available in this environment yet.");
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
      // The server's own safe message (business rules, permissions) always wins. API Gateway's own answers (expired token, throttling, a crashed function) carry no such message.
      throw new ApiRequestError(response.status, err?.code ?? defaultCode(response.status), err?.message ?? defaultMessage(response.status));
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
