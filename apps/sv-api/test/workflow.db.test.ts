// End-to-end Service Verification through the real Lambda handler and a real
// (local, disposable) PostgreSQL migrated from zero. SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, createTestDb, endedVisit, freshClient, seedWorld, signedVisit, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { MemoryEvidenceStore, signatureObjectKey } from "../src/evidence";
import { createHandler, type LogRecord } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { claims, CONFIG, event, syntheticPng } from "./fixtures";

let db: TestDb;
let w: World;
// Authorization period spans 40 days either side of today, so ageing a visit
// across a month boundary (e.g. 01:30 on the 1st) cannot leave its period.
let fresh: { client: string; service: string; auth: string };
const evidence = new MemoryEvidenceStore();
const logs: LogRecord[] = [];
const identity = new MemoryIdentityAdmin();
let handler: ReturnType<typeof createHandler>;

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  fresh = await freshClient(db, w, w.caregiverA1, 600, w.orgA, { before: 40, after: 40 });
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence, identity, log: (r) => logs.push(r) });
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
    expect(r.body.memberships[0]).toMatchObject({ organizationId: w.orgA, role: "caregiver", permissions: ["availability.manage_own", "documents.manage_own"] });
  });

  it("lists only assigned clients, by code, without names or payer identifiers", async () => {
    const r = await call("GET /v1/clients/assigned", w.caregiverA1, { query: { organizationId: w.orgA } });
    expect(r.status).toBe(200);
    expect(r.body.clients.map((c: any) => c.clientId).sort()).toEqual([w.clientA1, fresh.client].sort());
    expect(Object.keys(r.body.clients[0]).sort()).toEqual(["activeServiceCount", "clientCode", "clientId", "nextScheduledEndsAt", "nextScheduledServiceId", "nextScheduledStartsAt"]);
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

describe("human billing approval (0019) through the API", () => {
  const range = { dateFrom: "2000-01-01", dateTo: "2100-01-01" };
  it("manager approves; scheduler and caregiver are refused; the manager sees no dollar amounts; void needs a reason", async () => {
    const own = await freshClient(db, w, w.caregiverA2, 600);
    const { visit } = await signedVisit(db, w.caregiverA2, w, 40, w.orgA, own.client);

    for (const who of [w.schedulerA, w.caregiverA2]) {
      const denied = await call("POST /v1/visits/{visitId}/billing-approval", who, { path: { visitId: visit }, body: { approvedMinutes: 40 } });
      expect(denied.status).toBe(403);
    }
    const bad = await call("POST /v1/visits/{visitId}/billing-approval", w.managerA, { path: { visitId: visit }, body: { approvedMinutes: "40" } });
    expect(bad.status).toBe(400);
    const over = await call("POST /v1/visits/{visitId}/billing-approval", w.managerA, { path: { visitId: visit }, body: { approvedMinutes: 41 } });
    expect(over.status).toBe(422);

    const key = randomUUID();
    const ok = await call("POST /v1/visits/{visitId}/billing-approval", w.managerA, { path: { visitId: visit }, body: { approvedMinutes: 40, notes: "Matches timesheet" }, key });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const retry = await call("POST /v1/visits/{visitId}/billing-approval", w.managerA, { path: { visitId: visit }, body: { approvedMinutes: 40, notes: "Matches timesheet" }, key });
    expect(retry.status).toBe(201);
    expect(retry.body.billingApprovalId).toBe(ok.body.billingApprovalId);
    const twice = await call("POST /v1/visits/{visitId}/billing-approval", w.ownerA, { path: { visitId: visit }, body: { approvedMinutes: 40 } });
    expect(twice.status).toBe(409);

    const list = await call("GET /v1/billing-approvals", w.managerA, { query: { organizationId: w.orgA, ...range } });
    expect(list.status).toBe(200);
    const mine = list.body.approvals.find((a: any) => a.billingApprovalId === ok.body.billingApprovalId);
    expect(mine).toMatchObject({ approvedMinutes: 40, rateCents: null, amountCents: null });
    const cg = await call("GET /v1/billing-approvals", w.caregiverA2, { query: { organizationId: w.orgA, ...range } });
    expect(cg.body.approvals).toEqual([]);
    const other = await call("GET /v1/billing-approvals", w.managerB, { query: { organizationId: w.orgA, ...range } });
    expect(other.body.approvals).toEqual([]);

    const noReason = await call("POST /v1/billing-approvals/{approvalId}/void", w.managerA, { path: { approvalId: ok.body.billingApprovalId }, body: {} });
    expect(noReason.status).toBe(400);
    const voided = await call("POST /v1/billing-approvals/{approvalId}/void", w.managerA, { path: { approvalId: ok.body.billingApprovalId }, body: { reason: "Approved the wrong visit" } });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
  });
});

describe("workspace (0020) through the API", () => {
  it("GET /v1/me returns the caller's own display name (null when unset), and the caller can complete it", async () => {
    const before = await call("GET /v1/me", w.schedulerA);
    expect(before.status).toBe(200);
    expect(before.body.profile).toHaveProperty("displayName");
    const bad = await call("POST /v1/me/display-name", w.schedulerA, { body: { displayName: "" } });
    expect(bad.status).toBe(400);
    const ok = await call("POST /v1/me/display-name", w.schedulerA, { body: { displayName: "Synthetic Scheduler" } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await call("GET /v1/me", w.schedulerA)).body.profile.displayName).toBe("Synthetic Scheduler");
  });

  it("branding: members read it; only the owner changes it; a too-light colour is refused", async () => {
    const read = await call("GET /v1/branding", w.caregiverA1, { query: { organizationId: w.orgA } });
    expect(read.status).toBe(200);
    expect(read.body.branding).toHaveProperty("accentColor");
    const denied = await call("POST /v1/branding", w.managerA, { body: { organizationId: w.orgA, displayName: "X Agency", accentColor: "#1f5f8b" } });
    expect(denied.status).toBe(403);
    const light = await call("POST /v1/branding", w.ownerA, { body: { organizationId: w.orgA, displayName: "Synthetic Agency A", accentColor: "#fff2cc" } });
    expect(light.status).toBe(422);
    const ok = await call("POST /v1/branding", w.ownerA, { body: { organizationId: w.orgA, displayName: "Synthetic Agency A", accentColor: "#1f5f8b" } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.branding).toMatchObject({ displayName: "Synthetic Agency A", accentColor: "#1f5f8b" });
    const other = await call("GET /v1/branding", w.managerB, { query: { organizationId: w.orgA } });
    expect(other.status).toBe(404);
  });

  it("attention and utilisation: managers get counts and hours without dollar values; caregivers get nothing", async () => {
    const a = await call("GET /v1/attention", w.managerA, { query: { organizationId: w.orgA } });
    expect(a.status).toBe(200);
    expect(a.body.summary).toHaveProperty("total");
    expect((await call("GET /v1/attention", w.caregiverA1, { query: { organizationId: w.orgA } })).body.summary).toBeNull();
    const month = new Date().toISOString().slice(0, 7) + "-01";
    const m = await call("GET /v1/reports/utilisation", w.managerA, { query: { organizationId: w.orgA, monthStart: month } });
    expect(m.status).toBe(200);
    for (const row of m.body.services) expect(row).toMatchObject({ billableValueCents: null, approvedValueCents: null, unusedValueCents: null });
    const c = await call("GET /v1/reports/utilisation", w.caregiverA1, { query: { organizationId: w.orgA, monthStart: month } });
    expect(c.body.services).toEqual([]);
  });
});

describe("continuity pack (0027) through the API", () => {
  it("manager downloads the agency's pack with a data-as-of time and outage numbers; status reflects it; caregivers refused", async () => {
    const key = crypto.randomUUID();
    const p = await call("POST /v1/continuity/pack", w.managerA, { body: { organizationId: w.orgA }, key });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.pack).toMatchObject({ outage_numbers: { first: 1, last: 25 }, includes_client_names: true });
    expect(Date.parse(p.body.pack.data_as_of)).toBeGreaterThan(Date.now() - 60_000);
    expect(JSON.stringify(p.body.pack)).not.toMatch(/cents|payer|rate/i);
    const again = await call("POST /v1/continuity/pack", w.managerA, { body: { organizationId: w.orgA }, key });
    expect(again.body.pack.outage_numbers).toEqual(p.body.pack.outage_numbers);
    const s = await call("GET /v1/continuity/status", w.managerA, { query: { organizationId: w.orgA } });
    expect(s.status).toBe(200);
    expect(Number(s.body.status.hoursSince)).toBeLessThan(1);
    const c = await call("POST /v1/continuity/pack", w.caregiverA1, { body: { organizationId: w.orgA } });
    expect(c.status).toBe(403);
    const other = await call("POST /v1/continuity/pack", w.managerB, { body: { organizationId: w.orgA } });
    expect([403, 404]).toContain(other.status);
  });
});

describe("outage visit records (0028) through the API", () => {
  it("manager enters a numbered record once; duplicates refused; reconciliation lists the rest; caregivers refused", async () => {
    // Numbers 1-25 were issued by the continuity pack test above; this test uses its own block.
    const pack = await call("POST /v1/continuity/pack", w.managerA, { body: { organizationId: w.orgA } });
    const n = pack.body.pack.outage_numbers.first as number;
    const rec = (await db.admin.query("select id from ogevia.caregiver_records where organization_id = $1 and linked_user_id = $2", [w.orgA, w.caregiverA1.userId])).rows[0].id;
    const day = (await db.admin.query("select ((now() at time zone 'America/Los_Angeles')::date - 5)::text as d")).rows[0].d;
    const body = { organizationId: w.orgA, outageNumber: `OUT-${String(n).padStart(6, "0")}`, clientId: fresh.client, serviceId: fresh.service,
      caregiverRecordId: rec, date: day, timeIn: "05:00", timeOut: "06:15", paperConfirmation: "signature_on_form", signerName: "Synthetic Representative" };
    const r = await call("POST /v1/outage-visits", w.managerA, { body });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.visit).toMatchObject({ workedMinutes: 75, outageNumber: n });
    const dup = await call("POST /v1/outage-visits", w.managerA, { body: { ...body, timeIn: "07:00", timeOut: "08:00" } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toMatch(/already entered/);
    const bad = await call("POST /v1/outage-visits", w.managerA, { body: { ...body, outageNumber: "OUT-abc" } });
    expect(bad.status).toBe(400);
    const unused = await call("POST /v1/outage-visits/not-used", w.managerA, { body: { organizationId: w.orgA, outageNumber: n + 1, reason: "Form spoiled (synthetic)" } });
    expect(unused.status, JSON.stringify(unused.body)).toBe(200);
    const open = await call("GET /v1/outage-visits/reconciliation", w.managerA, { query: { organizationId: w.orgA, openOnly: "true" } });
    expect(open.body.records.map((x: { outageNumber: number }) => x.outageNumber)).not.toContain(n);
    expect(open.body.records.map((x: { outageNumber: number }) => x.outageNumber)).not.toContain(n + 1);
    expect(open.body.records.every((x: { state: string }) => x.state === "missing")).toBe(true);
    expect((await call("POST /v1/outage-visits", w.caregiverA1, { body: { ...body, outageNumber: n + 2 } })).status).toBe(403);
  });
});

describe("staff documents (0021) through the API", () => {
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n% synthetic\n"), Buffer.alloc(200, 32)]);
  const docsOf = (a: Actor) => call("GET /v1/documents", a, { query: { organizationId: w.orgA } });
  let doc: string;

  it("manager sets up a type and requests a document from a Care Team member", async () => {
    const t = await call("POST /v1/document-types", w.managerA, { body: { organizationId: w.orgA, name: "TB test (synthetic)", requiresExpiry: true } });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const people = await call("GET /v1/documents/people", w.managerA, { query: { organizationId: w.orgA } });
    const me = (await call("GET /v1/documents", w.caregiverA1, { query: { organizationId: w.orgA } })).body.documents;
    expect(me).toEqual([]);
    const target = people.body.people.find((x: any) => x.caregiverCode === "CG-A1") ?? people.body.people[0];
    const r = await call("POST /v1/documents/requests", w.managerA, {
      body: { organizationId: w.orgA, caregiverRecordId: target.caregiverRecordId, documentTypeId: t.body.documentTypeId, dueOn: null },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    doc = r.body.documentId;
    expect((await call("GET /v1/documents/people", w.caregiverA1, { query: { organizationId: w.orgA } })).body.people).toEqual([]);
  });

  it("refuses spoofed types, oversized files and a missing expiry before storing anything", async () => {
    const owner = (await docsOf(w.managerA)).body.documents.find((d: any) => d.documentId === doc);
    const uploader = w.managerA;
    const before = [...evidence.objects.keys()].filter((k) => k.includes("/documents/")).length;
    const spoof = await call("POST /v1/documents/{documentId}/versions", uploader, { path: { documentId: doc }, body: { organizationId: w.orgA, contentType: "application/pdf", fileBase64: syntheticPng().toString("base64"), expiresOn: "2099-01-01" } });
    expect(spoof.status).toBe(422);
    const big = await call("POST /v1/documents/{documentId}/versions", uploader, { path: { documentId: doc }, body: { organizationId: w.orgA, contentType: "application/pdf", fileBase64: Buffer.concat([pdf, Buffer.alloc(4_000_001)]).toString("base64"), expiresOn: "2099-01-01" } });
    expect([400, 422]).toContain(big.status);
    const noExpiry = await call("POST /v1/documents/{documentId}/versions", uploader, { path: { documentId: doc }, body: { organizationId: w.orgA, contentType: "application/pdf", fileBase64: pdf.toString("base64") } });
    expect(noExpiry.status).toBe(422);
    expect([...evidence.objects.keys()].filter((k) => k.includes("/documents/")).length).toBe(before);
    expect(owner).toBeTruthy();
  });

  it("a storage failure saves nothing; a retry with the same key stores once and returns the same version", async () => {
    evidence.failNextPut = true;
    const failed = await call("POST /v1/documents/{documentId}/versions", w.managerA, { path: { documentId: doc }, body: { organizationId: w.orgA, contentType: "application/pdf", fileBase64: pdf.toString("base64"), expiresOn: "2099-01-01" } });
    expect(failed.status).toBe(503);
    expect((await docsOf(w.managerA)).body.documents.find((d: any) => d.documentId === doc).latestVersionId).toBeNull();

    const key = randomUUID();
    const body = { organizationId: w.orgA, contentType: "application/pdf", fileBase64: pdf.toString("base64"), issuedOn: "2026-01-02", expiresOn: "2099-01-01" };
    const first = await call("POST /v1/documents/{documentId}/versions", w.managerA, { path: { documentId: doc }, body, key });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const putsAfterFirst = [...evidence.objects.keys()].filter((k) => k.startsWith(`${w.orgA}/documents/${doc}/`)).length;
    const retry = await call("POST /v1/documents/{documentId}/versions", w.managerA, { path: { documentId: doc }, body, key });
    expect(retry.status).toBe(201);
    expect(retry.body.version.documentVersionId).toBe(first.body.version.documentVersionId);
    expect([...evidence.objects.keys()].filter((k) => k.startsWith(`${w.orgA}/documents/${doc}/`)).length).toBe(putsAfterFirst);
    const stored = evidence.objects.get(`${w.orgA}/documents/${doc}/${first.body.version.documentVersionId}`)!;
    expect(stored[0]!.contentType).toBe("application/pdf");
  });

  it("files are readable only by permitted people, with an integrity check; review needs a different person", async () => {
    const v = (await docsOf(w.managerA)).body.documents.find((d: any) => d.documentId === doc).latestVersionId;
    const file = await call("GET /v1/document-versions/{versionId}/file", w.ownerA, { path: { versionId: v } });
    expect(file.status).toBe(200);
    expect(Buffer.from(file.body.fileBase64, "base64").equals(pdf)).toBe(true);
    for (const who of [w.managerB, w.outsider, w.schedulerA]) {
      const denied = await call("GET /v1/document-versions/{versionId}/file", who, { path: { versionId: v } });
      expect([401, 404]).toContain(denied.status);
    }
    const self = await call("POST /v1/document-versions/{versionId}/review", w.managerA, { path: { versionId: v }, body: { decision: "verified" } });
    expect(self.status).toBe(403);
    const ok = await call("POST /v1/document-versions/{versionId}/review", w.ownerA, { path: { versionId: v }, body: { decision: "verified" } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // The owner may verify their own upload (audited as an owner self-review).
    const own = await call("POST /v1/documents/{documentId}/versions", w.ownerA, { path: { documentId: doc }, body: { organizationId: w.orgA, contentType: "application/pdf", fileBase64: pdf.toString("base64"), expiresOn: "2099-06-01" } });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const listed = (await docsOf(w.ownerA)).body.documents.find((d: any) => d.documentId === doc);
    expect(listed.latestUploadedByMe).toBe(true);
    const selfOk = await call("POST /v1/document-versions/{versionId}/review", w.ownerA, { path: { versionId: own.body.version.documentVersionId }, body: { decision: "verified" } });
    expect(selfOk.status, JSON.stringify(selfOk.body)).toBe(200);
    const alerts = await call("GET /v1/documents/alerts", w.managerA, { query: { organizationId: w.orgA } });
    expect(alerts.body.alerts).toMatchObject({ expired: 0, awaitingReview: 0 });
  });
});

describe("agency logo and restricted client names (0020) through the API", () => {
  const png = syntheticPng(60, 30, 5);
  it("owner uploads a logo; it is private and readable by members with an integrity check; managers cannot change it", async () => {
    const denied = await call("POST /v1/branding/logo", w.managerA, { body: { organizationId: w.orgA, contentType: "image/png", fileBase64: png.toString("base64") } });
    expect(denied.status).toBe(403);
    const spoof = await call("POST /v1/branding/logo", w.ownerA, { body: { organizationId: w.orgA, contentType: "image/jpeg", fileBase64: png.toString("base64") } });
    expect(spoof.status).toBe(422);
    const big = await call("POST /v1/branding/logo", w.ownerA, { body: { organizationId: w.orgA, contentType: "image/png", fileBase64: Buffer.concat([png, Buffer.alloc(520_000)]).toString("base64") } });
    expect(big.status).toBe(422);
    const ok = await call("POST /v1/branding/logo", w.ownerA, { body: { organizationId: w.orgA, contentType: "image/png", fileBase64: png.toString("base64") } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect([...evidence.objects.keys()].some((k) => k.startsWith(`${w.orgA}/branding/logo/`))).toBe(true);
    const read = await call("GET /v1/branding/logo", w.caregiverA1, { query: { organizationId: w.orgA } });
    expect(read.status).toBe(200);
    expect(Buffer.from(read.body.fileBase64, "base64").equals(png)).toBe(true);
    expect((await call("GET /v1/branding/logo", w.managerB, { query: { organizationId: w.orgA } })).status).toBe(404);
    const b = await call("GET /v1/branding", w.caregiverA1, { query: { organizationId: w.orgA } });
    expect(b.body.branding.logoSha256).toBe(ok.body.logoSha256);
    expect((await call("POST /v1/branding/logo/clear", w.managerA, { body: { organizationId: w.orgA } })).status).toBe(403);
  });

  it("client names: managers set and read them; caregivers and other agencies never get them", async () => {
    const set = await call("POST /v1/clients/{clientId}/legal-name", w.managerA, { path: { clientId: fresh.client }, body: { organizationId: w.orgA, firstName: "Synthetic", lastName: "Calendar Client" } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const m = await call("GET /v1/clients/directory", w.managerA, { query: { organizationId: w.orgA } });
    expect(m.body.clients.find((c: any) => c.clientId === fresh.client)).toMatchObject({ legalFirstName: "Synthetic", legalLastName: "Calendar Client" });
    expect((await call("GET /v1/clients/directory", w.caregiverA1, { query: { organizationId: w.orgA } })).body.clients).toEqual([]);
    expect((await call("GET /v1/clients/directory", w.managerB, { query: { organizationId: w.orgA } })).body.clients).toEqual([]);
    const assigned = await call("GET /v1/clients/assigned", w.caregiverA1, { query: { organizationId: w.orgA } });
    expect(JSON.stringify(assigned.body)).not.toContain("Calendar Client");
    const cg = await call("POST /v1/clients/{clientId}/legal-name", w.caregiverA1, { path: { clientId: fresh.client }, body: { organizationId: w.orgA, firstName: "X", lastName: "Y" } });
    expect(cg.status).toBe(403);
  });
});

describe("client and authorization administration (0022) through the API", () => {
  const body = (extra: Record<string, unknown> = {}) => ({ organizationId: w.orgA, ...extra });

  it("manager creates, edits and deactivates a client; caregivers and other agencies cannot", async () => {
    const created = await call("POST /v1/clients", w.managerA, { body: body({ firstName: "Synthetic", lastName: "Api Client", city: "Fontana" }) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const clientId = created.body.client.clientId as string;
    expect(created.body.client.clientCode).toMatch(/^CL-/);
    const listed = await call("GET /v1/clients", w.managerA, { query: { organizationId: w.orgA } });
    expect(listed.body.clients.find((c: any) => c.clientId === clientId)).toMatchObject({ legalLastName: "Api Client", city: "Fontana", status: "active" });
    const edited = await call("POST /v1/clients/{clientId}/details", w.managerA, { path: { clientId }, body: body({ firstName: "Synthetic", lastName: "Api Client 2" }) });
    expect(edited.status).toBe(200);
    const noReason = await call("POST /v1/clients/{clientId}/status", w.managerA, { path: { clientId }, body: body({ status: "inactive" }) });
    expect(noReason.status).toBe(400);
    const off = await call("POST /v1/clients/{clientId}/status", w.managerA, { path: { clientId }, body: body({ status: "inactive", reason: "On hold" }) });
    expect(off.status).toBe(200);
    expect((await call("POST /v1/clients", w.caregiverA1, { body: body({ firstName: "X", lastName: "Y" }) })).status).toBe(403);
    expect((await call("POST /v1/clients", w.managerB, { body: body({ firstName: "X", lastName: "Y" }) })).status).toBe(404);
    expect((await call("GET /v1/clients", w.managerB, { query: { organizationId: w.orgA } })).body.clients).toEqual([]);
    expect((await call("POST /v1/clients", w.managerA, { body: body({ firstName: "X", lastName: "Y" }), key: null })).status).toBe(400);
  });

  it("authorizations: create, refuse overlap, amend with history; rates are Administrator-only to set and to see", async () => {
    const created = await call("POST /v1/clients", w.managerA, { body: body({ firstName: "Synthetic", lastName: "Api Auth" }) });
    const clientId = created.body.client.clientId as string;
    const services = await call("GET /v1/services", w.managerA, { query: { organizationId: w.orgA } });
    const serviceId = services.body.services[0].serviceId as string;
    const terms = { serviceId, payer: "Synthetic Payer", monthlyAuthorizedMinutes: 1800, periodStart: "2026-11-01", periodEnd: "2026-11-30" };
    expect((await call("POST /v1/clients/{clientId}/authorizations", w.managerA, { path: { clientId }, body: body({ ...terms, monthlyAuthorizedMinutes: 30.5 }) })).status).toBe(400);
    expect((await call("POST /v1/clients/{clientId}/authorizations", w.managerA, { path: { clientId }, body: body({ ...terms, hourlyRateCents: 3000 }) })).status).toBe(403);
    const ok = await call("POST /v1/clients/{clientId}/authorizations", w.ownerA, { path: { clientId }, body: body({ ...terms, hourlyRateCents: 3000 }) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const overlap = await call("POST /v1/clients/{clientId}/authorizations", w.managerA, { path: { clientId }, body: body(terms) });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.message).toMatch(/amend that one instead/);
    const amended = await call("POST /v1/authorizations/{authorizationId}/amend", w.managerA, {
      path: { authorizationId: ok.body.authorizationId },
      body: { payer: "Synthetic Payer", monthlyAuthorizedMinutes: 2400, periodStart: "2026-11-01", periodEnd: "2026-11-30", reason: "Amendment received" },
    });
    expect(amended.status, JSON.stringify(amended.body)).toBe(200);
    expect(amended.body).toMatchObject({ newVersionNumber: 2, affectedVisits: [] });
    const asManager = await call("GET /v1/clients/{clientId}/authorizations", w.managerA, { path: { clientId }, query: { organizationId: w.orgA } });
    expect(asManager.body.authorizations.map((a: any) => [a.versionNumber, a.isCurrent, a.hourlyRateCents])).toEqual([[2, true, null], [1, false, null]]);
    const asOwner = await call("GET /v1/clients/{clientId}/authorizations", w.ownerA, { path: { clientId }, query: { organizationId: w.orgA } });
    expect(asOwner.body.authorizations.map((a: any) => a.hourlyRateCents)).toEqual([3000, 3000]);
    const cg = await call("GET /v1/clients/{clientId}/authorizations", w.caregiverA1, { path: { clientId }, query: { organizationId: w.orgA } });
    expect(cg.body.authorizations).toEqual([]);
  });
});

describe("Care Team and services (0023) through the API", () => {
  it("manager adds and renames a caregiver; status needs a reason; caregivers and other agencies cannot", async () => {
    const created = await call("POST /v1/caregivers", w.managerA, { body: { organizationId: w.orgA, firstName: "Synthetic", lastName: "Api Caregiver", status: "ready" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.caregiver.caregiverRecordId as string;
    expect(created.body.caregiver.caregiverCode).toMatch(/^CG-/);
    expect((await call("POST /v1/caregivers", w.managerA, { body: { organizationId: w.orgA, firstName: "X", lastName: "Y", status: "inactive" } })).status).toBe(400);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/details", w.managerA, { path: { caregiverRecordId: id }, body: { organizationId: w.orgA, firstName: "Synthetic", lastName: "Api Caregiver 2", preferredName: "Sam" } })).status).toBe(200);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/status", w.managerA, { path: { caregiverRecordId: id }, body: { organizationId: w.orgA, status: "inactive" } })).status).toBe(400);
    const off = await call("POST /v1/caregivers/{caregiverRecordId}/status", w.managerA, { path: { caregiverRecordId: id }, body: { organizationId: w.orgA, status: "inactive", reason: "Left (synthetic)" } });
    expect(off.body.result).toMatchObject({ endedAssignments: 0, signInStatus: null });
    const listed = await call("GET /v1/caregivers", w.managerA, { query: { organizationId: w.orgA } });
    expect(listed.body.caregivers.find((c: any) => c.caregiverRecordId === id)).toMatchObject({ lastName: "Api Caregiver 2", preferredName: "Sam", status: "inactive", hasSignIn: false });
    expect((await call("POST /v1/caregivers", w.caregiverA1, { body: { organizationId: w.orgA, firstName: "X", lastName: "Y" } })).status).toBe(403);
    expect((await call("GET /v1/caregivers", w.managerB, { query: { organizationId: w.orgA } })).body.caregivers).toEqual([]);
  });

  it("services: only the Administrator adds, renames and deactivates; duplicates and in-use deactivation are refused", async () => {
    expect((await call("POST /v1/services", w.managerA, { body: { organizationId: w.orgA, code: "MGR1", name: "Manager service" } })).status).toBe(403);
    const created = await call("POST /v1/services", w.ownerA, { body: { organizationId: w.orgA, code: "api-1", name: "Synthetic Api Service" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const serviceId = created.body.serviceId as string;
    expect((await call("POST /v1/services", w.ownerA, { body: { organizationId: w.orgA, code: "API-1", name: "Again" } })).status).toBe(409);
    expect((await call("POST /v1/services/{serviceId}/name", w.ownerA, { path: { serviceId }, body: { organizationId: w.orgA, name: "Synthetic Api Service 2" } })).status).toBe(200);
    const inUse = await call("POST /v1/services/{serviceId}/status", w.ownerA, { path: { serviceId: w.serviceA }, body: { organizationId: w.orgA, active: false, reason: "Stop" } });
    expect(inUse.status).toBe(409);
    expect((await call("POST /v1/services/{serviceId}/status", w.ownerA, { path: { serviceId }, body: { organizationId: w.orgA, active: "no", reason: "Stop" } })).status).toBe(400);
    expect((await call("POST /v1/services/{serviceId}/status", w.ownerA, { path: { serviceId }, body: { organizationId: w.orgA, active: false, reason: "Not offered (synthetic)" } })).status).toBe(200);
    const list = await call("GET /v1/services", w.managerA, { query: { organizationId: w.orgA } });
    expect(list.body.services.find((s: any) => s.serviceId === serviceId)).toMatchObject({ code: "API-1", name: "Synthetic Api Service 2", isActive: false });
  });
});

describe("assignments (0024) through the API", () => {
  it("manager assigns a signed-in caregiver, sees coverage and state, refuses overlap, and ends it; caregivers cannot", async () => {
    const sub = crypto.randomUUID();
    const userId = (await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Synthetic Caregiver') returning id", [sub])).rows[0].id;
    await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1, $2, 'caregiver', 'active')", [w.orgA, userId]);
    const record = (await db.admin.query("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name) values ($1, $2, $3, 'Synthetic', $3) returning id",
      [w.orgA, userId, "API-" + sub.slice(0, 6)])).rows[0].id as string;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
    const body = { organizationId: w.orgA, caregiverRecordId: record, clientId: w.clientA1, serviceId: w.serviceA, effectiveStart: today };
    const created = await call("POST /v1/assignments", w.managerA, { body });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.assignment.hasAuthorization).toBe(true);
    const id = created.body.assignment.assignmentId as string;
    expect((await call("POST /v1/assignments", w.managerA, { body })).status).toBe(409);
    expect((await call("POST /v1/assignments", w.caregiverA1, { body })).status).toBe(403);
    expect((await call("POST /v1/assignments", w.managerA, { body: { ...body, effectiveStart: "not-a-date" } })).status).toBe(400);
    const list = await call("GET /v1/assignments", w.managerA, { query: { organizationId: w.orgA, caregiverRecordId: record } });
    expect(list.body.assignments).toEqual([expect.objectContaining({ assignmentId: id, state: "current", hasAuthorization: true })]);
    expect((await call("POST /v1/assignments/{assignmentId}/end", w.managerA, { path: { assignmentId: id }, body: { organizationId: w.orgA, lastDay: today } })).status).toBe(400);
    const ended = await call("POST /v1/assignments/{assignmentId}/end", w.managerA, { path: { assignmentId: id }, body: { organizationId: w.orgA, lastDay: today, reason: "Schedule change (synthetic)" } });
    expect(ended.body).toEqual({ outcome: "ends_later" });
    expect((await call("GET /v1/assignments", w.managerB, { query: { organizationId: w.orgA } })).body.assignments).toEqual([]);
  });
});

describe("caregiver invitations and planned assignments (0025) through the API", () => {
  it("plan before sign-in, invite, resend, first sign-in; no password or email in responses or logs", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
    const created = await call("POST /v1/caregivers", w.managerA, { body: { organizationId: w.orgA, firstName: "Synthetic", lastName: "Invitee", status: "ready" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const record = created.body.caregiver.caregiverRecordId as string;

    const planned = await call("POST /v1/assignments", w.managerA, { body: { organizationId: w.orgA, caregiverRecordId: record, clientId: w.clientA1, serviceId: w.serviceA, effectiveStart: today } });
    expect(planned.status, JSON.stringify(planned.body)).toBe(201);
    expect(planned.body.assignment).toMatchObject({ grantsAccess: false, hasAuthorization: true });

    const path = { caregiverRecordId: record };
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/invitation", w.caregiverA1, { path, body: { organizationId: w.orgA, email: "invitee@example.test" } })).status).toBe(403);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/invitation", w.managerB, { path, body: { organizationId: w.orgA, email: "invitee@example.test" } })).status).toBe(404);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/invitation", w.managerA, { path, body: { organizationId: w.orgA, email: "nope" } })).status).toBe(422);
    expect(identity.calls).toEqual([]); // refused before any sign-in was created

    const inv = await call("POST /v1/caregivers/{caregiverRecordId}/invitation", w.managerA, { path, body: { organizationId: w.orgA, email: "Invitee@Example.test" } });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect(inv.body.invitation).toEqual({ invitationId: expect.any(String), existingAccount: false });
    expect(identity.calls).toEqual([{ action: "invite", email: "invitee@example.test" }]);
    expect(JSON.stringify(inv.body)).not.toMatch(/password/i);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/invitation", w.managerA, { path, body: { organizationId: w.orgA, email: "invitee@example.test" } })).status).toBe(409);

    const list = await call("GET /v1/caregivers", w.managerA, { query: { organizationId: w.orgA } });
    expect(list.body.caregivers.find((c: any) => c.caregiverRecordId === record)).toMatchObject({ hasSignIn: true, invitationEmail: "invitee@example.test", invitationSendCount: 1, firstSignedInAt: null });
    const assignments = await call("GET /v1/assignments", w.managerA, { query: { organizationId: w.orgA, caregiverRecordId: record } });
    expect(assignments.body.assignments[0]).toMatchObject({ grantsAccess: true });

    const resent = await call("POST /v1/caregivers/{caregiverRecordId}/invitation/resend", w.managerA, { path, body: { organizationId: w.orgA } });
    expect(resent.status, JSON.stringify(resent.body)).toBe(200);
    expect(resent.body).toEqual({ invitation: { sendCount: 2 } });

    const sub = identity.users.get("invitee@example.test")!.sub;
    const me = await call("GET /v1/me", sub);
    expect(me.body.memberships).toEqual([expect.objectContaining({ organizationId: w.orgA, role: "caregiver" })]);
    expect((await call("GET /v1/clients/assigned", sub, { query: { organizationId: w.orgA } })).body.clients.map((c: any) => c.clientId)).toContain(w.clientA1);
    const after = await call("GET /v1/caregivers", w.managerA, { query: { organizationId: w.orgA } });
    expect(after.body.caregivers.find((c: any) => c.caregiverRecordId === record).firstSignedInAt).not.toBeNull();
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/invitation/resend", w.managerA, { path, body: { organizationId: w.orgA } })).status).toBe(409);
    expect(JSON.stringify(logs)).not.toContain("invitee@example.test");
  });

  it("an identity-service failure changes nothing and says so", async () => {
    const failing = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence, log: () => {} });
    const created = await call("POST /v1/caregivers", w.managerA, { body: { organizationId: w.orgA, firstName: "Synthetic", lastName: "Unsent", status: "ready" } });
    const record = created.body.caregiver.caregiverRecordId as string;
    const r = await failing(event("POST /v1/caregivers/{caregiverRecordId}/invitation", { sub: w.managerA.sub, path: { caregiverRecordId: record }, body: { organizationId: w.orgA, email: "unsent@example.test" } }));
    expect(r.statusCode).toBe(503);
    const list = await call("GET /v1/caregivers", w.managerA, { query: { organizationId: w.orgA } });
    expect(list.body.caregivers.find((c: any) => c.caregiverRecordId === record)).toMatchObject({ hasSignIn: false, invitationEmail: null });
  });
});

describe("schedule (0026) through the API", () => {
  it("manager schedules, records a call-out and a replacement; the caregiver sees and calls out of their own shift", async () => {
    const recs = Object.fromEntries((await db.admin.query("select caregiver_code, id from ogevia.caregiver_records where organization_id = $1", [w.orgA])).rows.map((r) => [r.caregiver_code, r.id]));
    const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(Date.now() + 864e5));
    const body = { organizationId: w.orgA, clientId: fresh.client, serviceId: w.serviceA, date: tomorrow, startTime: "09:00", endTime: "11:00", caregiverRecordId: recs["CG-A1"] };
    expect((await call("POST /v1/shifts", w.managerA, { body: { ...body, startTime: "9am" } })).status).toBe(400);
    expect((await call("POST /v1/shifts", w.caregiverA1, { body })).status).toBe(403);
    const created = await call("POST /v1/shifts", w.managerA, { body });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.shift).toMatchObject({ reservedMinutes: 120 });
    const id = created.body.shift.shiftId as string;
    const list = await call("GET /v1/shifts", w.managerA, { query: { organizationId: w.orgA, from: tomorrow, to: tomorrow } });
    expect(list.body.shifts.find((s: any) => s.shiftId === id)).toMatchObject({ coverageState: "covered", caregiverCode: "CG-A1" });
    expect((await call("GET /v1/shifts", w.managerB, { query: { organizationId: w.orgA, from: tomorrow, to: tomorrow } })).body.shifts).toEqual([]);

    const mine = await call("GET /v1/my-shifts", w.caregiverA1, { query: { organizationId: w.orgA } });
    expect(mine.body.shifts.find((s: any) => s.shiftId === id)).toMatchObject({ canCallOut: true });
    const out = await call("POST /v1/my-shifts/{shiftId}/callout", w.caregiverA1, { path: { shiftId: id }, body: { organizationId: w.orgA, reason: "Sick (synthetic)" } });
    expect(out.body).toEqual({ coverageState: "needs_coverage" });
    expect((await call("POST /v1/my-shifts/{shiftId}/callout", w.caregiverA2, { path: { shiftId: id }, body: { organizationId: w.orgA, reason: "Not mine (synthetic)" } })).status).toBe(404);

    const repl = await call("POST /v1/shifts/{shiftId}/caregiver", w.managerA, { path: { shiftId: id }, body: { organizationId: w.orgA, caregiverRecordId: recs["CG-A3"] } });
    expect(repl.body).toEqual({ coverageState: "covered" });
    const history = await call("GET /v1/shifts/{shiftId}/coverage", w.managerA, { path: { shiftId: id }, query: { organizationId: w.orgA } });
    expect(history.body.events.map((e: any) => e.eventType)).toEqual(["called_out", "reassigned"]);
    const cancelled = await call("POST /v1/shifts/{shiftId}/cancel", w.managerA, { path: { shiftId: id }, body: { organizationId: w.orgA, reason: "Client away (synthetic)" } });
    expect(cancelled.body).toEqual({ releasedMinutes: 120 });
  });
});

describe("billing rounding (0029) through the API", () => {
  it("Administrator sets a dated policy with the payer rule; manager cannot; the adjustment is approved separately and voided with a reason", async () => {
    // Its own synthetic caregiver, so no earlier open visit is in the way.
    const sub = crypto.randomUUID();
    const cgId = (await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Synthetic Rounding Caregiver') returning id", [sub])).rows[0].id;
    await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1, $2, 'caregiver', 'active')", [w.orgA, cgId]);
    await db.admin.query("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name, status) values ($1, $2, 'CG-RND', 'Synthetic', 'Rounding', 'active')", [w.orgA, cgId]);
    const cg = { userId: cgId as string, sub };
    const svc = (await db.admin.query("insert into ogevia.services (organization_id, code, name) values ($1, 'RNA', 'Rounding API (synthetic)') returning id", [w.orgA])).rows[0].id;
    const c = (await db.admin.query("insert into ogevia.clients (organization_id) values ($1) returning id", [w.orgA])).rows[0].id;
    const today = (await db.admin.query("select ((now() at time zone 'America/Los_Angeles')::date)::text d")).rows[0].d;
    await db.admin.query("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)", [w.orgA, cg.userId, c, svc, today]);
    await db.admin.query(`insert into ogevia.client_authorizations (organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end)
      values ($1, $2, $3, 'Synthetic API Payer', 6000, $4::date - 40, $4::date + 40)`, [w.orgA, c, svc, today]);
    const body = { organizationId: w.orgA, payer: "synthetic api payer", serviceId: svc, method: "up", incrementMinutes: 15, basis: "per_visit",
      payerRuleReference: "Synthetic payer manual 3.1", payerRuleDate: "2026-01-10", effectiveFrom: "2026-01-01", reason: "Synthetic 15-minute units" };
    expect((await call("POST /v1/billing-rounding/policies", w.managerA, { body })).status).toBe(403);
    const missingRule = await call("POST /v1/billing-rounding/policies", w.ownerA, { body: { ...body, payerRuleReference: null } });
    expect(missingRule.status).toBe(422);
    expect(missingRule.body.error.message).toMatch(/Record the payer rule/);
    const set = await call("POST /v1/billing-rounding/policies", w.ownerA, { body });
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    expect(set.body.policy.version).toBe(1);
    const list = await call("GET /v1/billing-rounding/policies", w.managerA, { query: { organizationId: w.orgA } });
    expect(list.body.policies[0]).toMatchObject({ payer: "Synthetic API Payer", method: "up", incrementMinutes: 15, basis: "per_visit", inEffectToday: true });

    const { visit } = await signedVisit(db, cg, w, 50, w.orgA, c, svc);
    const approve = await call("POST /v1/visits/{visitId}/billing-approval", w.managerA, { path: { visitId: visit }, body: { approvedMinutes: 50 } });
    expect(approve.status, JSON.stringify(approve.body)).toBe(201);
    const pv = await call("GET /v1/billing-rounding/preview", w.managerA, { query: { organizationId: w.orgA, from: today, to: today } });
    expect(pv.body.units.find((u: { visitId: string }) => u.visitId === visit)).toMatchObject({ state: "ready_to_approve", workedMinutes: 50, approvedMinutes: 50, proposedMinutes: 60, adjustmentMinutes: 10, proposedUnits: "4.00" });
    const adj = await call("POST /v1/billing-rounding/adjustments", w.managerA, { body: { organizationId: w.orgA, visitId: visit } });
    expect(adj.status, JSON.stringify(adj.body)).toBe(201);
    expect(adj.body.adjustment).toMatchObject({ baseMinutes: 50, proposedMinutes: 60, adjustmentMinutes: 10, cappedByAuthorization: false });
    expect((await call("POST /v1/billing-rounding/adjustments", w.managerA, { body: { organizationId: w.orgA } })).status).toBe(400);
    const v = await call(`POST /v1/billing-rounding/adjustments/{adjustmentId}/void`, w.managerA, { path: { adjustmentId: adj.body.adjustment.adjustmentId }, body: { reason: "Synthetic void" } });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect((await call("GET /v1/billing-rounding/preview", cg, { query: { organizationId: w.orgA, from: today, to: today } })).body.units).toEqual([]);
  });
});

describe("hire type, scheduling and family relationship (0030) through the API", () => {
  it("records EOR + flexible and a non-family relationship as separate facts; caregivers refused", async () => {
    const rec = (await db.admin.query("select id from ogevia.caregiver_records where organization_id = $1 and linked_user_id = $2", [w.orgA, w.caregiverA2.userId])).rows[0].id;
    const r = await call("POST /v1/caregivers/{caregiverRecordId}/employment", w.managerA, { path: { caregiverRecordId: rec }, body: { organizationId: w.orgA, hireType: "eor", schedulingMode: "flexible" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.result).toMatchObject({ hireType: "eor", schedulingMode: "flexible" });
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/employment", w.managerA, { path: { caregiverRecordId: rec }, body: { organizationId: w.orgA, hireType: "family", schedulingMode: "flexible" } })).status).toBe(400);
    expect((await call("POST /v1/caregivers/{caregiverRecordId}/employment", w.caregiverA2, { path: { caregiverRecordId: rec }, body: { organizationId: w.orgA, hireType: "eor", schedulingMode: "fixed" } })).status).toBe(403);
    const list = await call("GET /v1/caregivers", w.managerA, { query: { organizationId: w.orgA } });
    expect(list.body.caregivers.find((c: { caregiverRecordId: string }) => c.caregiverRecordId === rec)).toMatchObject({ hireType: "eor", schedulingMode: "flexible" });
    const assignment = (await db.admin.query("select id from ogevia.caregiver_assignments where organization_id = $1 and caregiver_user_id = $2 limit 1", [w.orgA, w.caregiverA2.userId])).rows[0].id;
    const fr = await call("POST /v1/assignments/{assignmentId}/family-relationship", w.managerA, { path: { assignmentId: assignment }, body: { organizationId: w.orgA, relationship: "none" } });
    expect(fr.status, JSON.stringify(fr.body)).toBe(200);
    expect(fr.body.result).toMatchObject({ familyRelationship: "none" });
  });
});

describe("monthly approval summary (0030) through the API", () => {
  it("returns approved minutes per authorization lineage with no money fields; bad month refused", async () => {
    const month = (await db.admin.query("select to_char(date_trunc('month', now() at time zone 'America/Los_Angeles'), 'YYYY-MM-DD') m")).rows[0].m;
    const r = await call("GET /v1/reports/monthly-approval-summary", w.managerA, { query: { organizationId: w.orgA, monthStart: month } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Array.isArray(r.body.lineages)).toBe(true);
    for (const row of r.body.lineages) {
      expect(Object.keys(row).sort()).toEqual(["approvedMinutes", "approvedVisitCount", "authorizationLineageId", "roundingAdjustmentMinutes"]);
    }
    expect((await call("GET /v1/reports/monthly-approval-summary", w.managerA, { query: { organizationId: w.orgA, monthStart: "October" } })).status).toBe(400);
    const other = await call("GET /v1/reports/monthly-approval-summary", w.managerB, { query: { organizationId: w.orgA, monthStart: month } });
    expect(other.body.lineages ?? []).toEqual([]);
  });
});

describe("visit review (0031) through the API", () => {
  it("over-authorization visit: review shows reasons; decision recorded with a key; capped minutes then approvable; caregiver refused", async () => {
    // Earlier tests leave this synthetic caregiver with an open visit: void it (local test database only).
    const c = await db.admin.connect();
    try {
      await c.query("set session_replication_role = replica");
      await c.query("update ogevia.service_visits set status = 'voided', voided_at = now(), voided_by = created_by, void_reason = 'test isolation' where caregiver_user_id = $1 and status in ('draft', 'awaiting_signature')", [w.caregiverA3.userId]);
    } finally { await c.query("reset session_replication_role"); c.release(); }
    const small = await freshClient(db, w, w.caregiverA3, 30, w.orgA, { before: 40, after: 40 });
    const { visit } = await signedVisit(db, w.caregiverA3, w, 50, w.orgA, small.client, small.service);
    const r = await call("GET /v1/visits/{visitId}/review", w.managerA, { path: { visitId: visit } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.visit).toMatchObject({ visitStatus: "administrator_review", reviewReasons: ["over_authorization"], allowedDecisions: ["accept_capped_billable", "close_not_billable"], billableMinutes: 30 });
    expect((await call("GET /v1/visits/{visitId}/review", w.managerB, { path: { visitId: visit } })).status).toBe(404);
    expect((await call("POST /v1/visits/{visitId}/review-decision", w.caregiverA3, { path: { visitId: visit }, body: { decision: "close_not_billable", reason: "Synthetic" } })).status).toBe(403);
    expect((await call("POST /v1/visits/{visitId}/review-decision", w.managerA, { path: { visitId: visit }, body: { decision: "approve_everything", reason: "Synthetic" } })).status).toBe(400);
    const d = await call("POST /v1/visits/{visitId}/review-decision", w.managerA, { path: { visitId: visit }, body: { decision: "accept_capped_billable", reason: "Signed; 20 min over not billable (synthetic)" } });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    const ap = await call("POST /v1/visits/{visitId}/billing-approval", w.managerA, { path: { visitId: visit }, body: { approvedMinutes: 30 } });
    expect(ap.status, JSON.stringify(ap.body)).toBe(201);
    const rv = await call("POST /v1/visit-review-decisions/{decisionId}/revoke", w.managerA, { path: { decisionId: d.body.decisionId }, body: { reason: "Synthetic" } });
    expect(rv.status).toBe(409);
  });
});

describe("document reminder days and attention (0033) through the API", () => {
  it("manager sets agency reminder days; bad input refused; caregiver refused; attention carries the new categories", async () => {
    const ok = await call("POST /v1/document-reminder-days", w.managerA, { body: { organizationId: w.orgA, documentTypeId: null, days: [7, 30, 60] } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.days).toEqual([60, 30, 7]);
    expect((await call("POST /v1/document-reminder-days", w.managerA, { body: { organizationId: w.orgA, documentTypeId: null, days: [0] } })).status).toBe(400);
    expect((await call("POST /v1/document-reminder-days", w.caregiverA1, { body: { organizationId: w.orgA, documentTypeId: null, days: [30] } })).status).toBe(403);
    const att = await call("GET /v1/attention", w.managerA, { query: { organizationId: w.orgA } });
    expect(Object.keys(att.body.summary)).toEqual(expect.arrayContaining(["uncoveredShifts", "documentsBlocking", "documentsToReview", "documentsExpiring", "total"]));
  });
});

describe("recurring shifts (0034) through the API", () => {
  it("preview lists each date with its outcome; create returns the series; bad weekdays refused; caregiver refused", async () => {
    const small = await freshClient(db, w, w.caregiverA1, 600, w.orgA, { before: 40, after: 150 });
    const today = (await db.admin.query("select (now() at time zone 'America/Los_Angeles')::date + 3 as d")).rows[0].d as Date;
    const startsOn = today.toISOString().slice(0, 10);
    const endsOn = new Date(today.getTime() + 27 * 864e5).toISOString().slice(0, 10);
    const pv = await call("GET /v1/shift-series/preview", w.managerA, { query: { organizationId: w.orgA, clientId: small.client, serviceId: small.service, weekdays: "1,3,5", startTime: "09:00", endTime: "11:00", startsOn, endsOn } });
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body.occurrences.length).toBeGreaterThanOrEqual(11);
    expect(pv.body.occurrences[0]).toMatchObject({ minutes: 120, outcome: expect.stringMatching(/ok|exceeds_authorization/) });
    expect(typeof pv.body.occurrences[0].localDate).toBe("string");
    expect((await call("GET /v1/shift-series/preview", w.managerA, { query: { organizationId: w.orgA, clientId: small.client, serviceId: small.service, weekdays: "1,8", startTime: "09:00", endTime: "11:00", startsOn } })).status).toBe(400);
    expect((await call("POST /v1/shift-series", w.caregiverA1, { body: { organizationId: w.orgA, clientId: small.client, serviceId: small.service, weekdays: [1], startTime: "09:00", endTime: "10:00", startsOn, endsOn } })).status).toBe(403);
    const refused = await call("POST /v1/shift-series", w.managerA, { body: { organizationId: w.orgA, clientId: small.client, serviceId: small.service, weekdays: [1, 3, 5], startTime: "09:00", endTime: "11:00", startsOn, endsOn } });
    expect(refused.status).toBe(409);
    const made = await call("POST /v1/shift-series", w.managerA, { body: { organizationId: w.orgA, clientId: small.client, serviceId: small.service, weekdays: [1, 3, 5], startTime: "09:00", endTime: "11:00", startsOn, endsOn, onConflict: "skip_flagged" } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    // The range spans two months: the limit applies to each month separately.
    const perMonth = (await db.admin.query(`select date_trunc('month', r.service_date) m, sum(r.reserved_minutes)::int n from ogevia.authorization_reservations r
      join ogevia.shifts s on s.id = r.shift_id where s.series_id = $1 and r.released_at is null group by 1`, [made.body.series.seriesId])).rows;
    expect(perMonth.every((r: { n: number }) => r.n <= 600)).toBe(true);
    expect(perMonth.reduce((t: number, r: { n: number }) => t + r.n, 0)).toBe(made.body.series.reservedMinutes);
    const list = await call("GET /v1/shift-series", w.managerA, { query: { organizationId: w.orgA } });
    expect(list.body.series.find((s: { seriesId: string }) => s.seriesId === made.body.series.seriesId)).toMatchObject({ status: "active" });
  });
});

describe("missing-signature recovery (0036) through the API", () => {
  /** A new caregiver (no other open visit) whose visit ends "unable to confirm". */
  async function noSignerVisit(minutes = 45) {
    const sub = randomUUID();
    const userId = (await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Synthetic Robin Caregiver') returning id", [sub])).rows[0].id;
    await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1,$2,'caregiver','active')", [w.orgA, userId]);
    await db.admin.query("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name) values ($1,$2,$3,'Synthetic','Robin')", [w.orgA, userId, "CG-" + sub.slice(0, 6)]);
    const cg = { userId, sub };
    const c = await freshClient(db, w, cg, 600, w.orgA, { before: 40, after: 40 });
    const visit = await endedVisit(db, cg, w, minutes, w.orgA, c.client, c.service);
    await api.confirm(db, cg, visit, { method: "unable_to_confirm", reason: "Parent not home (synthetic)" });
    return { visit, cg };
  }
  const pub = async (routeKey: string, token: string, body: unknown) => {
    const r = await handler(event(routeKey, { sub: null, path: { token }, body }));
    return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, any> };
  };

  it("link: created once with a code; wrong code counted; recipient confirms by drawing; manager accepts; Administrator approves within the accepted minutes", async () => {
    const { visit, cg } = await noSignerVisit(45);
    const body = { channel: "link", recipientName: "Synthetic Parent Kim", recipientRole: "parent", identityCheck: "Called the number on file; confirmed name", expiresInDays: 7 };
    expect((await call("POST /v1/visits/{visitId}/confirmation-requests", cg, { path: { visitId: visit }, body })).status).toBe(403);
    expect((await call("POST /v1/visits/{visitId}/confirmation-requests", w.managerB, { path: { visitId: visit }, body })).status).toBe(404);
    const key = randomUUID();
    const made = await call("POST /v1/visits/{visitId}/confirmation-requests", w.managerA, { path: { visitId: visit }, body, key });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(made.body.code).toMatch(/^\d{6}$/);
    // A retry with the same key returns the same request; the link is not shown again.
    const again = await call("POST /v1/visits/{visitId}/confirmation-requests", w.managerA, { path: { visitId: visit }, body, key });
    expect(again.body).toMatchObject({ requestId: made.body.requestId, token: null, code: null, linkAlreadyShown: true });
    const token = made.body.token as string;
    const code = made.body.code as string;
    const wrongCode = code === "000000" ? "111111" : "000000";

    expect(await pub("POST /v1/public/visit-confirmations/{token}/open", token, { code: wrongCode })).toMatchObject({ status: 422, body: { error: { code: "wrong_code" } } });
    expect((await pub("POST /v1/public/visit-confirmations/{token}/open", "f".repeat(64), { code })).status).toBe(404);
    expect((await pub("POST /v1/public/visit-confirmations/{token}/open", token, { code: "12ab" })).status).toBe(400);
    const opened = await pub("POST /v1/public/visit-confirmations/{token}/open", token, { code });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body.visit).toMatchObject({ recipientName: "Synthetic Parent Kim", workedMinutes: 45, caregiverFirstName: "Synthetic", attemptsLeft: 4 });
    expect(opened.body.visit.organizationId).toBeUndefined();

    const responseKey = randomUUID();
    const respond = { code, outcome: "confirmed", method: "draw", signerName: "Synthetic Parent Kim", attested: true, signaturePng: syntheticPng().toString("base64"), responseKey };
    const r1 = await pub("POST /v1/public/visit-confirmations/{token}/respond", token, respond);
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    // A network retry with the same response key is answered the same way, and stores nothing new.
    const objectsBefore = evidence.objects.size;
    expect((await pub("POST /v1/public/visit-confirmations/{token}/respond", token, respond)).status).toBe(201);
    expect(evidence.objects.size).toBe(objectsBefore);
    expect((await pub("POST /v1/public/visit-confirmations/{token}/respond", token, { ...respond, responseKey: randomUUID() })).status).toBe(404);

    const list = await call("GET /v1/visits/{visitId}/confirmation-requests", w.managerA, { path: { visitId: visit } });
    const resp = list.body.requests[0];
    expect(resp).toMatchObject({ state: "answered", outcome: "confirmed", method: "draw", hasEvidence: true });
    expect(JSON.stringify(list.body)).not.toContain(token);
    const file = await call("GET /v1/late-confirmations/{lateConfirmationId}/evidence", w.managerA, { path: { lateConfirmationId: resp.lateConfirmationId } });
    expect(file.status).toBe(200);
    expect(file.body.contentType).toBe("image/png");
    expect((await call("GET /v1/late-confirmations/{lateConfirmationId}/evidence", w.managerB, { path: { lateConfirmationId: resp.lateConfirmationId } })).status).toBe(404);

    const rv = await call("POST /v1/late-confirmations/{lateConfirmationId}/review", w.managerA, { path: { lateConfirmationId: resp.lateConfirmationId }, body: { outcome: "accepted", reason: "Matches the schedule (synthetic)" } });
    expect(rv.status, JSON.stringify(rv.body)).toBe(200);
    expect(rv.body.review).toMatchObject({ acceptedMinutes: 45, cappedByAuthorization: false });
    expect((await call("POST /v1/visits/{visitId}/billing-approval", w.ownerA, { path: { visitId: visit }, body: { approvedMinutes: 46 } })).status).toBe(422);
    expect((await call("POST /v1/visits/{visitId}/billing-approval", w.ownerA, { path: { visitId: visit }, body: { approvedMinutes: 45 } })).status).toBe(201);
    // Neither the token nor the code appears in any log line.
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(`"${code}"`);
  });

  it("paper: authority is checked before the file is stored; the form is recorded and reviewed", async () => {
    const { visit } = await noSignerVisit(30);
    const made = await call("POST /v1/visits/{visitId}/confirmation-requests", w.managerA, { path: { visitId: visit }, body: { channel: "paper", recipientName: "Synthetic Guardian Ortiz", recipientRole: "guardian", expiresInDays: 14 } });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.token).toBeNull();
    const pdf = Buffer.from("%PDF-1.4 synthetic paper form").toString("base64");
    const today = (await db.admin.query("select ogevia.organization_local_date($1, now())::text d", [w.orgA])).rows[0].d;
    const form = { organizationId: w.orgA, signerName: "Synthetic Guardian Ortiz", signerRole: "guardian", signedOn: today, fileBase64: pdf, contentType: "application/pdf" };
    const before = evidence.objects.size;
    expect((await call("POST /v1/visit-confirmation-requests/{requestId}/paper", w.managerB, { path: { requestId: made.body.requestId }, body: { ...form, organizationId: w.orgB } })).status).toBe(404);
    expect((await call("POST /v1/visit-confirmation-requests/{requestId}/paper", w.managerA, { path: { requestId: made.body.requestId }, body: { ...form, organizationId: w.orgB } })).status).toBe(404);
    expect(evidence.objects.size).toBe(before);
    const rec = await call("POST /v1/visit-confirmation-requests/{requestId}/paper", w.managerA, { path: { requestId: made.body.requestId }, body: form });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    expect([...evidence.objects.keys()].some((k) => k === `${w.orgA}/documents/${rec.body.lateConfirmationId}/paper-form`)).toBe(true);
    const rv = await call("POST /v1/late-confirmations/{lateConfirmationId}/review", w.managerA, { path: { lateConfirmationId: rec.body.lateConfirmationId }, body: { outcome: "rejected", reason: "Signature does not match the guardian on file (synthetic)" } });
    expect(rv.status).toBe(200);
    const review = await call("GET /v1/visits/{visitId}/review", w.managerA, { path: { visitId: visit } });
    expect(review.body.visit).toMatchObject({ recoveryState: null, canRequestConfirmation: true, allowedDecisions: ["close_not_billable"] });
  });
});
