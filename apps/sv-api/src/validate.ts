import { badRequest } from "./errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID.test(value.toLowerCase())) throw badRequest(`${name} must be a UUID.`);
  return value.toLowerCase();
}

export function optionalUuid(value: unknown, name: string): string | null {
  return value === undefined || value === null || value === "" ? null : uuid(value, name);
}

export function date(value: unknown, name: string): string {
  if (typeof value !== "string" || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw badRequest(`${name} must be a date (YYYY-MM-DD).`);
  }
  return value;
}

export function optionalDate(value: unknown, name: string): string | null {
  return value === undefined || value === null || value === "" ? null : date(value, name);
}

export function timestamp(value: unknown, name: string): string {
  // ISO 8601 with an explicit offset: never interpret a client wall-clock time.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw badRequest(`${name} must be an ISO 8601 timestamp with a time zone.`);
  }
  return value;
}

export function text(value: unknown, name: string, max: number, { required = false } = {}): string | null {
  if (value === undefined || value === null) {
    if (required) throw badRequest(`${name} is required.`);
    return null;
  }
  if (typeof value !== "string") throw badRequest(`${name} must be text.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw badRequest(`${name} is required.`);
  if (trimmed.length > max) throw badRequest(`${name} is too long.`);
  return trimmed || null;
}

export function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw badRequest(`${name} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

/** Max accepted JSON body (a 1 MiB PNG is ~1.4 MB base64) */
export const MAX_BODY_BYTES = 1_500_000;

export function parseBody(body: string | null | undefined, isBase64Encoded = false, maxBytes = MAX_BODY_BYTES): Record<string, unknown> {
  if (!body) return {};
  const raw = isBase64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
  if (Buffer.byteLength(raw) > maxBytes) throw badRequest("Request body is too large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest("Request body must be JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw badRequest("Request body must be a JSON object.");
  return parsed as Record<string, unknown>;
}

export function idempotencyKey(headers: Record<string, string | undefined> | undefined): string {
  const value = headers?.["idempotency-key"] ?? headers?.["Idempotency-Key"];
  if (!value) throw badRequest("An Idempotency-Key header (UUID) is required for this action.");
  return uuid(value, "Idempotency-Key");
}
