/** Minimal API Gateway HTTP API (payload v2) types: only what the handler reads. */
export interface HttpApiEvent {
  readonly routeKey: string;
  readonly rawPath?: string;
  readonly headers?: Record<string, string | undefined>;
  readonly queryStringParameters?: Record<string, string | undefined>;
  readonly pathParameters?: Record<string, string | undefined>;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
  readonly requestContext?: {
    readonly requestId?: string;
    readonly authorizer?: { readonly jwt?: { readonly claims?: Record<string, unknown> } };
  };
}

export interface HttpResult {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const BASE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  // Responses can carry tenant data: never cache them anywhere.
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

export function json(statusCode: number, body: unknown, requestId?: string): HttpResult {
  return {
    statusCode,
    headers: { ...BASE_HEADERS, ...(requestId ? { "x-request-id": requestId } : {}) },
    body: JSON.stringify(body),
  };
}

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}
