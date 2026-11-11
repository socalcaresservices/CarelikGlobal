// TENANT ISOLATION AND ROLE SWEEP through the real Lambda handler and a real (local, disposable) PostgreSQL. SYNTHETIC data only.
//
// Two organizations. Manager B is a fully privileged member of org B and NOTHING in org A. For EVERY route in ROUTE_KEYS that carries an organization or an entity id,
// manager B (1) names org A in organizationId with org A's real entity ids, and (2) names his own org B with org A's real entity ids (the confused-deputy form). Neither
// may read or change anything of org A: the answer is 403/404 (or an empty/other-agency-only 200 for a list), never org A data, never a 2xx on a mutating route, and
// org A's rows (and audit count) are identical before and after the whole sweep. A caregiver without an assignment (A2) and a scheduler then try every route a caregiver
// or scheduler is NOT meant to use (explicit allow-lists) and must get 403/404.
// A request body is built from the route's own validators, so the request passes validation and reaches the database check; a route whose probe still ends in a 400 is
// counted separately ("validation first") and listed, never silently counted as covered. Public (token) routes have no agency identity at all: reason recorded below.
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, freshClient, seedWorld, signedVisit, type Actor, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { createTestDbWithPending } from "../../../infra/aws/db/test/pending";
import { MemoryEvidenceStore } from "../src/evidence";
import { createHandler } from "../src/handler";
import { MemoryIdentityAdmin } from "../src/identity";
import { ROUTE_KEYS, ROUTES } from "../src/routes";
import { CONFIG, event, syntheticPng } from "./fixtures";

let db: TestDb;
let w: World;
let handler: ReturnType<typeof createHandler>;
let ids: Record<string, string>;
const synthetic = new Set<string>(); // id kinds for which no real org A row could be made (the id is well-formed but unknown)
const ROUTES_SRC = readFileSync(new URL("../src/routes.ts", import.meta.url), "utf8");

const q = async (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
const tryQ = async (kind: string, a: Actor, sql: string, params: unknown[] = []) => {
  try {
    const r = await q(a, sql, params);
    return r[0];
  } catch (e) {
    synthetic.add(kind);
    return undefined;
  }
};

function blocks(): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^ {2}"((?:GET|POST) \/[^"]+)": \{/gm;
  const heads: Array<{ key: string; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(ROUTES_SRC))) heads.push({ key: m[1]!, at: m.index });
  heads.forEach((h, i) => { out[h.key] = ROUTES_SRC.slice(h.at, i + 1 < heads.length ? heads[i + 1]!.at : ROUTES_SRC.indexOf("export const ROUTE_KEYS")); });
  return out;
}
const BLOCKS = blocks();

beforeAll(async () => {
  db = await createTestDbWithPending();   // includes the PENDING migration (infra/aws/db/pending) so the staff routes are swept too
  // Every PENDING migration (infra/aws/db/pending/migrations: sign-in override, client labels, bulk import, duplicate staff) is applied too, so the routes that depend on them are
  // swept against the real functions and tables, not against "function does not exist".
  const pendingDir = new URL("../../../infra/aws/db/pending/migrations/", import.meta.url);
  const adm = await db.admin.connect();
  try {
    for (const f of readdirSync(pendingDir).filter((x) => x.endsWith(".sql")).sort()) {
      await adm.query("begin"); await adm.query("set local role ogevia_owner"); await adm.query(readFileSync(new URL(f, pendingDir), "utf8")); await adm.query("reset role"); await adm.query("commit");
    }
  } finally { adm.release(); }
  w = await seedWorld(db, 600);
  const evidence = new MemoryEvidenceStore();
  handler = createHandler({ config: CONFIG, db: { connect: () => db.admin.connect() }, evidence, identity: new MemoryIdentityAdmin(), log: () => {} });
  const A = w.orgA;
  const f = await freshClient(db, w, w.caregiverA1, 6000, A, { before: 40, after: 40 });
  const rec = (await db.admin.query("select id from ogevia.caregiver_records where linked_user_id = $1 and organization_id = $2", [w.caregiverA1.userId, A])).rows[0].id as string;
  const { visit: signed } = await signedVisit(db, w.caregiverA1, w, 40, A, f.client, f.service);
  const f2 = await freshClient(db, w, w.caregiverA2, 6000, A, { before: 40, after: 40 });
  const f2ClientId = f2.client;
  const review = await api.start(db, w.caregiverA2, A, f2.client, f2.service, null, "Client asked for extra help (synthetic)");
  await ageVisit(db, review, 30);
  await api.end(db, w.caregiverA2, review);
  await api.confirm(db, w.caregiverA2, review, { method: "unable_to_confirm", reason: "Client asleep; parent not home (synthetic)" });
  const decision = (await q(w.managerA, "select ogevia_api.decide_visit_review($1,'close_not_billable','Not a valid visit (synthetic)',null) id", [review]))[0].id as string;
  // a second review visit with an open confirmation request, a third with a received (late) response
  const f3 = await freshClient(db, w, w.caregiverA3, 6000, A, { before: 40, after: 40 });
  const review2 = await api.start(db, w.caregiverA3, A, f3.client, f3.service, null, "Client asked for extra help (synthetic)");
  await ageVisit(db, review2, 30);
  await api.end(db, w.caregiverA3, review2);
  await api.confirm(db, w.caregiverA3, review2, { method: "unable_to_confirm", reason: "Client asleep; parent not home (synthetic)" });
  const tokenHash = "a".repeat(64);
  const codeHash = "b".repeat(64);
  const confirmationRequest = (await q(w.managerA, "select * from ogevia_api.create_visit_confirmation_request($1,'link','Synthetic Parent','parent','Called the number on file and confirmed the parent''s name',$2,$3,7,null)", [review2, tokenHash, codeHash]))[0];
  const tomorrow = (await db.admin.query("select to_char((now() at time zone 'America/Los_Angeles')::date + 3, 'YYYY-MM-DD') d")).rows[0].d as string;
  const shift = (await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'09:00'::time,'11:00'::time,null,$5)", [A, f.client, f.service, tomorrow, randomUUID()]))[0].shift_id as string;
  const series = (await tryQ("seriesId", w.managerA, "select * from ogevia_api.create_shift_series($1,$2,$3,null,$4::smallint[],'13:00'::time,'15:00'::time,$5::date,$6::date,'refuse',$7,null)",
    [A, f.client, f.service, [1, 3], tomorrow, (await db.admin.query("select to_char($1::date + 21, 'YYYY-MM-DD') d", [tomorrow])).rows[0].d, randomUUID()]))?.series_id as string | undefined;
  const assignment = (await db.admin.query("select id from ogevia.caregiver_assignments where organization_id = $1 and caregiver_user_id = $2 limit 1", [A, w.caregiverA1.userId])).rows[0].id as string;
  const billingApproval = (await tryQ("approvalId", w.managerA, "select ogevia_api.approve_visit_for_billing($1, 40, null, null) id", [signed]))?.id as string | undefined;
  const lateVisit = (await signedVisit(db, w.caregiverA1, w, 30, A, f.client, f.service)).visit;
  const docType = (await db.admin.query("select id from ogevia.document_types where organization_id = $1 limit 1", [A])).rows[0]?.id as string | undefined;
  if (!docType) synthetic.add("documentTypeId");
  const clientType = (await db.admin.query("select id from ogevia.client_types where organization_id = $1 limit 1", [A])).rows[0]?.id as string | undefined;
  if (!clientType) synthetic.add("clientTypeId");
  const rnd = () => randomUUID();
  ids = {
    organizationId: A, clientId: f.client, serviceId: f.service, authorizationId: f.auth, caregiverRecordId: rec, userId: w.caregiverA1.userId, caregiverUserId: w.caregiverA1.userId,
    f2ClientId, visitId: signed, reviewVisitId: review, decisionId: decision, shiftId: shift, seriesId: series ?? rnd(), assignmentId: assignment, billingApprovalId: billingApproval ?? rnd(),
    confirmationRequestId: confirmationRequest?.request_id ?? rnd(), documentTypeId: docType ?? rnd(), clientTypeId: clientType ?? rnd(), lateVisitId: lateVisit,
    // kinds with no cheap real row here: well-formed unknown ids (the 404 then proves "not found", not "other agency"); counted and listed separately
    careRequestId: rnd(), offerId: rnd(), impactId: rnd(), holdId: rnd(), versionId: rnd(), documentId: rnd(), lateConfirmationId: rnd(), adjustmentId: rnd(),
    pickupRequestId: rnd(), openShiftId: shift, availabilityRequestId: rnd(), caregiverServiceApprovalId: rnd(), excludeShiftId: shift, excludeClientId: f.client, authorizationLineageId: rnd(), correctedByUserId: w.managerA.userId,
  };
  // --- real rows for the rest, made through the product's own routes as org A people ------------------------------------------------------------------
  const make = async (actor: Actor, route: string, over: Record<string, unknown> = {}, pathOver: Record<string, string> = {}) => {
    const b: any = build(route, A);
    const r = await handler(event(route, { sub: actor.sub, path: { ...b.path, ...pathOver }, query: b.query, ...(b.body ? { body: { ...b.body, ...over } } : {}) }));
    if (process.env.SWEEP_SETUP) console.log("SETUP", route, r.statusCode, r.body.slice(0, 200));
    return { status: r.statusCode, body: JSON.parse(r.body) as any };
  };
  const madeReal = new Set<string>();
  const real = (kind: string, value: unknown) => { if (typeof value === "string" && value) { ids[kind] = value; synthetic.delete(kind); madeReal.add(kind); } else synthetic.add(kind); };
  real("availabilityRequestId", (await make(w.caregiverA1, "POST /v1/availability/requests", { kind: "weekly" })).body.requestId);
  real("authorizationLineageId", (await db.admin.query("select lineage_id from ogevia.client_authorizations where id = $1", [f.auth])).rows[0].lineage_id);
  const dt = await make(w.ownerA, "POST /v1/document-types", { name: "Synthetic Doc Type" });
  real("documentTypeId", dt.body.documentTypeId ?? dt.body.id);
  const docReq = await make(w.managerA, "POST /v1/documents/requests", { documentTypeId: ids.documentTypeId, caregiverRecordId: rec });
  real("documentId", docReq.body.documentId);
  const up = await make(w.caregiverA1, "POST /v1/documents/{documentId}/versions", {}, { documentId: ids.documentId! });
  real("versionId", up.body.version?.documentVersionId);
  const cdt = await make(w.ownerA, "POST /v1/client-document-types", { name: "Synthetic Client Doc" });
  const cdtId = cdt.body.documentTypeId ?? cdt.body.id;
  if (cdtId) {
    const cup = await make(w.managerA, "POST /v1/clients/{clientId}/documents/{documentTypeId}/versions", {}, { documentTypeId: cdtId });
    real("clientVersionId", cup.body.version?.documentVersionId);
  } else synthetic.add("clientVersionId");
  if (!ids.clientVersionId) ids.clientVersionId = randomUUID();
  const openShift = (await q(w.managerA, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,'14:00'::time,'16:00'::time,null,$5)", [A, f.client, f.service, tomorrow, randomUUID()]))[0].shift_id as string;
  ids.openShiftId = openShift;
  await make(w.caregiverA1, "POST /v1/shifts/{shiftId}/pickup", {}, { shiftId: openShift });
  const pk = await make(w.managerA, "GET /v1/shift-pickups");
  const firstId = (o: any, keys: string[]): string | undefined => { for (const v of Object.values(o ?? {})) { if (Array.isArray(v) && v[0]) { for (const k of keys) if (v[0][k]) return v[0][k]; } } return undefined; };
  real("pickupRequestId", firstId(pk.body, ["requestId", "id"]));
  const csa = await make(w.ownerA, "POST /v1/caregiver-services", { caregiverRecordId: rec, serviceId: f.service });
  real("caregiverServiceApprovalId", csa.body.approvalId ?? csa.body.id);
  // staff management (pending migration 0086): a real staff type and a real staff profile of org A
  const st = await make(w.ownerA, "POST /v1/staff-types", { name: "Synthetic Staff Type" });
  real("staffTypeId", st.body.staffType?.id);
  const sp = await make(w.ownerA, "POST /v1/staff", { displayName: "Synthetic Staff", staffTypeId: ids.staffTypeId });
  real("profileId", sp.body.staff?.id);
  const sp2 = await make(w.ownerA, "POST /v1/staff", { displayName: "Synthetic Staff Two", staffTypeId: ids.staffTypeId, contactEmail: "synthetic.two@example.test" });
  real("duplicateProfileId", sp2.body.staff?.id);
  // a care request through the client's portal link, and an offer on it
  try {
    const portal = await make(w.managerA, "POST /v1/care-portals");
    const token = portal.body.portal?.token;
    if (token) {
      const pr = await handler(event("POST /v1/public/care-portals/{token}/requests", { sub: null, path: { token }, body: { serviceId: f.service, startsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), endsAt: new Date(Date.now() + 5 * 86_400_000 + 4 * 3_600_000).toISOString(), note: "Synthetic", requestKey: randomUUID() } }));
      if (process.env.SWEEP_SETUP) console.log("SETUP public request", pr.statusCode, pr.body.slice(0, 200));
      const reqId = JSON.parse(pr.body).request?.requestId ?? JSON.parse(pr.body).requestId;
      real("careRequestId", reqId);
      if (reqId) {
        const offer = await make(w.managerA, "POST /v1/care-requests/{requestId}/offers", {}, { requestId: reqId });
        real("offerId", offer.body.offer?.offerId);
      }
    }
  } catch (e) { if (process.env.SWEEP_SETUP) console.log("SETUP care request failed", String(e)); }
  const ct = await make(w.managerA, "POST /v1/client-types");
  real("clientTypeId", ct.body.clientTypeId ?? ct.body.id);
  // a response received for a review visit (late confirmation), the way the public page records it
  const lateTok = "c".repeat(64), lateCode = "d".repeat(64);
  const f4 = await freshClient(db, w, w.caregiverA3, 6000, A, { before: 40, after: 40 });
  const review3 = await api.start(db, w.caregiverA3, A, f4.client, f4.service, null, "Client asked for extra help (synthetic)");
  await ageVisit(db, review3, 30);
  await api.end(db, w.caregiverA3, review3);
  await api.confirm(db, w.caregiverA3, review3, { method: "unable_to_confirm", reason: "Client asleep; parent not home (synthetic)" });
  try {
    const { createHash } = await import("node:crypto");
    const h = (x: string) => createHash("sha256").update(x).digest("hex");
    const th = h(lateTok), ch = h(`${th}:123456`);
    await q(w.managerA, "select * from ogevia_api.create_visit_confirmation_request($1,'link','Synthetic Parent','parent','Called the number on file and confirmed the parent''s name',$2,$3,7,null)", [review3, th, ch]);
    const c = await db.admin.connect();
    try {
      await c.query("begin"); await c.query("set local role ogevia_app");
      const res = (await c.query("select * from ogevia_api.public_respond_visit_confirmation($1,$2,$3,'confirmed','typed','Synthetic Parent',null,true,null,null,null,null,$4)", [th, ch, randomUUID(), randomUUID()])).rows[0];
      await c.query("commit");
      real("lateConfirmationId", res.late_confirmation_id);
    } catch (e) { await c.query("rollback"); synthetic.add("lateConfirmationId"); } finally { c.release(); }
  } catch { synthetic.add("lateConfirmationId"); }
  // a rounding adjustment on a signed visit (fixture row; the product path is covered by rounding.db.test.ts)
  {
    const rc = await db.admin.connect();
    try {
      await rc.query("set session_replication_role = replica");
      const lin = (await rc.query("select lineage_id from ogevia.client_authorizations where id = $1", [f.auth])).rows[0].lineage_id;
      const adj = randomUUID();
      await rc.query(`insert into ogevia.billing_rounding_adjustments (id, organization_id, unit_kind, visit_id, authorization_lineage_id, client_id, service_id, service_date, policy_id,
         covered_visit_ids, base_minutes, proposed_minutes, adjustment_minutes, capped_by_authorization, approved_by)
         select $1,$2,'visit',$3,$4,$5,$6,v.service_date,$7,array[$3::uuid],30,45,15,false,$8 from ogevia.service_visits v where v.id = $3`,
        [adj, A, lateVisit, lin, f.client, f.service, randomUUID(), w.managerA.userId]);
      ids.adjustmentId = adj; synthetic.delete("adjustmentId");
    } finally { await rc.query("reset session_replication_role"); rc.release(); }
  }
  // an amendment below what is already used records an impact for the signed visits (org A people only)
  const am = await make(w.managerA, "POST /v1/authorizations/{authorizationId}/amend", { monthlyAuthorizedMinutes: 10, periodStart: (await db.admin.query("select to_char(period_start,'YYYY-MM-DD') d from ogevia.client_authorizations where id=$1", [f.auth])).rows[0].d, periodEnd: (await db.admin.query("select to_char(period_end,'YYYY-MM-DD') d from ogevia.client_authorizations where id=$1", [f.auth])).rows[0].d });
  real("impactId", am.body.affectedVisits?.[0]?.impactId);
  real("holdId", (await make(w.managerA, "POST /v1/clients/{clientId}/service-holds")).body.holdId);
  for (const k of ["careRequestId", "offerId", "caregiverServiceApprovalId", "authorizationLineageId"]) if (!madeReal.has(k)) synthetic.add(k);
}, 120_000);
afterAll(async () => db?.drop());

// --- request building -----------------------------------------------------------------------------------------------------------------------------------
const SRCN = "(?:body|query|q\\(event\\))";
function helperSource(block: string): string {
  let extra = "";
  for (const m of ROUTES_SRC.matchAll(/^function ([A-Za-z]+)\(/gm)) {
    if (!block.includes(`${m[1]}(`)) continue;
    const start = m.index!;
    const end = ROUTES_SRC.indexOf("\n}\n", start);
    extra += ROUTES_SRC.slice(start, end + 3);
  }
  return extra;
}
function allowedList(arg: string): string[] {
  const a = arg.trim();
  const body = a.startsWith("[") ? a : (new RegExp(`const ${a.replace(/[^A-Za-z_]/g, "")}\\s*=\\s*\\[([^\\]]*)\\]`).exec(ROUTES_SRC)?.[0] ?? "");
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}
const SPECIAL_ENUM: Record<string, string[]> = { method: ["unable_to_confirm"], role: ["client"], decision: ["close_not_billable", "approve", "verified"], outcome: ["accepted"], report: ["monthly_chain"] };
const dayPlus = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const FIXED: Record<string, unknown> = {
  ruleVersion: undefined, requirementKey: "synthetic_key", issueKey: "visit:synthetic:issue",
  requestKey: "7b7d0b3e-1f0e-4f4e-9d1a-3c2a1b0c9d8e", responseKey: "1c9d0b3e-2f0e-4f4e-8d1a-3c2a1b0c9d8f",
  issuedOn: dayPlus(-30), expiresOn: dayPlus(300), monthStart: `${dayPlus(0).slice(0, 7)}-01`, signaturePng: null, attested: false,
  pattern: {}, periodStart: dayPlus(-30), periodEnd: dayPlus(30), report: "monthly_chain", timeInLocal: "09:00",
  windows: [{ weekday: 1, start_local: "09:00", end_local: "17:00" }], effectiveFrom: dayPlus(3), baseVersion: 0, expectedCount: 1, expectedAffectedShifts: 0, outageNumber: 1234, days: [7, 3],
  ids: [], confirmedTagIds: [], requirements: [], tagIds: [], userIds: [], accentColor: "#0a7c86", addressState: "CA", fileBase64: syntheticPng().toString("base64"), contentType: "image/png",
  timeIn: new Date(Date.now() - 2 * 3_600_000).toISOString(), timeOut: new Date(Date.now() - 3_600_000).toISOString(), weekdays: [1, 3], onConflict: "refuse", paperConfirmation: "verbal",
  expiresInDays: 7, startsOn: dayPlus(3), endsOn: dayPlus(24), fromDate: dayPlus(10), signerRole: "client", urgentHours: 24,
};
function valueFor(route: string, name: string, block: string, org: string): unknown {
  if (name === "organizationId") return org;
  const fam = route;
  if (name === "visitId") return /review|authorization-review|confirmation-requests|\/close|\/confirm/.test(fam) && !/billing-approval/.test(fam) ? ids.reviewVisitId : ids.visitId;
  if (name === "requestId") {
    if (/visit-confirmation-requests/.test(fam)) return ids.confirmationRequestId;
    if (/shift-pickups/.test(fam)) return ids.pickupRequestId;
    if (/availability\/requests/.test(fam)) return ids.availabilityRequestId;
    return ids.careRequestId;
  }
  if (name === "versionId") return /client-document-versions/.test(fam) ? ids.clientVersionId : ids.versionId;
  if (name === "approvalId") return /billing-approvals/.test(fam) ? ids.billingApprovalId : ids.caregiverSvcApprovalId ?? ids.caregiverServiceApprovalId;
  if (name === "decisionId") return ids.decisionId;
  if (route === "POST /v1/business-documents" && name === "id") return undefined;
  if (ids[name]) return ids[name];
  if (name === "status" && route === "GET /v1/availability/requests") return "pending";
  if (name === "kind") return route === "GET /v1/readiness/flags" ? "service" : "weekly";
  if (name === "pairs") return [{ caregiverRecordId: ids.caregiverRecordId, serviceId: ids.serviceId }];
  if (name === "userIds") return [ids.userId];
  if (name === "intervals") return [{ startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 90_000_000).toISOString() }];
  if (name === "from" || name === "dateFrom") return dayPlus(-1);
  if (name === "to" || name === "dateTo") return dayPlus(7);
  if (name === "startsAt") return new Date(Date.now() + 86_400_000).toISOString();
  if (name === "endsAt") return new Date(Date.now() + 90_000_000).toISOString();
  if (name === "startTime" || name === "timeInLocal") return "09:00";
  if (name === "endTime") return "11:00";
  if (new RegExp(`clockTime\\(${SRCN}\\.${name}\\b`).test(block)) return /end|End|Out/.test(name) ? "11:00" : "09:00";
  if (route === "GET /v1/action-issues" && ["queue", "category", "severity"].includes(name)) return undefined;
  if (route.endsWith("/reconcile") && name === "outcome") return "no_service_delivered";
  if (name === "params") return { monthStart: `${dayPlus(0).slice(0, 7)}-01`, clientId: ids.clientId, dateFrom: dayPlus(-5), dateTo: dayPlus(5) };
  if (name in FIXED) return FIXED[name];
  if (new RegExp(`booleanValue\\(body\\.${name}\\b`).test(block) || new RegExp(`${name} must be true or false`).test(block)) return true;
  if (new RegExp(`timestamp\\(${SRCN}\\.${name}\\b`).test(block)) return new Date(Date.now() + 86_400_000).toISOString();
  if (new RegExp(`(?:date|optionalDate)\\(${SRCN}\\.${name}\\b`).test(block) || /(Date|date|monthStart|month)$/.test(name)) {
    return /month/i.test(name) ? `${dayPlus(0).slice(0, 7)}-01` : dayPlus(3);
  }
  const one = new RegExp(`oneOf\\(${SRCN}\\.${name}(?: \\?\\? "[^"]*")?\\s*,\\s*"[^"]+"\\s*,\\s*([^)]+)\\)`).exec(block);
  if (one) {
    const list = allowedList(one[1]!);
    return (SPECIAL_ENUM[name] ?? []).find((x) => list.includes(x)) ?? list[0];
  }
  const t = new RegExp(`text\\(${SRCN}\\.${name}\\s*,\\s*"[^"]*"\\s*,\\s*(\\d+)`).exec(block);
  if (t) {
    if (/email/i.test(name)) return "synthetic@example.test";
    if (/phone/i.test(name)) return "5550100";
    if (/zip/i.test(name)) return "90001";
    return "Synthetic probe text".slice(0, Number(t[1]));
  }
  const whole = new RegExp(`wholeNumber\\(body\\.${name}\\s*,\\s*"[^"]*"\\s*,\\s*(\\d+)`).exec(block);
  if (whole) return Number(whole[1]) || 1;
  if (/minutes|Minutes|hours|Hours|Days|count|limit|units|number|size|version|rate|cents/.test(name)) return 60;
  return "Synthetic probe";
}
function build(route: string, org: string) {
  const block = (BLOCKS[route] ?? "") + helperSource(BLOCKS[route] ?? "");
  const path: Record<string, string> = {};
  for (const m of route.matchAll(/\{([A-Za-z]+)\}/g)) path[m[1]!] = valueFor(route, m[1]!, block, org) as string;
  const isPost = route.startsWith("POST");
  const fields = new Set<string>();
  for (const m of block.matchAll(isPost ? /\bbody\.([A-Za-z0-9]+)/g : /\b(?:q\(event\)|query)\.([A-Za-z0-9]+)/g)) fields.add(m[1]!);
  if (/orgParam\(event\)|organizationId/.test(block)) fields.add("organizationId");
  if (!isPost && /ParseMonth|monthStart/.test(block)) fields.add("monthStart");
  if (!isPost && /\bfrom\b/.test(block) && /\bto\b/.test(block)) { fields.add("from"); fields.add("to"); }
  const values: Record<string, unknown> = {};
  for (const f of fields) {
    const v = valueFor(route, f, block, org);
    // a free-text GET filter would only narrow the answer to nothing and make a refusal look like an empty list: send only validated values
    const optionalFilter = !isPost && new RegExp(`\\b(?:query|q\\(event\\))\\.${f}\\s*(?:\\?\\?|\\?)`).test(block) && !/Id$/.test(f) && !/date|Date|from|to|month/i.test(f);
    if (v !== undefined && !optionalFilter && !(!isPost && v === "Synthetic probe") && !(!isPost && v === "Synthetic probe text")) values[f] = v;
  }
  if (isPost) return { path, body: values, query: { organizationId: org } as Record<string, string> };
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) query[k] = Array.isArray(v) || (typeof v === "object" && v !== null) ? (Array.isArray(v) && v.every((x) => typeof x !== "object") ? v.join(",") : JSON.stringify(v)) : String(v);
  return { path, query };
}
const PUBLIC = ROUTE_KEYS.filter((k) => ROUTES[k]!.public);
const ORG_ID_ROUTES = ROUTE_KEYS.filter((k) => !ROUTES[k]!.public);
const hasEntityOrOrg = (route: string) => /\{[A-Za-z]+\}/.test(route) || /organizationId|orgParam\(event\)/.test(BLOCKS[route] ?? "");
const SWEEP_ROUTES = ORG_ID_ROUTES.filter(hasEntityOrOrg);
// Routes about the caller alone (no organization and no id): nothing of org A can be named.
const SELF_ONLY = ORG_ID_ROUTES.filter((k) => !hasEntityOrOrg(k));

const norm = (x: string) => x.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(?:[+-]\d{2}:\d{2}|Z)/g, "<time>");
const STRANGER_MARKERS = ["CAREGIVER_A", "MANAGER_A", "OWNER_A", "SCHEDULER_A", "org-a", "Synthetic Pat"];
/** The same request with every org A entity id replaced by a fresh random id (so "exists in another agency" cannot differ from "does not exist"). */
function neutral<T>(value: T): T {
  const known = new Set(Object.entries(ids).filter(([k]) => k !== "organizationId").map(([, v]) => v));
  const swap = (x: unknown): unknown => (typeof x === "string" && known.has(x) ? randomUUID() : Array.isArray(x) ? x.map(swap) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, swap(v)])) : x);
  return swap(value) as T;
}
async function callAs(actor: Actor, route: string, org: string, mode: "real" | "neutral" = "real", pathOver: Record<string, string> = {}) {
  let b: any = build(route, org);
  b = { ...b, path: { ...b.path, ...pathOver } };
  if (mode === "neutral") b = neutral(b);
  if (process.env.SWEEP_DEBUG && route === process.env.SWEEP_DEBUG) console.log("DEBUG", route, JSON.stringify(b).slice(0, 400));
  const opts: Parameters<typeof event>[1] = { sub: actor.sub, path: b.path, ...(b.query ? { query: b.query } : {}), ...("body" in b ? { body: b.body } : {}) };
  const r = await handler(event(route, opts));
  let body: any = {};
  try { body = JSON.parse(r.body); } catch { body = {}; }
  return { status: r.statusCode, body, raw: r.body };
}
/** The identifiers and names that would show org A data in an answer to org B. */
function orgAMarkers(): string[] {
  const v = Object.entries(ids).filter(([k]) => !synthetic.has(k)).map(([, x]) => x);
  return [...new Set(v)].filter((x) => /^[0-9a-f-]{36}$/.test(x) && x !== ids.organizationId || x === ids.organizationId);
}
/** A fingerprint of EVERY row of org A in EVERY table that carries an organization_id (not a hand-picked list). */
const snapshot = async () => {
  const tables = (await db.admin.query(
    `select c.table_name from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = 'ogevia' and c.column_name = 'organization_id' order by 1`)).rows.map((r) => r.table_name as string);
  const parts: string[] = [];
  for (const t of tables) {
    const r = await db.admin.query(`select count(*)::int n, coalesce(md5(string_agg(x::text, '|' order by x::text)), '') h from ogevia.${t} x where x.organization_id = $1`, [w.orgA]);
    parts.push(`${t}:${r.rows[0].n}:${r.rows[0].h}`);
  }
  expect(tables.length).toBeGreaterThan(60);
  return parts.join("\n");
};

type Outcome = "refused" | "empty_or_own_only" | "validation_first" | "LEAK" | "other";
const table: Array<{ route: string; variant: string; status: number; outcome: Outcome; msg: string }> = [];

describe("cross-tenant sweep: manager B against org A through every route that takes an organization or an id", () => {
  it("covers every route: routes with an organizationId/path id are swept, the rest are listed with their reason", () => {
    const all = new Set(ROUTE_KEYS);
    expect(SWEEP_ROUTES.length + PUBLIC.length + SELF_ONLY.length).toBe(all.size);
    expect(PUBLIC.every((k) => k.includes("/public/"))).toBe(true);
    // every sweep route has a parsed block to build the probe from
    for (const r of SWEEP_ROUTES) expect(BLOCKS[r], r).toBeTruthy();
  });

  it("manager B (org B only) names org A (variant 1) and his own org with org A's entity ids (variant 2): no 2xx on a mutating route, no org A data, org A unchanged", async () => {
    const before = await snapshot();
    const markers = orgAMarkers();
    const leaks: string[] = [];
    for (const route of SWEEP_ROUTES) {
      for (const [variant, org] of [["names org A", w.orgA], ["own org, org A ids", w.orgB]] as const) {
        const r = await callAs(w.managerB, route, org);
        const mutating = route.startsWith("POST");
        let outcome: Outcome;
        if (r.status === 403 || r.status === 404 || r.status === 409) outcome = "refused";
        else if (r.status === 422 && /active in this agency|not issued|not found|does not belong|not in this agency/i.test(String(r.body?.error?.message ?? ""))) outcome = "refused";
        else if (r.status === 400 || r.status === 422) outcome = "validation_first";
        else if (r.status >= 200 && r.status < 300) {
          const hit = [...markers.filter((m) => r.raw.includes(m)), ...STRANGER_MARKERS.filter((m) => r.raw.includes(m))];
          // org B's own answers legitimately exist; they must not contain any org A identifier (ids of org A rows) and a mutating 2xx is only allowed when it acted on org B alone
          outcome = hit.length > 0 || (mutating && variant === "names org A") ? "LEAK" : "empty_or_own_only";
          if (outcome === "LEAK") leaks.push(`${route} [${variant}] ${r.status} ${hit.slice(0, 2).join(",")} ${r.raw.slice(0, 160)}`);
          if (outcome === "empty_or_own_only" && !mutating) {
            if (variant === "names org A") {
              // a stranger (no membership anywhere) gets the very same answer: nothing of org A, and nothing of org B either, comes back for org A
              const stranger = await callAs(w.outsider, route, org);
              if (norm(stranger.raw) !== norm(r.raw)) leaks.push(`${route} [${variant}] differs from a stranger's answer: ${r.raw.slice(0, 120)} vs ${stranger.raw.slice(0, 120)}`);
            } else {
              // no existence oracle: an org A id answers exactly like an id that exists nowhere
              const none = await callAs(w.managerB, route, org, "neutral");
              if (none.status !== r.status || norm(none.raw) !== norm(r.raw)) leaks.push(`${route} [${variant}] answers differently for an org A id than for an unknown id: ${r.raw.slice(0, 120)} vs ${none.raw.slice(0, 120)}`);
            }
          }
        } else outcome = "other";
        table.push({ route, variant, status: r.status, outcome, msg: String(r.body?.error?.message ?? r.body?.message ?? '').slice(0, 90) });
      }
    }
    expect(table.filter((t) => t.outcome === "validation_first").map((t) => `${t.route} ${t.msg}`), "every probe must reach the database check").toEqual([]);
    expect([...synthetic], "every id kind has a real org A row").toEqual([]);
    expect(leaks, `TENANT ISOLATION FAILURES:\n${leaks.join("\n")}`).toEqual([]);
    expect(await snapshot(), "org A must be identical after the sweep").toBe(before);
    const count = (o: Outcome, variant?: string) => table.filter((t) => t.outcome === o && (!variant || t.variant === variant)).length;
    console.log("SWEEP", JSON.stringify({ routes: SWEEP_ROUTES.length, probes: table.length, refused: count("refused"), emptyOrOwnOnly: count("empty_or_own_only"), validationFirst: count("validation_first"), other: count("other"),
      public: PUBLIC.length, selfOnly: SELF_ONLY.length, syntheticIdKinds: [...synthetic] }));
    const vf = table.filter((t) => t.outcome === "validation_first").map((t) => `${t.route} [${t.variant}] ${t.status} ${t.msg}`);
    const oth = table.filter((t) => t.outcome === "other").map((t) => `${t.route} [${t.variant}] ${t.status}`);
    console.log("VALIDATION_FIRST", vf.length, "\n" + vf.join("\n"));
    console.log("OTHER", oth.length, "\n" + oth.join("\n"));
    console.log("NON_REFUSED_2XX", "\n" + table.filter((t) => t.outcome === "empty_or_own_only").map((t) => `${t.route} [${t.variant}] ${t.status} ${t.msg}`).join("\n"));
  }, 300_000);
});

describe("canary: the markers can see org A data when the caller is entitled to it (so an empty result above means something)", () => {
  it("manager A reads org A's own client, visit, shift and caregiver by id from the same routes", async () => {
    const clients = await callAs(w.managerA, "GET /v1/clients", w.orgA);
    expect(clients.raw).toContain(ids.clientId);
    const visits = await callAs(w.managerA, "GET /v1/visits", w.orgA);
    expect(visits.raw).toContain(ids.visitId);
    const shifts = await callAs(w.managerA, "GET /v1/shifts", w.orgA);
    expect(shifts.raw).toContain(ids.shiftId);
    const people = await callAs(w.managerA, "GET /v1/caregivers", w.orgA);
    expect(people.raw).toContain(ids.caregiverRecordId);
    const rev = await callAs(w.managerA, "GET /v1/visits/{visitId}/review", w.orgA);
    expect(rev.status).toBe(200);
  });
});

describe("role sweep inside org A: a caregiver, a scheduler and a manager are refused what their role does not carry", () => {
  const POSTS = SWEEP_ROUTES.filter((k) => k.startsWith("POST"));
  const GETS = SWEEP_ROUTES.filter((k) => k.startsWith("GET"));
  const ok2xx = async (actor: Actor, routes: string[]) => {
    const out: string[] = [];
    for (const route of routes) {
      const r = await callAs(actor, route, w.orgA);
      if (r.status >= 200 && r.status < 300) out.push(route);
    }
    return out;
  };

  it("caregiver A2 (assigned to one client only): the only POST routes that succeed are her own availability request, experience and notification read", async () => {
    expect((await ok2xx(w.caregiverA2, POSTS)).sort()).toEqual(["POST /v1/availability/requests", "POST /v1/experience/me", "POST /v1/notifications/read"]);
  });

  it("caregiver A2: every GET answer is the stranger's answer (nothing) except her own scoped data, and none shows another caregiver's visit, shift, record, approval, authorization, document, hold or name", async () => {
    const OWN_SCOPE = ["GET /v1/appearance", "GET /v1/attention", "GET /v1/branding", "GET /v1/clients/assigned", "GET /v1/document-types", "GET /v1/experience-tags", "GET /v1/experience/me",
      "GET /v1/notification-settings", "GET /v1/notifications", "GET /v1/work-hour-policy"];
    const o = ids;
    const forbidden: Record<string, string> = { [o.visitId!]: "A1's signed visit", [o.lateVisitId!]: "A1's second visit", [o.caregiverRecordId!]: "A1's Care Team record", [o.userId!]: "A1's user id",
      [o.assignmentId!]: "A1's assignment", [o.confirmationRequestId!]: "A3's confirmation request", [o.billingApprovalId!]: "billing approval", [o.adjustmentId!]: "rounding adjustment",
      [o.impactId!]: "amendment impact", [o.authorizationId!]: "A1's client authorization", [o.clientId!]: "A1's client", [o.shiftId!]: "A1's client shift", [o.openShiftId!]: "A1's client open shift",
      [o.holdId!]: "service hold", [o.documentId!]: "A1's staff document", [o.versionId!]: "A1's document version", [o.decisionId!]: "review decision", [o.availabilityRequestId!]: "A1's availability request",
      CAREGIVER_A1: "A1's name", CAREGIVER_A3: "A3's name" };
    const problems: string[] = [];
    for (const route of GETS) {
      const r = await callAs(w.caregiverA2, route, w.orgA);
      if (r.status < 200 || r.status >= 300) continue;
      for (const [m, what] of Object.entries(forbidden)) if (r.raw.includes(m)) problems.push(`${route} shows ${what}`);
      const st = await callAs(w.outsider, route, w.orgA);
      if (!OWN_SCOPE.includes(route) && norm(st.raw) !== norm(r.raw)) problems.push(`${route} differs from the stranger's answer: ${r.raw.slice(0, 100)}`);
    }
    expect(problems).toEqual([]);
    // her own visit is hers: she reads it where the product gives caregivers a read
    const own = await callAs(w.caregiverA2, "GET /v1/clients/assigned", w.orgA);
    expect(own.raw).toContain(ids.f2ClientId);
    expect(own.raw).not.toContain(ids.clientId!);
  });

  it("caregiver A2 cannot read or act on another caregiver's visit by id: 403/404 on the visit routes that take a visit id", async () => {
    for (const route of ["GET /v1/visits/{visitId}/review", "GET /v1/visits/{visitId}/signature", "POST /v1/visits/{visitId}/end", "POST /v1/visits/{visitId}/confirm", "POST /v1/visits/{visitId}/close",
      "POST /v1/visits/{visitId}/corrections", "POST /v1/visits/{visitId}/review-decision", "POST /v1/visits/{visitId}/billing-approval", "GET /v1/visits/{visitId}/authorization-review"]) {
      if (!ROUTE_KEYS.includes(route)) continue;
      const r = await callAs(w.caregiverA2, route, w.orgA, "real", { visitId: ids.visitId! });
      if (r.status === 200) {
        // a read that answers 200 must answer exactly as for a visit that exists nowhere (no existence oracle) and show nothing
        const none = await callAs(w.caregiverA2, route, w.orgA, "real", { visitId: randomUUID() });
        expect(norm(r.raw), route).toBe(norm(none.raw));
      } else expect([403, 404], `${route} -> ${r.status} ${r.raw.slice(0, 100)}`).toContain(r.status);
    }
  });

  it("scheduler A: only scheduling, care-request and read-evaluation POSTs succeed; no billing, visit review, correction, authorization, client, caregiver, account, branding, service, readiness or approval write does", async () => {
    const got = (await ok2xx(w.schedulerA, POSTS)).sort();
    // shifts.manage, care_requests.manage and the read-evaluations (matching, readiness): scheduling and coverage work only
    expect(got).toEqual([
      "POST /v1/authorization-impacts/{impactId}/acknowledge", "POST /v1/care-alert-staff", "POST /v1/care-portals", "POST /v1/care-portals/revoke", "POST /v1/care-requests/{requestId}/offers",
      "POST /v1/hour-limits", "POST /v1/matching/candidates", "POST /v1/notifications/read", "POST /v1/readiness/evaluate", "POST /v1/shift-pickups/{requestId}/decline",
      "POST /v1/shift-series/{seriesId}/end", "POST /v1/shifts/{shiftId}/cancel"]);
    // billing reads: the scheduler holds no billing permission, so they are the stranger's (empty) answer
    for (const route of ["GET /v1/billing-approvals", "GET /v1/billing-review", "GET /v1/billing-rounding/policies", "GET /v1/billing-rounding/preview", "GET /v1/accounts", "GET /v1/continuity/status"]) {
      const r = await callAs(w.schedulerA, route, w.orgA);
      if (r.status >= 200 && r.status < 300) expect(norm(r.raw), route).toBe(norm((await callAs(w.outsider, route, w.orgA)).raw));
    }
  });

  it("manager A: refused every owner-only write (branding, accounts, rounding policy and adjustment, readiness activation and checks, caregiver service approval, document requirements, availability review and override, compliance verification)", async () => {
    const OWNER_ONLY = ["POST /v1/branding", "POST /v1/branding/letterhead", "POST /v1/branding/logo", "POST /v1/branding/logo/clear", "POST /v1/appearance/organization", "POST /v1/accounts/{userId}/disable",
      "POST /v1/accounts/{userId}/enable", "POST /v1/billing-rounding/policies", "POST /v1/billing-rounding/adjustments", "POST /v1/readiness/activate", "POST /v1/readiness/service-checks",
      "POST /v1/caregiver-services", "POST /v1/caregiver-services/{approvalId}/revoke", "POST /v1/caregiver-services/bulk-approve", "POST /v1/document-requirements/type", "POST /v1/document-requirements/policy",
      "POST /v1/availability/overrides", "POST /v1/availability/requests/{requestId}/review", "POST /v1/caregivers/{caregiverRecordId}/background-check/verify"].filter((k) => ROUTE_KEYS.includes(k));
    const got = await ok2xx(w.managerA, OWNER_ONLY);
    expect(got, "owner-only routes the manager could use").toEqual([]);
  });
});

describe("public (token) routes: no agency identity, so the token is the only key", () => {
  it("a care-portal token of org B cannot read or cancel org A's care request; forged and malformed tokens are one uniform 404/400; the routes carry no organizationId", async () => {
    const portalB = await handler(event("POST /v1/care-portals", { sub: w.managerB.sub, body: { organizationId: w.orgB, clientId: w.clientB1 } }));
    expect(portalB.statusCode, portalB.body).toBe(201);
    const tokenB = JSON.parse(portalB.body).portal.token as string;
    const get = await handler(event("GET /v1/public/care-portals/{token}/requests/{requestId}", { sub: null, path: { token: tokenB, requestId: ids.careRequestId! } }));
    expect([403, 404]).toContain(get.statusCode);
    expect(get.body).not.toContain(ids.clientId!);
    const cancel = await handler(event("POST /v1/public/care-portals/{token}/requests/{requestId}/cancel", { sub: null, path: { token: tokenB, requestId: ids.careRequestId! }, body: {} }));
    expect([403, 404]).toContain(cancel.statusCode);
    const stillThere = (await db.admin.query("select status from ogevia.care_requests where id = $1", [ids.careRequestId])).rows[0];
    expect(stillThere.status).not.toBe("client_cancelled");
    const forged = await handler(event("GET /v1/public/care-portals/{token}", { sub: null, path: { token: "f".repeat(64) } }));
    const garbage = await handler(event("GET /v1/public/care-portals/{token}", { sub: null, path: { token: "not-a-token" } }));
    expect(forged.statusCode).toBe(404);
    expect([400, 404]).toContain(garbage.statusCode);
    const offerForged = await handler(event("GET /v1/public/care-offers/{token}", { sub: null, path: { token: "e".repeat(64) } }));
    expect(offerForged.statusCode).toBe(404);
    for (const route of PUBLIC) expect(BLOCKS[route], route).not.toMatch(/body\.organizationId|orgParam\(event\)|q\(event\)\.organizationId/);
  });
});
