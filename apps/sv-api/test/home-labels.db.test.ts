// 0120 through the real handler: labels, punches, strokes-only signing with the session, the direct-confirmation path, reports and CSV. SYNTHETIC data only; the evidence store is in memory.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ageVisit, createHelperShift, createTestDb, freshClient, seedWorld, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { createHandler } from "../src/handler";
import { MemoryEvidenceStore } from "../src/evidence";
import { MemoryIdentityAdmin } from "../src/identity";
import { CONFIG, event } from "./fixtures";

let db: TestDb, w: World, handler: ReturnType<typeof createHandler>;
const store = new MemoryEvidenceStore();
const logs: string[] = [];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

beforeAll(async () => {
  vi.stubEnv("OGEVIA_QR_ENCRYPTION_KEY", "b".repeat(64));
  db = await createTestDb({ includeLiveTest: true });
  w = await seedWorld(db, 1400);
  const c = await db.admin.connect();
  try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(new URL("../../../infra/aws/db/pending/migrations/0120_nfc_qr_visit_verification.sql", import.meta.url), "utf8")); await c.query("reset role"); await c.query("commit"); } finally { c.release(); }
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: store, identity: new MemoryIdentityAdmin(), log: (r) => logs.push(JSON.stringify(r)) });
}, 180_000);
afterAll(async () => { vi.unstubAllEnvs(); await db?.drop(); });

const call = async (route: string, options: Parameters<typeof event>[1]) => { const r = await handler(event(route, options)); return { status: r.statusCode, body: JSON.parse(r.body || "{}") as any }; };
const stroke = (cx: number, t0: number) => Array.from({ length: 40 }, (_, i) => [cx + 60 * Math.cos(i / 6), 100 + 40 * Math.sin(i / 4), t0 + i * 15]);
const STROKES = { width: 600, height: 200, strokes: [stroke(200, 0), stroke(330, 700)] };
const HOME = { latitude: 34.0522, longitude: -118.2437 };

async function setup() {
  const f = await freshClient(db, w, w.caregiverA1, 600);
  const loc = await call("POST /v1/clients/{clientId}/service-locations", { sub: w.ownerA.sub, path: { clientId: f.client }, body: { organizationId: w.orgA, kind: "home", name: "Client home", street: "100 Synthetic Way", city: "Synthetictown", zip: "90001", ...HOME } });
  expect(loc.status, JSON.stringify(loc.body)).toBe(200);
  const reg = await call("POST /v1/home-labels", { sub: w.ownerA.sub, body: { organizationId: w.orgA, count: 1 } });
  expect(reg.status).toBe(200);
  const code = reg.body.codes[0] as string;
  const asg = await call("POST /v1/home-labels/assign", { sub: w.ownerA.sub, body: { organizationId: w.orgA, labelCode: code, serviceLocationId: loc.body.locationId, confirmedAddress: true } });
  expect(asg.status, JSON.stringify(asg.body)).toBe(200);
  const link = await call("POST /v1/home-labels/{labelId}/link", { sub: w.ownerA.sub, path: { labelId: asg.body.labelId }, body: { organizationId: w.orgA } });
  expect(link.body.token).toMatch(/^[0-9a-f]{64}$/);
  await db.admin.query("update ogevia.shifts set status = 'cancelled' where caregiver_user_id = $1 and status = 'scheduled'", [w.caregiverA1.userId]);
  await createHelperShift(db, w.orgA, w.caregiverA1.userId, f.client, f.service);
  return { ...f, labelId: asg.body.labelId as string, code, token: link.body.token as string, locationId: loc.body.locationId as string };
}
const punch = (token: string, body: Record<string, unknown>, key: string | null = randomUUID(), sub = w.caregiverA1.sub) =>
  call("POST /v1/label-punch", { sub, body: { token, ...body }, ...(key === null ? { key: null } : { key }) });

describe("0120 routes", () => {
  it("label administration is permission-checked and agency-isolated; the supplier list carries sticker IDs only; the link opens only through the audited call", async () => {
    expect((await call("POST /v1/home-labels", { sub: w.caregiverA1.sub, body: { organizationId: w.orgA, count: 2 } })).status).toBe(403);
    expect((await call("POST /v1/home-labels", { sub: w.managerB.sub, body: { organizationId: w.orgA, count: 2 } })).status).toBe(403);
    expect((await call("POST /v1/home-labels", { sub: w.ownerA.sub, body: { organizationId: w.orgA, count: 0 } })).status).toBe(400);
    const reg = await call("POST /v1/home-labels", { sub: w.ownerA.sub, body: { organizationId: w.orgA, count: 3 } });
    expect(Object.keys(reg.body).sort()).toEqual(["batchId", "codes"]);
    expect(reg.body.codes).toHaveLength(3);
    const stored = (await db.admin.query("select label_code, token_hash, sealed_token from ogevia.home_labels where label_code = any($1)", [reg.body.codes])).rows;
    for (const r of stored) { expect(r.token_hash).toMatch(/^[0-9a-f]{64}$/); expect(r.sealed_token).not.toMatch(/^[0-9a-f]{64}$/); }
    const inv = await call("GET /v1/home-labels", { sub: w.ownerA.sub, query: { organizationId: w.orgA, status: "unassigned" } });
    expect(inv.body.labels.length).toBeGreaterThanOrEqual(3);
    expect((await call("GET /v1/home-labels", { sub: w.managerB.sub, query: { organizationId: w.orgA } })).status).toBe(403);
    const s = await setup();
    expect((await call("POST /v1/home-labels/assign", { sub: w.ownerA.sub, body: { organizationId: w.orgA, labelCode: "not a code", serviceLocationId: s.locationId, confirmedAddress: true } })).status).toBe(400);
    expect((await call("POST /v1/home-labels/assign", { sub: w.ownerA.sub, body: { organizationId: w.orgA, labelCode: reg.body.codes[0], serviceLocationId: s.locationId, confirmedAddress: true } })).status).toBe(409);
    expect((await call("POST /v1/home-labels/{labelId}/link", { sub: w.managerB.sub, path: { labelId: s.labelId }, body: { organizationId: w.orgA } })).status).toBe(403);
    expect((await call("POST /v1/home-labels/{labelId}/link", { sub: w.caregiverA1.sub, path: { labelId: s.labelId }, body: { organizationId: w.orgA } })).status).toBe(403);
    await db.admin.query("update ogevia.shifts set status = 'cancelled' where client_id = $1", [s.client]);
  });

  it("preview has no side effects; punches need a retry key and an intent; a retry returns the first answer; a repeated scan never becomes a checkout", async () => {
    const s = await setup();
    const before = (await db.admin.query("select count(*)::int n from ogevia.visit_punches")).rows[0].n;
    for (let i = 0; i < 2; i++) expect((await call("POST /v1/label-punch/preview", { sub: w.caregiverA1.sub, body: { token: s.token } })).body).toMatchObject({ state: "ready", action: "arrival" });
    expect((await call("POST /v1/label-punch/preview", { sub: w.caregiverA1.sub, body: { token: "zz" } })).body).toEqual({ state: "unavailable" });
    expect((await call("POST /v1/label-punch/preview", { sub: w.caregiverB1.sub, body: { token: s.token } })).body).toEqual({ state: "unavailable" });
    expect((await db.admin.query("select count(*)::int n from ogevia.visit_punches")).rows[0].n).toBe(before);
    expect((await punch(s.token, { intent: "arrival", ...HOME, accuracyM: 20 }, null)).status).toBe(400);
    expect((await punch(s.token, { intent: "wander" })).status).toBe(400);
    expect((await punch(s.token, { intent: "arrival", latitude: 34 })).status).toBe(400);
    expect((await punch("f".repeat(63), { intent: "arrival" })).status).toBe(400);
    const key = randomUUID();
    const first = await punch(s.token, { intent: "arrival", ...HOME, accuracyM: 20 }, key);
    expect(first).toMatchObject({ status: 200, body: { outcome: "saved", locationResult: "within_range" } });
    const again = await punch(s.token, { intent: "arrival", ...HOME, accuracyM: 20 }, key);
    expect(again.body).toMatchObject({ outcome: "saved", visitId: first.body.visitId, replayed: true });
    const rapid = await Promise.all([1, 2, 3].map(() => punch(s.token, { intent: "arrival", ...HOME, accuracyM: 20 })));
    for (const r of rapid) expect(r.body).toMatchObject({ outcome: "not_saved", reason: "already_clocked_in" });
    expect((await db.admin.query("select status, time_out from ogevia.service_visits where id = $1", [first.body.visitId])).rows[0]).toMatchObject({ status: "draft", time_out: null });
    await ageVisit(db, first.body.visitId, 10);
    const out = await punch(s.token, { intent: "departure", ...HOME, accuracyM: 20 });
    expect(out.body).toMatchObject({ outcome: "saved", signing: "sign_now" });
    (s as any).visit = first.body.visitId;
    await signIt(s.client, first.body.visitId);
  });

  it("signing accepts strokes only, once, for the right visit and revision; a stored image is private, checksummed and equal to what the server drew", async () => {
    const s = await setup();
    const a = await punch(s.token, { intent: "arrival", ...HOME, accuracyM: 20 });
    await ageVisit(db, a.body.visitId, 10);
    await punch(s.token, { intent: "departure", ...HOME, accuracyM: 20 });
    const visit = a.body.visitId as string;
    const sessionOf = async () => (await call("POST /v1/visits/{visitId}/signature-session", { sub: w.caregiverA1.sub, path: { visitId: visit } })).body.session;
    const sign = (sessionId: string, extra: Record<string, unknown> = {}, key = randomUUID(), sub = w.caregiverA1.sub) =>
      call("POST /v1/visits/{visitId}/sign", { sub, path: { visitId: visit }, key, body: { organizationId: w.orgA, sessionId, signerRole: "client", signerName: "Synthetic Client", attested: true, strokes: STROKES, ...extra } });
    const s1 = await sessionOf();
    expect(s1.timeOut).toBeTruthy();
    // an image, a data URL, a file, missing attestation, invalid strokes, missing name: all refused and nothing is stored
    for (const bad of [{ signaturePng: "iVBORw0KGgo=" }, { image: "data:image/png;base64,AAAA" }, { file: "x" }, { attested: false }, { strokes: { width: 600, height: 200, strokes: [[[1, 1, 0], [2, 1, 9]]] } }, { strokes: "data:image/png;base64,AAAA" }, { signerName: "" }]) {
      const r = await sign(s1.sessionId, bad as any);
      expect([400, 422], JSON.stringify(bad)).toContain(r.status);
    }
    expect(store.objects.has(`${w.orgA}/${visit}/client-signature.png`)).toBe(false);
    expect((await sign(randomUUID())).status).toBe(409);                                                    // unknown session
    expect((await sign(s1.sessionId, {}, randomUUID(), w.caregiverA2.sub)).status).toBe(409);                // someone else's call
    const s2 = await sessionOf();                                                                           // replaces s1
    expect((await sign(s1.sessionId)).status).toBe(409);
    const ok = await sign(s2.sessionId);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.result.status).toBe("signed");
    const png = store.objects.get(`${w.orgA}/${visit}/client-signature.png`)![0]!.bytes;
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    const ev = (await db.admin.query("select sha256_hex, byte_size, content_type from ogevia.visit_evidence where visit_id = $1", [visit])).rows[0];
    expect(ev).toMatchObject({ sha256_hex: createHash("sha256").update(png).digest("hex"), byte_size: png.length, content_type: "image/png" });
    const conf = (await db.admin.query("select confirmation_method, typed_signer_name, signer_role from ogevia.visit_confirmations where visit_id = $1", [visit])).rows[0];
    expect(conf).toMatchObject({ confirmation_method: "draw", typed_signer_name: "Synthetic Client", signer_role: "client" });
    expect((await sign(s2.sessionId)).status).toBe(409);                                                    // reused, with a new retry key
    expect(logs.join("\n")).not.toContain("iVBOR");                                                          // no image bytes in the logs
    expect(logs.join("\n")).not.toContain(s.token);
    await db.admin.query("update ogevia.shifts set status = 'cancelled' where client_id = $1", [s.client]);
  });

  it("an off-site checkout of a home-only visit cannot be signed on the phone, shows in the unsigned report with an owner, and a later signature clears it; reports and CSV are permission-checked and carry no GPS, image or link", async () => {
    const s = await setup();
    const a = await punch(s.token, { intent: "arrival", ...HOME, accuracyM: 20 });
    await ageVisit(db, a.body.visitId, 10);
    const d = await punch(s.token, { intent: "departure", latitude: 34.2, longitude: -118.2437, accuracyM: 12 });
    expect(d.body).toMatchObject({ outcome: "saved", signing: "direct_required", locationResult: "outside_range" });
    expect((await call("POST /v1/visits/{visitId}/signature-session", { sub: w.caregiverA1.sub, path: { visitId: a.body.visitId } })).status).toBe(409);
    const unsigned = () => call("GET /v1/verification-reports/{report}", { sub: w.managerA.sub, path: { report: "unsigned_checkouts" }, query: { organizationId: w.orgA, includeResolved: "true" } });
    const row = (await unsigned()).body.rows.find((r: any) => r.visitId === a.body.visitId);
    expect(row).toMatchObject({ state: "pending", reason: "off_site_checkout", directRequired: true });
    expect((await call("POST /v1/visits/{visitId}/signature-followup/owner", { sub: w.managerA.sub, path: { visitId: a.body.visitId }, body: { organizationId: w.orgA, ownerUserId: w.managerA.userId } })).status).toBe(200);
    expect((await call("POST /v1/visits/{visitId}/signature-followup/delivery", { sub: w.managerA.sub, path: { visitId: a.body.visitId }, body: { organizationId: w.orgA, action: "link_copied", channel: "copied", status: "ok" } })).status).toBe(200);
    expect((await call("POST /v1/visits/{visitId}/signature-followup/delivery", { sub: w.caregiverA1.sub, path: { visitId: a.body.visitId }, body: { organizationId: w.orgA, action: "link_copied", channel: "copied", status: "ok" } })).status).toBe(403);
    expect((await unsigned()).body.rows.find((r: any) => r.visitId === a.body.visitId)).toMatchObject({ ownerName: "MANAGER_A", lastDelivery: "link_copied" });
    // exceptions: location issue is open with an age and no coordinates
    const ex = await call("GET /v1/visit-exceptions", { sub: w.managerA.sub, query: { organizationId: w.orgA, status: "open", kind: "location_issue" } });
    const e = ex.body.exceptions.find((x: any) => x.visitId === a.body.visitId);
    expect(e).toMatchObject({ kind: "location_issue", status: "open" });
    expect(JSON.stringify(ex.body)).not.toMatch(/34\.2|-118\.2437|latitude|longitude/);
    expect((await call("POST /v1/visit-exceptions/{exceptionId}/resolve", { sub: w.managerA.sub, path: { exceptionId: e.exceptionId }, body: { organizationId: w.orgA, action: "resolved", note: "Client confirmed by phone" } })).status).toBe(200);
    // a late typed confirmation (as the existing public link records it) clears the open view only
    const reqId = randomUUID();
    await db.admin.query(`insert into ogevia.visit_confirmation_requests (id, organization_id, visit_id, channel, recipient_name, recipient_role, identity_check, token_hash, code_hash, visit_snapshot, expires_at, created_by)
      values ($1,$2,$3,'link','Synthetic Signer','client','Verified',$4,$5, ogevia.visit_snapshot_for_confirmation($3), now() + interval '7 days', $6)`, [reqId, w.orgA, a.body.visitId, sha(randomUUID()), sha(randomUUID()), w.managerA.userId]);
    await db.admin.query(`insert into ogevia.visit_late_confirmations (id, organization_id, visit_id, request_id, outcome, method, signer_name, signer_role, attestation_version, confirmed_visit_snapshot, response_key)
      values ($1,$2,$3,$4,'confirmed','typed','Synthetic Signer','client','attest-v1', ogevia.visit_snapshot_for_confirmation($3), $5)`, [randomUUID(), w.orgA, a.body.visitId, reqId, randomUUID()]);
    expect((await call("GET /v1/verification-reports/{report}", { sub: w.managerA.sub, path: { report: "unsigned_checkouts" }, query: { organizationId: w.orgA } })).body.rows.find((r: any) => r.visitId === a.body.visitId)).toBeUndefined();
    expect((await unsigned()).body.rows.find((r: any) => r.visitId === a.body.visitId)).toMatchObject({ state: "resolved", resolution: "signed" });
    // reports and CSV
    for (const report of ["visit_exceptions", "unsigned_checkouts", "time_signature_register", "corrections_audit", "billing_review", "label_inventory"]) {
      expect((await call("GET /v1/verification-reports/{report}", { sub: w.managerA.sub, path: { report }, query: { organizationId: w.orgA } })).status, report).toBe(200);
      expect((await call("GET /v1/verification-reports/{report}", { sub: w.caregiverA1.sub, path: { report }, query: { organizationId: w.orgA } })).status, report).toBe(403);
      expect((await call("GET /v1/verification-reports/{report}", { sub: w.managerB.sub, path: { report }, query: { organizationId: w.orgA } })).status, report).toBe(403);
    }
    expect((await call("GET /v1/verification-reports/{report}", { sub: w.managerA.sub, path: { report: "nope" }, query: { organizationId: w.orgA } })).status).toBe(400);
    const csv = await call("GET /v1/verification-reports/{report}", { sub: w.ownerA.sub, path: { report: "time_signature_register" }, query: { organizationId: w.orgA, format: "csv" } });
    expect(csv.status, JSON.stringify(csv.body)).toBe(200);
    expect(csv.body.csv.split("\r\n")[0]).toContain('"Location out"');
    expect(csv.body.csv).toContain("outside_range");
    expect(csv.body.csv).not.toMatch(/34\.2|-118\.|token|png|https?:/i);
    expect((await db.admin.query("select after_state from ogevia.audit_events where action = 'verification_report.exported'")).rows[0].after_state).toMatchObject({ report: "time_signature_register" });
    await db.admin.query("update ogevia.shifts set status = 'cancelled' where client_id = $1", [s.client]);
  });
});

async function signIt(client: string, visit: string) {
  const sess = (await call("POST /v1/visits/{visitId}/signature-session", { sub: w.caregiverA1.sub, path: { visitId: visit } })).body.session;
  const r = await call("POST /v1/visits/{visitId}/sign", { sub: w.caregiverA1.sub, path: { visitId: visit }, body: { organizationId: w.orgA, sessionId: sess.sessionId, signerRole: "client", signerName: "Synthetic Client", attested: true, strokes: STROKES } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  await db.admin.query("update ogevia.shifts set status = 'cancelled' where client_id = $1", [client]);
}
