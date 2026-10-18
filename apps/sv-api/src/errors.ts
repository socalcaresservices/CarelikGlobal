/**
 * Error model. Messages returned to the browser are fixed strings or the
 * user-facing text of Ogevia's own SQLSTATEs (written for display, with no
 * identifiers). Driver/internal errors are never echoed.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Logged, never returned: the AWS error NAME behind a storage failure (for example AccessDenied). No message text, so no input values. */
    readonly storageError?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** A failed object-store write. The caller sees one safe message; the log gets the AWS error name so the cause can be found. */
export function storageUnavailable(message: string, error: unknown): ApiError {
  const name = (error as { name?: unknown } | null)?.name;
  return new ApiError(503, "storage_unavailable", message, typeof name === "string" && /^[A-Za-z0-9_.]{1,64}$/.test(name) ? name : "Unknown");
}

export const badRequest = (message: string) => new ApiError(400, "bad_request", message);

/** Ogevia SQLSTATE -> HTTP. Documented in 0006 and PHASE_4_API_CONTRACT.md. */
const OGEVIA_SQLSTATES: Record<string, { status: number; code: string }> = {
  OGA01: { status: 401, code: "unauthenticated" },
  OGA03: { status: 403, code: "forbidden" },
  OGN04: { status: 404, code: "not_found" },
  OGC09: { status: 409, code: "conflict" },
  OGV22: { status: 422, code: "validation_failed" },
  // 0042: the commit-time gate refused because a required check failed; the message lists exactly which.
  OGR30: { status: 422, code: "not_ready" },
  OGI09: { status: 409, code: "idempotency_key_reused" },
};

/** PostgreSQL SQLSTATEs that represent bad input rather than server faults. */
const PG_CLIENT_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  "22P02": { status: 400, code: "bad_request", message: "A value in the request has the wrong format." },
  "22007": { status: 400, code: "bad_request", message: "A date or time in the request is invalid." },
  "22008": { status: 400, code: "bad_request", message: "A date or time in the request is out of range." },
  "23505": { status: 409, code: "conflict", message: "This change conflicts with an existing record." },
  "23P01": { status: 409, code: "conflict", message: "This change conflicts with an existing record." },
  "23514": { status: 422, code: "validation_failed", message: "The request does not satisfy a business rule." },
  "40001": { status: 409, code: "retry", message: "The record changed while saving. Please try again." },
  "40P01": { status: 409, code: "retry", message: "The record changed while saving. Please try again." },
};

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") {
    const ogevia = OGEVIA_SQLSTATES[code];
    if (ogevia) {
      const message = (error as Error).message;
      return new ApiError(ogevia.status, ogevia.code, typeof message === "string" && message ? message : ogevia.code);
    }
    const client = PG_CLIENT_ERRORS[code];
    if (client) return new ApiError(client.status, client.code, client.message);
  }
  return new ApiError(500, "internal_error", "Something went wrong. Please try again.");
}
