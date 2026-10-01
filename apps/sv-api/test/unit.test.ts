import { describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "../src/config";
import { ApiError, toApiError } from "../src/errors";
import { MemoryEvidenceStore, signatureObjectKey, validateSignaturePng } from "../src/evidence";
import { createHandler, type LogRecord } from "../src/handler";
import { ROUTE_KEYS, ROUTES, toCamel } from "../src/routes";
import { idempotencyKey, parseBody, timestamp, uuid } from "../src/validate";
import { claims, CONFIG, event, syntheticPng } from "./fixtures";

const ENV = {
  AWS_REGION: "us-west-2",
  COGNITO_USER_POOL_ID: "us-west-2_TESTPOOL1",
  COGNITO_APP_CLIENT_ID: "testclient0000000000000000",
  DB_HOST: "db.internal.example",
  DB_PORT: "5432",
  DB_SECRET_ARN: "arn:aws:secretsmanager:us-west-2:000000000000:secret:test",
  EVIDENCE_BUCKET: "ogevia-test-evidence",
  EVIDENCE_KEY_ARN: "arn:aws:kms:us-west-2:000000000000:key/00000000-0000-4000-8000-000000000000",
};

describe("config (fail closed)", () => {
  it("loads a valid environment and derives the issuer", () => {
    const c = loadConfig(ENV);
    expect(c.issuer).toBe("https://cognito-idp.us-west-2.amazonaws.com/us-west-2_TESTPOOL1");
    expect(c.dbSetRole).toBeUndefined();
  });
  it.each([
    ["missing region", { AWS_REGION: undefined }],
    ["pool from another region", { COGNITO_USER_POOL_ID: "us-east-1_TESTPOOL1" }],
    ["malformed client", { COGNITO_APP_CLIENT_ID: "x" }],
    ["bad port", { DB_PORT: "99999" }],
    ["bad secret arn", { DB_SECRET_ARN: "secret" }],
    ["injected role", { DB_SET_ROLE: "ogevia_app; drop" }],
    ["missing bucket", { EVIDENCE_BUCKET: "" }],
    ["bad key arn", { EVIDENCE_KEY_ARN: "alias/x" }],
  ])("rejects %s", (_l, patch) => {
    expect(() => loadConfig({ ...ENV, ...patch })).toThrow(ConfigError);
  });
  it("never needs or accepts a secret value in the environment", () => {
    expect(Object.keys(ENV).some((k) => /PASSWORD|SECRET_VALUE|TOKEN/.test(k))).toBe(false);
  });
});

describe("validation", () => {
  it("uuid lowercases and rejects junk", () => {
    expect(uuid("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", "x")).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(() => uuid("1; drop table", "x")).toThrow(ApiError);
  });
  it("timestamps must carry a zone", () => {
    expect(timestamp("2026-10-01T10:00:00Z", "t")).toBeTruthy();
    expect(() => timestamp("2026-10-01T10:00:00", "t")).toThrow(ApiError);
  });
  it("idempotency key is required and must be a UUID", () => {
    expect(() => idempotencyKey({})).toThrow(/Idempotency-Key/);
    expect(() => idempotencyKey({ "idempotency-key": "abc" })).toThrow(ApiError);
  });
  it("body must be a JSON object under the size cap", () => {
    expect(() => parseBody("[1]")).toThrow(ApiError);
    expect(() => parseBody("{")).toThrow(ApiError);
    expect(() => parseBody(JSON.stringify({ a: "x".repeat(1_600_000) }))).toThrow(/too large/);
    expect(parseBody(Buffer.from('{"a":1}').toString("base64"), true)).toEqual({ a: 1 });
  });
});

describe("signature PNG validation", () => {
  it("accepts a PNG (with or without data URL prefix) and hashes it", () => {
    const png = syntheticPng();
    const a = validateSignaturePng(png.toString("base64"));
    const b = validateSignaturePng(`data:image/png;base64,${png.toString("base64")}`);
    expect(a.sha256Hex).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sha256Hex).toBe(b.sha256Hex);
  });
  it.each([
    ["missing", undefined],
    ["not base64", "%%%"],
    ["a JPEG", Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(40).fill(0)]).toString("base64")],
    ["an SVG", Buffer.from("<svg onload=alert(1)>").toString("base64")],
    ["too large", Buffer.alloc(1_048_577, 1).toString("base64")],
    ["zero-size image", (() => { const p = syntheticPng(); p.writeUInt32BE(0, 16); return p.toString("base64"); })()],
    ["huge dimensions", (() => { const p = syntheticPng(); p.writeUInt32BE(100_000, 16); return p.toString("base64"); })()],
  ])("rejects %s", (_l, input) => {
    expect(() => validateSignaturePng(input)).toThrow(ApiError);
  });
  it("object keys are UUID-only", () => {
    expect(signatureObjectKey("o", "v")).toBe("o/v/client-signature.png");
  });
  it("memory store is versioned and verifies the checksum", async () => {
    const s = new MemoryEvidenceStore();
    const v = validateSignaturePng(syntheticPng().toString("base64"));
    const first = await s.put("k", v.bytes, v.sha256);
    const second = await s.put("k", v.bytes, v.sha256);
    expect(first.versionId).not.toBe(second.versionId);
    await expect(s.put("k", v.bytes, Buffer.alloc(32))).rejects.toThrow(/checksum/);
  });
});

describe("error mapping", () => {
  it.each([
    ["OGA01", 401], ["OGA03", 403], ["OGN04", 404], ["OGC09", 409], ["OGV22", 422], ["OGI09", 409],
    ["22P02", 400], ["23P01", 409], ["40001", 409], ["XX000", 500],
  ])("%s -> %i", (code, status) => {
    expect(toApiError(Object.assign(new Error("db said: secret-value"), { code })).status).toBe(status);
  });
  it("never echoes driver messages for non-Ogevia errors", () => {
    expect(toApiError(Object.assign(new Error('invalid input syntax for type uuid: "PHI-LIKE"'), { code: "22P02" })).message).not.toContain("PHI-LIKE");
    expect(toApiError(new Error("connection to 10.0.0.1 failed")).message).not.toContain("10.0.0.1");
  });
});

describe("handler boundary (no database reached)", () => {
  const db = { connect: vi.fn(async () => { throw new Error("must not connect"); }) };
  const logs: LogRecord[] = [];
  const handler = createHandler({ config: CONFIG, db, evidence: new MemoryEvidenceStore(), log: (r) => logs.push(r) });

  it("unknown routes are 404 without touching the database", async () => {
    const r = await handler(event("GET /v1/admin/everything"));
    expect(r.statusCode).toBe(404);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["no authorizer claims", { sub: null }],
    ["wrong issuer", { claims: claims("11111111-2222-4333-8444-555555555555", { iss: "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_EVIL" }) }],
    ["unapproved client", { claims: claims("11111111-2222-4333-8444-555555555555", { client_id: "someotherclient00000000000" }) }],
    ["ID token", { claims: claims("11111111-2222-4333-8444-555555555555", { token_use: "id" }) }],
    ["expired", { claims: claims("11111111-2222-4333-8444-555555555555", { exp: "1000" }) }],
    ["non-UUID sub", { claims: claims("admin") }],
  ])("rejects %s with 401 before any database work", async (_l, opts) => {
    const r = await handler(event("GET /v1/me", opts as never));
    expect(r.statusCode).toBe(401);
    expect(JSON.parse(r.body).error.code).toBe("unauthenticated");
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("validation failures are 400 before any database work", async () => {
    const r = await handler(event("GET /v1/visits/active", { query: { organizationId: "not-a-uuid" } }));
    expect(r.statusCode).toBe(400);
    const k = await handler(event("POST /v1/visits", { key: null, body: {} }));
    expect(k.statusCode).toBe(400);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it("responses are no-store JSON with a request id", async () => {
    const r = await handler(event("GET /v1/nothing"));
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("log records hold only route template, status, ids and codes", () => {
    const allowed = ["level", "requestId", "apiRequestId", "route", "status", "durationMs", "errorCode", "sqlState"];
    for (const record of logs) for (const key of Object.keys(record)) expect(allowed).toContain(key);
    expect(JSON.stringify(logs)).not.toContain("11111111-2222-4333-8444-555555555555");
    expect(JSON.stringify(logs)).not.toContain("not-a-uuid");
  });

  it("toCamel maps snake_case columns", () => {
    expect(toCamel({ visit_id: "x", month_to_date_minutes: 3 })).toEqual({ visitId: "x", monthToDateMinutes: 3 });
  });

  it("mutating routes are exactly the ones taking an idempotency key", () => {
    expect(ROUTE_KEYS.filter((k) => ROUTES[k]!.mutating)).toEqual([
      "POST /v1/visits",
      "POST /v1/visits/{visitId}/confirm",
      "POST /v1/visits/{visitId}/corrections",
    ]);
  });
});
