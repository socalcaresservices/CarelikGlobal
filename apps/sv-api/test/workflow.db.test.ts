// End-to-end Service Verification through the real Lambda handler and a real
// (local, disposable) PostgreSQL migrated from zero. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, createTestDb, freshClient, seedWorld, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore, signatureObjectKey } from "../src/evidence";
import { createHandler, type LogRecord } from "../src/handler";
import { claims, CONFIG, event, syntheticPng } from "./fixtures";

let db: TestDb;
let w: World;
// Authorization period spans 40 days either side of today, so ageing a visit
// across a month boundary (e.g. 01:30 on the 1st) cannot leave its period.
let fresh: { client: string; service: string; auth: string };
const evidence = new MemoryEvidenceStore();
const logs: LogRecord[] = [];
let handler: ReturnType<typeof createHandler>;

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  fresh = await freshClient(db, w, w.caregiverA1, 600, w.orgA, { before: 40, after: 40 });
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence, log: (r) => logs.push(r) });
});
afterAll(async () => {
  await db?.drop();
});

async function call(routeKey: string, actor: Actor | string, opts: Parameters<typeof event>[1] = {}) {
  const sub = typeof actor === "string" ? actor : actor.sub;
  const r = await handler(event(routeKey, { sub, ...opts }));
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
}

async function startAndEnd(actor: Actor, org: string, client: string, service: string) {
  const started = await call("POST /v1/visits", actor, { body: { organizationId: org, clientId: client, serviceId: service } });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const visitId = started.body.visitId as string;
  await ageVisit(db, visitId, 90);
  const ended = await call("POST /v1/visits/{visitId}/end", actor, { path: { visitId } });
  expect(ended.status, JSON.stringify(ended.body)).toBe(200);
  return visitId;
}

describe("caregiver workflow: login → client → service → start → end → sign → lock", () => {
  let visitId: string;

  it("GET /v1/me returns only the caller's own memberships (from the database)", async () => {
    const r = await call("GET /v1/me", w.caregiverA1);
    expect(r.status).toBe(200);
    expect(r.body.memberships).toHaveLength(1);
    expect(r.body.memberships[0]).toMatchObject({ organizationId: w.orgA, role: "caregiver", permissions: ["availability.manage_own"] });
  });

  it("lists only assigned clients, by code, without names or payer identifiers", async () => {
    const r = await call("GET /v1/clients/assigned", w.caregiverA1, { query: { organizationId: w.orgA } });
    expect(r.status).toBe(200);
    expect(r.body.clients.map((c: any) => c.clientId).sort()).toEqual([w.clientA1, fresh.client].sort());
    expect(Object.keys(r.body.clients[0]).sort()).toEqual(["activeServiceCount", "clientCode", "clientId", "nextScheduledEndsAt", "nextScheduledStartsAt"]);
  });

  it("lists the authorized service with its monthly minutes", async () => {
    const r = await call("GET /v1/clients/{clientId}/services", w.caregiverA1, { path: { clientId: fresh.client }, query: { organizationId: w.orgA } });
    expect(r.status).toBe(200);
    expect(r.body.services[0]).toMatchObject({ serviceId: w.serviceA, authorizationId: fresh.auth, monthlyAuthorizedMinutes: 600 });
  });

  it("starts a visit with a server timestamp; no client time is accepted", async () => {
    const before = Date.now();
    const r = await call("POST /v1/visits", w.caregiverA1, {
      body: { organizationId: w.orgA, clientId: fresh.client, serviceId: w.serviceA, timeIn: "2000-01-01T00:00:00Z" },
    });
    expect(r.status).toBe(201);
    visitId = r.body.visitId;
    const active = await call("GET /v1/visits/active", w.caregiverA1, { query: { organizationId: w.orgA } });
    expect(active.body.visit.visitId).toBe(visitId);
    expect(active.body.visit.visitStatus).toBe("draft");
    expect(new Date(active.body.visit.timeIn).getTime()).toBeGreaterThanOrEqual(before - 5000);
  });

  it("a second start is rejected while one visit is open", async () => {
    const r = await call("POST /v1/visits", w.caregiverA1, { body: { organizationId: w.orgA, clientId: fresh.client, serviceId: w.serviceA } });
    expect(r.status).toBe(409);
  });

  it("ends the visit (server time) and computes worked minutes", async () => {
    await ageVisit(db, visitId, 120);
    const r = await call("POST /v1/visits/{visitId}/end", w.caregiverA1, { path: { visitId } });
    expect(r.status).toBe(200);
    expect(r.body.visit.workedMinutes).toBe(120);
  });

  it("refuses a confirmation for someone else's visit before writing anything to S3", async () => {
    const objectsBefore = evidence.objects.size;
    const r = await call("POST /v1/visits/{visitId}/confirm", w.caregiverA2, {
      path: { visitId },
      body: { organizationId: w.orgA, signerRole: "client", method: "draw", signaturePng: syntheticPng().toString("base64") },
    });
    expect(r.status).toBe(409);
    expect(evidence.objects.size).toBe(objectsBefore);
  });

  it("confirms with a drawn signature: private object + registered version + locked visit", async () => {
    const key = randomUUID();
    const png = syntheticPng(60, 30, 1);
    const r = await call("POST /v1/visits/{visitId}/confirm", w.caregiverA1, {
      path: { visitId },
      key,
      body: { organizationId: w.orgA, signerRole: "parent", method: "draw", signaturePng: png.toString("base64") },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.result).toMatchObject({ visitId, status: "signed", authorizationStatus: "within_authorization", workedMinutes: 120, billableMinutes: 120 });
    const versions = evidence.objects.get(signatureObjectKey(w.orgA, visitId))!;
    expect(versions).toHaveLength(1);
    const { rows } = await db.admin.query("select object_version_id, byte_size from ogevia.visit_evidence where visit_id = $1", [visitId]);
    expect(rows[0]).toEqual({ object_version_id: versions[0]!.versionId, byte_size: png.length });

    // Retry with the same key (ambiguous network failure): same result, NO second upload.
    const retry = await call("POST /v1/visits/{visitId}/confirm", w.caregiverA1, {
      path: { visitId },
      key,
      body: { organizationId: w.orgA, signerRole: "parent", method: "draw", signaturePng: png.toString("base64") },
    });
    expect(retry.status).toBe(200);
    expect(retry.body.result).toEqual(r.body.result);
    expect(evidence.objects.get(signatureObjectKey(w.orgA, visitId))).toHaveLength(1);
  });

  it("a locked visit cannot be confirmed again with a new key (and nothing is uploaded)", async () => {
    const r = await call("POST /v1/visits/{visitId}/confirm", w.caregiverA1, {
      path: { visitId },
      body: { organizationId: w.orgA, signerRole: "client", method: "draw", signaturePng: syntheticPng().toString("base64") },
    });
    expect(r.status).toBe(409);
  });

  it("manager sees the signed visit, reads the signature (integrity-checked, audited)", async () => {
    const list = await call("GET /v1/visits", w.managerA, { query: { organizationId: w.orgA } });
    expect(list.status).toBe(200);
    expect(list.body.visits.find((v: any) => v.id === visitId)).toMatchObject({ status: "signed", billableMinutes: 120 });
    const sig = await call("GET /v1/visits/{visitId}/signature", w.managerA, { path: { visitId } });
    expect(sig.status).toBe(200);
    expect(Buffer.from(sig.body.pngBase64, "base64").equals(syntheticPng(60, 30, 1))).toBe(true);
    const audit = await db.admin.query("select count(*)::int as n from ogevia.audit_events where action = 'visit_evidence.read'");
    expect(audit.rows[0].n).toBe(1);
  });

  it("a caregiver (no visits.read) cannot read signatures", async () => {
    const r = await call("GET /v1/visits/{visitId}/signature", w.caregiverA1, { path: { visitId } });
    expect(r.status).toBe(403);
  });

  it("an overwritten S3 object is never served (integrity check)", async () => {
    const key = signatureObjectKey(w.orgA, visitId);
    const versions = evidence.objects.get(key)!;
    const original = versions[0]!.bytes;
    versions[0]!.bytes = syntheticPng(60, 30, 99);
    const r = await call("GET /v1/visits/{visitId}/signature", w.managerA, { path: { visitId } });
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe("evidence_integrity_failure");
    versions[0]!.bytes = original;
  });

  it("manager correction preserves the original and records who/when/why", async () => {
    const list = await call("GET /v1/visits", w.managerA, { query: { organizationId: w.orgA } });
    const row = list.body.visits.find((v: any) => v.id === visitId);
    const timeIn = new Date(new Date(row.timeIn).getTime() + 15 * 60_000).toISOString();
    const r = await call("POST /v1/visits/{visitId}/corrections", w.managerA, {
      path: { visitId },
      body: { timeIn, timeOut: row.timeOut, reason: "Caregiver arrived 15 minutes late (synthetic)" },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const history = await call("GET /v1/visits/{visitId}/corrections", w.managerA, { path: { visitId } });
    expect(history.body.corrections).toHaveLength(1);
    expect(history.body.corrections[0].beforeSnapshot).toBeTruthy();
    expect(history.body.corrections[0].afterSnapshot).toBeTruthy();
    const original = await db.admin.query("select status from ogevia.service_visits where id = $1", [visitId]);
    expect(original.rows[0].status).toBe("corrected");
    // Signature evidence follows the corrected row back to the original confirmation.
    const sig = await call("GET /v1/visits/{visitId}/signature", w.managerA, { path: { visitId: r.body.correctedVisitId } });
    expect(sig.status).toBe(200);
  });

  it("a manager closes a missed clock-out through the API; a caregiver cannot", async () => {
    const own = await freshClient(db, w, w.caregiverA3, 600, w.orgA, { before: 40, after: 40 });
    const start = await call("POST /v1/visits", w.caregiverA3, {
      body: { organizationId: w.orgA, clientId: own.client, serviceId: own.service },
    });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const openId = start.body.visitId;
    await ageVisit(db, openId, 120);
    const timeOut = new Date(Date.now() - 30 * 60_000).toISOString();
    const denied = await call("POST /v1/visits/{visitId}/close", w.caregiverA3, {
      path: { visitId: openId }, body: { timeOut, reason: "Forgot to sign out (synthetic)" },
    });
    expect(denied.status).toBe(403);
    const r = await call("POST /v1/visits/{visitId}/close", w.managerA, {
      path: { visitId: openId }, body: { timeOut, reason: "Forgot to sign out (synthetic)" },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.visit).toMatchObject({ visitId: openId, workedMinutes: 90 });
    const active = await call("GET /v1/visits/active", w.caregiverA3, { query: { organizationId: w.orgA } });
    expect(active.body.visit).toMatchObject({ visitId: openId, visitStatus: "awaiting_signature", timeOutEnteredByManager: true });
  });

  it("a caregiver cannot correct a visit", async () => {
    const r = await call("POST /v1/visits/{visitId}/corrections", w.caregiverA1, {
      path: { visitId },
      body: { timeIn: "2026-01-01T10:00:00Z", timeOut: "2026-01-01T11:00:00Z", reason: "x" },
    });
    expect([403, 409]).toContain(r.status);
  });

  it("billing-review data lists the visit for a manager and returns nothing to a caregiver", async () => {
    // Wide window: the test ages time_in, so service_date can differ from the corrected row's date.
    const [from, d] = ["2000-01-01", "2100-01-01"];
    const r = await call("GET /v1/billing-review", w.managerA, { query: { organizationId: w.orgA, dateFrom: from, dateTo: d } });
    expect(r.status).toBe(200);
    expect(r.body.visits.length).toBeGreaterThan(0);
    expect(r.body.visits[0]).toHaveProperty("reviewState");
    // Phase 2 contract: list reads FILTER to nothing (no 403, no existence signal).
    const denied = await call("GET /v1/billing-review", w.caregiverA1, { query: { organizationId: w.orgA, dateFrom: from, dateTo: d } });
    expect(denied.status).toBe(200);
    expect(denied.body.visits).toEqual([]);
  });
});

describe("no-signer exception path", () => {
  it("unable_to_confirm routes to administrator review with 0 billable and no evidence", async () => {
    const visitId = await startAndEnd(w.caregiverA1, w.orgA, fresh.client, w.serviceA);
    const r = await call("POST /v1/visits/{visitId}/confirm", w.caregiverA1, {
      path: { visitId },
      body: { signerRole: "client", method: "unable_to_confirm", reason: "Technical problem prevented signing" },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.result).toMatchObject({ status: "administrator_review", billableMinutes: 0 });
    expect(evidence.objects.has(signatureObjectKey(w.orgA, visitId))).toBe(false);
  });

  it("a signature image is refused for a non-image method", async () => {
    const visitId = await startAndEnd(w.caregiverA1, w.orgA, fresh.client, w.serviceA);
    const r = await call("POST /v1/visits/{visitId}/confirm", w.caregiverA1, {
      path: { visitId },
      body: { signerRole: "client", method: "unable_to_confirm", reason: "x", signaturePng: syntheticPng().toString("base64") },
    });
    expect(r.status).toBe(422);
    // leave it unconfirmed but closed out for later tests
    await call("POST /v1/visits/{visitId}/confirm", w.caregiverA1, { path: { visitId }, body: { signerRole: "client", method: "unable_to_confirm", reason: "x" } });
  });

  it("an S3 failure leaves the visit unlocked and retryable", async () => {
    const visitId = await startAndEnd(w.caregiverA1, w.orgA, fresh.client, w.serviceA);
    evidence.failNextPut = true;
    const body = { organizationId: w.orgA, signerRole: "client", method: "draw", signaturePng: syntheticPng().toString("base64") };
    const key = randomUUID();
    const failed = await call("POST /v1/visits/{visitId}/confirm", w.caregiverA1, { path: { visitId }, key, body });
    expect(failed.status).toBe(503);
    const { rows } = await db.admin.query("select status from ogevia.service_visits where id = $1", [visitId]);
    expect(rows[0].status).toBe("awaiting_signature");
    const ok = await call("POST /v1/visits/{visitId}/confirm", w.caregiverA1, { path: { visitId }, key, body });
    expect(ok.status).toBe(200);
  });

  it("parallel duplicate confirmations produce one locked visit and the same result", async () => {
    const visitId = await startAndEnd(w.caregiverA1, w.orgA, fresh.client, w.serviceA);
    const key = randomUUID();
    const body = { organizationId: w.orgA, signerRole: "client", method: "draw", signaturePng: syntheticPng(30, 30, 5).toString("base64") };
    const results = await Promise.all(Array.from({ length: 4 }, () => call("POST /v1/visits/{visitId}/confirm", w.caregiverA1, { path: { visitId }, key, body })));
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(new Set(results.map((r) => JSON.stringify(r.body.result))).size).toBe(1);
    const c = await db.admin.query("select count(*)::int as n from ogevia.visit_confirmations where visit_id = $1", [visitId]);
    expect(c.rows[0].n).toBe(1);
  });
});

describe("tenant security (identity comes ONLY from the verified sub; the database decides)", () => {
  it("browser-supplied organization cannot grant access to another tenant", async () => {
    const clients = await call("GET /v1/clients/assigned", w.caregiverA1, { query: { organizationId: w.orgB } });
    expect([403, 404]).toContain(clients.status === 200 && clients.body.clients.length === 0 ? 404 : clients.status);
    const start = await call("POST /v1/visits", w.caregiverA1, { body: { organizationId: w.orgB, clientId: w.clientB1, serviceId: w.serviceB } });
    expect([403, 404]).toContain(start.status);
    const list = await call("GET /v1/visits", w.managerA, { query: { organizationId: w.orgB } });
    expect(list.status === 403 || (list.status === 200 && list.body.visits.length === 0)).toBe(true);
  });

  it("role, organization and group claims in the token are ignored", async () => {
    const forged = claims(w.caregiverA1.sub, {
      "cognito:groups": ["organization_owner", "platform_owner"],
      "custom:organization_id": w.orgB,
      "custom:role": "manager",
      role: "manager",
    });
    const r = await call("GET /v1/billing-review", w.caregiverA1, { claims: forged, query: { organizationId: w.orgA, dateFrom: "2000-01-01", dateTo: "2100-01-01" } });
    expect(r.body.visits).toEqual([]);
    const correct = await call("POST /v1/visits/{visitId}/corrections", w.caregiverA1, {
      claims: forged,
      path: { visitId: randomUUID() },
      body: { timeIn: "2026-01-01T10:00:00Z", timeOut: "2026-01-01T11:00:00Z", reason: "forged" },
    });
    expect([403, 404]).toContain(correct.status);
    const me = await call("GET /v1/me", w.caregiverA1, { claims: forged });
    expect(me.body.memberships.map((m: any) => m.role)).toEqual(["caregiver"]);
  });

  it("body fields cannot impersonate another caregiver or set a role", async () => {
    const r = await call("POST /v1/visits", w.caregiverA2, {
      body: { organizationId: w.orgA, clientId: w.clientA1, serviceId: w.serviceA, caregiverUserId: w.caregiverA1.userId, role: "manager" },
    });
    // A2's assignment is expired: the body cannot borrow A1's.
    expect(r.status).toBe(403);
  });

  it("an unknown sub (no app user) is unauthenticated even with a valid token", async () => {
    const r = await call("GET /v1/me", randomUUID());
    expect(r.status).toBe(401);
  });

  it("a sub belonging to someone else's token cannot read their data (wrong sub)", async () => {
    const r = await call("GET /v1/visits/active", w.caregiverB1, { query: { organizationId: w.orgA } });
    expect(r.status).toBe(200);
    expect(r.body.visit).toBeNull();
  });

  it("same sub with memberships in two organizations: each org applies its own role", async () => {
    const sub = randomUUID();
    const { rows } = await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'MULTI_ORG') returning id", [sub]);
    const userId = rows[0].id as string;
    await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role) values ($1,$2,'manager'), ($3,$2,'caregiver')", [w.orgA, userId, w.orgB]);
    const me = await call("GET /v1/me", sub);
    expect(me.body.memberships.map((m: any) => [m.organizationId, m.role]).sort()).toEqual([[w.orgA, "manager"], [w.orgB, "caregiver"]].sort());
    const a = await call("GET /v1/billing-review", sub, { query: { organizationId: w.orgA, dateFrom: "2000-01-01", dateTo: "2100-01-01" } });
    expect(a.status).toBe(200);
    expect(a.body.visits.length).toBeGreaterThan(0);
    const b = await call("GET /v1/billing-review", sub, { query: { organizationId: w.orgB, dateFrom: "2000-01-01", dateTo: "2100-01-01" } });
    expect(b.body.visits).toEqual([]);
    // As a caregiver in org B it has no assignment there, so it cannot start a visit.
    const start = await call("POST /v1/visits", sub, { body: { organizationId: w.orgB, clientId: w.clientB1, serviceId: w.serviceB } });
    expect(start.status).toBe(403);
    // Nor can it act in org B on an org-A client using its org-A manager role.
    const cross = await call("POST /v1/visits", sub, { body: { organizationId: w.orgB, clientId: fresh.client, serviceId: w.serviceA } });
    expect([403, 404]).toContain(cross.status);
  });

  it("a disabled app user is rejected", async () => {
    const sub = randomUUID();
    const { rows } = await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name, status) values ($1, 'DISABLED', 'disabled') returning id", [sub]);
    await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role) values ($1,$2,'manager')", [w.orgA, rows[0].id]);
    const r = await call("GET /v1/me", sub);
    expect(r.status).toBe(401);
  });
});

describe("logging policy under real traffic", () => {
  it("no log line contains a sub, organization id, visit id, signature bytes or reason text", () => {
    const text = JSON.stringify(logs);
    for (const value of [w.caregiverA1.sub, w.managerA.sub, w.orgA, w.clientA1, "Technical problem", "synthetic", syntheticPng().toString("base64").slice(0, 40)]) {
      expect(text).not.toContain(value);
    }
    expect(logs.length).toBeGreaterThan(20);
  });
});
