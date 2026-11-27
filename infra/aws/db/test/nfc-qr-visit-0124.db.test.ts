// 0124 (PENDING, infra/aws/db/pending): NFC / QR home labels, punches with location results, sign now or later, signing sessions, exceptions, corrections and reports.
// SYNTHETIC data only. Each test builds its own client, location, label and shift so the tests do not depend on each other.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageVisit, api, asActor, createHelperShift, createTestDb, expectPgError, freshClient, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

const UP = new URL("../pending/migrations/0124_nfc_qr_visit_verification.sql", import.meta.url);
const DOWN = new URL("../pending/rollback/0124_nfc_qr_visit_verification.down.sql", import.meta.url);
let db: TestDb;
let w: World;

const run = async (url: URL) => {
  const c = await db.admin.connect();
  try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(url, "utf8")); await c.query("reset role"); await c.query("commit"); }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
};
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => "OGL-" + Array.from(randomBytes(8)).map((b) => ALPHABET[b % ALPHABET.length]).join("");

// Home at (34.0522, -118.2437), 150 m. "Far" is about 1.1 km north.
const HOME = { lat: 34.0522, lng: -118.2437 };
const FAR = { lat: 34.0622, lng: -118.2437 };

async function register(a: Actor = w.ownerA, org = w.orgA, n = 1) {
  const items = Array.from({ length: n }, () => { const token = randomBytes(32).toString("hex"); return { code: newCode(), token, hash: sha(token), sealed: "sealed:" + randomUUID() }; });
  await call(a, "select ogevia_api.register_home_labels($1,$2::jsonb) as b", [org, JSON.stringify(items.map(({ code, hash, sealed }) => ({ code, hash, sealed })))]);
  return items;
}
async function saveLocation(client: string, o: { lat?: number | null; lng?: number | null; kind?: string; city?: string; zip?: string } = {}, a: Actor = w.ownerA, org = w.orgA) {
  const lat = o.lat === undefined ? HOME.lat : o.lat; const lng = o.lng === undefined ? HOME.lng : o.lng;
  return (await call(a, "select ogevia_api.save_service_location($1,$2,null,$3,'Client home','100 Synthetic Way',$4,'CA',$5,$6,$7) as id", [org, client, o.kind ?? "home", o.city ?? "Synthetictown", o.zip ?? "90001", lat, lng]))[0].id as string;
}
const assign = (code: string, loc: string, confirmed = true, reassign = false, a: Actor = w.ownerA, org = w.orgA) =>
  call(a, "select ogevia_api.assign_home_label($1,$2,$3,$4,$5) as id", [org, code, loc, confirmed, reassign]).then((r) => r[0].id as string);
const punch = (a: Actor, o: { hash?: string | null; org?: string | null; intent: "arrival" | "departure"; shift?: string | null; visit?: string | null; at?: { lat: number; lng: number } | null; acc?: number | null; key?: string; confirm?: boolean }) =>
  call(a, "select ogevia_api.record_punch($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as r", [o.hash ?? null, o.org ?? null, o.intent, o.shift ?? null, o.visit ?? null, o.at === null ? null : (o.at ?? HOME).lat, o.at === null ? null : (o.at ?? HOME).lng, o.acc === undefined ? 20 : o.acc, o.key ?? randomUUID(), o.confirm ?? false]).then((r) => r[0].r as any);
const preview = (a: Actor, hash: string) => call(a, "select ogevia_api.preview_home_label($1) as r", [hash]).then((r) => r[0].r as any);

/** A client with an assignment and authorization, a home location, an ACTIVE label and a shift the caregiver can start now. */
async function scenario(o: { lat?: number | null; lng?: number | null } = {}) {
  await db.admin.query("update ogevia.shifts set status = 'cancelled' where caregiver_user_id = $1 and status = 'scheduled'", [w.caregiverA1.userId]);
  const f = await freshClient(db, w, w.caregiverA1, 600);
  const loc = await saveLocation(f.client, o);
  const [label] = await register();
  const labelId = await assign(label!.code, loc);
  await createHelperShift(db, w.orgA, w.caregiverA1.userId, f.client, f.service);
  const shift = (await db.admin.query("select id from ogevia.shifts where client_id = $1 and status = 'scheduled'", [f.client])).rows[0].id as string;
  return { ...f, loc, label: label!, labelId, shift };
}
const counts = async () => (await db.admin.query("select (select count(*) from ogevia.visit_punches)::int p, (select count(*) from ogevia.service_visits)::int v")).rows[0] as { p: number; v: number };
/** Clock in then out through labels, ready for signing or deferring. */
async function checkedOut(at = HOME, minutes = 10) {
  const s = await scenario();
  const arr = await punch(w.caregiverA1, { hash: sha(s.label.token), intent: "arrival" });
  expect(arr, JSON.stringify(arr)).toMatchObject({ outcome: "saved" });
  await ageVisit(db, arr.visitId, minutes);
  const dep = await punch(w.caregiverA1, { hash: sha(s.label.token), intent: "departure", at });
  expect(dep, JSON.stringify(dep)).toMatchObject({ outcome: "saved" });
  return { ...s, visit: arr.visitId as string, dep };
}
const sign = async (visit: string) => { const ev = await api.registerEvidence(db, w.caregiverA1, w.orgA, visit); return api.confirm(db, w.caregiverA1, visit, { evidence: ev }); };

beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true });
  w = await seedWorld(db, 1400);
  // the office filter on the reports needs offices (0110) and office assignments (0111), which production already has
  for (const f of ["0110_offices.sql", "0111_office_assignments_counties_colors.sql"]) await run(new URL(`../pending/migrations/${f}`, import.meta.url));
  await run(UP);
}, 180_000);
afterAll(async () => db?.drop());

describe("0124 locations and rules", () => {
  it("the address needs a city and a ZIP; only authorized staff manage locations; a caregiver sees the place but never the street", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 300);
    await expectPgError(saveLocation(f.client, { city: "X" }), "OGV22", /City/);
    await expectPgError(saveLocation(f.client, { zip: "9000" }), "OGV22", /ZIP/);
    await expectPgError(saveLocation(f.client, {}, w.caregiverA1), "OGA03");
    await expectPgError(saveLocation(f.client, {}, w.schedulerA), "OGA03");
    const loc = await saveLocation(f.client);
    await createHelperShift(db, w.orgA, w.caregiverA1.userId, f.client, f.service);
    const staff = await call(w.managerA, "select * from ogevia_api.list_service_locations($1,$2)", [w.orgA, f.client]);
    expect(staff[0]).toMatchObject({ location_id: loc, street: "100 Synthetic Way", city: "Synthetictown", zip: "90001", needs_attention: false });
    const cg = await call(w.caregiverA1, "select * from ogevia_api.list_service_locations($1,$2)", [w.orgA, f.client]);
    expect(cg[0]).toMatchObject({ city: "Synthetictown", zip: "90001", street: null });
    // not assigned: nothing
    await expectPgError(call(w.caregiverA2, "select * from ogevia_api.list_service_locations($1,$2)", [w.orgA, f.client]), "OGN04");
    await retire(w.caregiverA1, f.client);
  });
  it("an address that cannot be located is flagged for attention", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 300);
    await saveLocation(f.client, { lat: null, lng: null });
    const r = await call(w.managerA, "select * from ogevia_api.list_service_locations($1,$2)", [w.orgA, f.client]);
    expect(r[0]).toMatchObject({ geo_status: "not_checked", needs_attention: true });
  });
  it("in-home respite defaults to home only; a service rule and an authorized per-visit override change the expected places and the methods shown", async () => {
    const s = await scenario();
    const base = (await call(w.caregiverA1, "select * from ogevia_api.get_expected_locations($1,$2)", [w.orgA, s.shift]))[0];
    expect(base).toMatchObject({ expected_start: "home", expected_end: "home", clock_in_method: "NFC or QR", clock_out_method: "NFC or QR, then signature", start_city: "Synthetictown", end_zip: "90001", overridden: false });
    await expectPgError(call(w.managerA, "select ogevia_api.set_shift_location_override($1,$2,'community','home','Outing day')", [w.orgA, s.shift]), "OGC09", /does not allow/);
    await call(w.ownerA, "select ogevia_api.set_service_location_rule($1,$2,'home','home',true)", [w.orgA, w.serviceA]);
    await expectPgError(call(w.caregiverA1, "select ogevia_api.set_shift_location_override($1,$2,'community','home','x1x')", [w.orgA, s.shift]), "OGA03");
    await call(w.managerA, "select ogevia_api.set_shift_location_override($1,$2,'community','home','Outing day')", [w.orgA, s.shift]);
    const over = (await call(w.caregiverA1, "select * from ogevia_api.get_expected_locations($1,$2)", [w.orgA, s.shift]))[0];
    expect(over).toMatchObject({ expected_start: "community", expected_end: "home", clock_in_method: "Assigned visit screen", overridden: true });
    await call(w.ownerA, "select ogevia_api.set_service_location_rule($1,$2,'home','home',false)", [w.orgA, w.serviceA]);
    await retire(w.caregiverA1, s.client);
  });
});

/** Cancels this caregiver's still-scheduled helper shifts for a client so one test's shift never matches another test's start. */
async function retire(a: Actor, client: string) {
  await db.admin.query("update ogevia.shifts set status = 'cancelled' where client_id = $1 and status = 'scheduled'", [client]);
}

describe("0124 null-safe authorization", () => {
  it("an open shift (no caregiver) is not readable by a caregiver who is not assigned to it, and agency settings are staff-only", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 300);
    await saveLocation(f.client);
    const open = (await db.admin.query("insert into ogevia.shifts (organization_id, client_id, service_id, starts_at, ends_at) values ($1,$2,$3, now() + interval '1 day', now() + interval '1 day 2 hours') returning id", [w.orgA, f.client, f.service])).rows[0].id;
    await expectPgError(call(w.caregiverA2, "select * from ogevia_api.get_expected_locations($1,$2)", [w.orgA, open]), "OGN04");
    expect((await call(w.managerA, "select * from ogevia_api.get_expected_locations($1,$2)", [w.orgA, open]))[0]).toMatchObject({ expected_start: "home" });
    await expectPgError(call(w.caregiverA2, "select * from ogevia_api.get_verification_settings($1)", [w.orgA]), "OGN04");
    expect((await call(w.managerA, "select * from ogevia_api.get_verification_settings($1)", [w.orgA]))[0]).toMatchObject({ early_checkout_minutes: 30, accuracy_limit_m: 100 });
    // a visit with no login-linked caregiver: another caregiver may not file a correction for it
    const x = await checkedOut();
    await sign(x.visit);
    await expectPgError(call(w.caregiverA2, "select ogevia_api.request_punch_correction($1,'other','Should not be allowed',null,now() - interval '1 minute')", [x.visit]), "OGN04");
    await retire(w.caregiverA1, x.client);
    await retire(w.caregiverA1, f.client);
  });
});

describe("0124 label administration", () => {
  it("registers a batch of unassigned labels with unique IDs; assigning needs the confirmed address; one active label per location; duplicates are rejected", async () => {
    const [a, b] = await register(w.ownerA, w.orgA, 2);
    const f = await freshClient(db, w, w.caregiverA1, 300);
    const loc = await saveLocation(f.client);
    await expectPgError(assign(a!.code, loc, false), "OGV22", /Confirm the address/);
    const id = await assign(a!.code, loc);
    expect(await assign(a!.code, loc)).toBe(id);                                                 // same assignment again: nothing changes
    await expectPgError(assign(b!.code, loc), "OGC09", /already has an active label/);
    const f2 = await freshClient(db, w, w.caregiverA1, 300);
    const loc2 = await saveLocation(f2.client);
    await expectPgError(assign(a!.code, loc2), "OGC09", /already active at another location/);
    await expectPgError(assign("OGL-ZZZZZZZZ", loc2), "OGN04", /not found/);
    await expectPgError(register(w.ownerA, w.orgA, 0), "OGV22");
    await expect(db.admin.query("insert into ogevia.home_labels (organization_id, label_code, batch_id, token_hash, created_by) values ($1,$2,gen_random_uuid(),$3,$4)", [w.orgA, a!.code, sha("x"), w.ownerA.userId])).rejects.toThrow(/duplicate key/);   // a label ID can never be registered twice
    const inv = await call(w.ownerA, "select * from ogevia_api.list_home_labels($1,'active',$2)", [w.orgA, f.client]);
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ label_code: a!.code, status: "active", location_name: "Client home" });
    expect(Object.keys(inv[0])).not.toContain("street");
  });
  it("another agency cannot see, assign, replace or read the link of this agency's labels; cross-agency assignment reads as not found", async () => {
    const [l] = await register();
    // another agency's manager: the label is unknown to them, and they have no right on agency A at all
    await expectPgError(assign(l!.code, randomUUID(), true, false, w.managerB, w.orgB), "OGN04", /Label not found for your agency/);
    await expectPgError(call(w.managerB, "select ogevia_api.get_home_label_link($1,$2)", [w.orgA, randomUUID()]), "OGA03");
    const labelId = (await db.admin.query("select id from ogevia.home_labels where label_code = $1", [l!.code])).rows[0].id;
    await expectPgError(call(w.ownerA, "select ogevia_api.get_home_label_link($1,$2)", [w.orgB, labelId]), "OGA03");
  });
  it("a label registered by one agency is unknown to another agency's assign call even with its own administrator", async () => {
    // Give org B an administrator (owner role) in the fixture.
    const sub = randomUUID();
    const u = (await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1,'OWNER_B') returning id", [sub])).rows[0].id;
    await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1,$2,'organization_owner','active')", [w.orgB, u]);
    const ownerB: Actor = { userId: u, sub };
    const fb = await freshClient(db, w, w.caregiverB1, 300, w.orgB);
    const locB = await saveLocation(fb.client, {}, ownerB, w.orgB);
    const [l] = await register(w.ownerA, w.orgA);
    await expectPgError(assign(l!.code, locB, true, false, ownerB, w.orgB), "OGN04", /Label not found for your agency/);
    // ...and org A's administrator cannot point its label at org B's location
    await expectPgError(assign(l!.code, locB), "OGN04", /Service location not found/);
  });
  it("deactivating revokes the link; replacing revokes the old link and keeps both histories; reassigning moves the label with a record", async () => {
    const s = await scenario();
    expect((await preview(w.caregiverA1, sha(s.label.token))).action).toBe("arrival");
    const [n] = await register();
    await expectPgError(call(w.ownerA, "select ogevia_api.replace_home_label($1,$2,$3,'')", [w.orgA, s.labelId, n!.code]), "OGV22");
    const newId = await call(w.ownerA, "select ogevia_api.replace_home_label($1,$2,$3,'Sticker peeled off') as id", [w.orgA, s.labelId, n!.code]).then((r) => r[0].id);
    expect((await preview(w.caregiverA1, sha(s.label.token))).state).toBe("unavailable");           // old link is dead
    expect((await preview(w.caregiverA1, sha(n!.token))).action).toBe("arrival");
    const old = (await db.admin.query("select status, sealed_token, replaced_by_label_id from ogevia.home_labels where id = $1", [s.labelId])).rows[0];
    expect(old).toMatchObject({ status: "replaced", sealed_token: null, replaced_by_label_id: newId });
    await expectPgError(call(w.ownerA, "select ogevia_api.get_home_label_link($1,$2)", [w.orgA, s.labelId]), "OGN04");
    expect((await call(w.ownerA, "select ogevia_api.get_home_label_link($1,$2) as t", [w.orgA, newId]))[0].t).toMatch(/^sealed:/);
    const hist = await call(w.ownerA, "select action, reason from ogevia_api.list_home_label_history($1,$2)", [w.orgA, s.labelId]);
    expect(hist.map((h: any) => h.action)).toEqual(["registered", "assigned", "replaced", "link_revoked"]);
    // reassign
    const f2 = await freshClient(db, w, w.caregiverA1, 300);
    const loc2 = await saveLocation(f2.client);
    await expectPgError(assign(n!.code, loc2), "OGC09");
    await assign(n!.code, loc2, true, true);
    expect((await db.admin.query("select service_location_id from ogevia.home_labels where id = $1", [newId])).rows[0].service_location_id).toBe(loc2);
    await call(w.ownerA, "select ogevia_api.deactivate_home_label($1,$2,'Moved out')", [w.orgA, newId]);
    expect((await preview(w.caregiverA1, sha(n!.token))).state).toBe("unavailable");
    await expectPgError(call(w.ownerA, "select ogevia_api.deactivate_home_label($1,$2,'again')", [w.orgA, newId]), "OGC09");
    await retire(w.caregiverA1, s.client);
  });
});

describe("0124 punches", () => {
  it("opening or previewing a link has no punch side effects", async () => {
    const s = await scenario();
    const before = await counts();
    for (let i = 0; i < 3; i++) expect(await preview(w.caregiverA1, sha(s.label.token))).toMatchObject({ state: "ready", action: "arrival" });
    expect(await counts()).toEqual(before);
    await retire(w.caregiverA1, s.client);
  });
  it("one matching visit clocks in automatically with a server time and a within-range result; a retry with the same key returns the first answer and writes nothing", async () => {
    const s = await scenario();
    const key = randomUUID();
    const first = await punch(w.caregiverA1, { hash: sha(s.label.token), intent: "arrival", key });
    expect(first).toMatchObject({ outcome: "saved", intent: "arrival", locationResult: "within_range", distanceM: 0 });
    const before = await counts();
    const again = await punch(w.caregiverA1, { hash: sha(s.label.token), intent: "arrival", key });
    expect(again).toMatchObject({ outcome: "saved", visitId: first.visitId, replayed: true });
    expect(await counts()).toEqual(before);
    const v = (await db.admin.query("select status, scheduled_shift_id, time_in from ogevia.service_visits where id = $1", [first.visitId])).rows[0];
    expect(v).toMatchObject({ status: "draft", scheduled_shift_id: s.shift });
    // The preview now offers a departure, not another arrival.
    expect(await preview(w.caregiverA1, sha(s.label.token))).toMatchObject({ action: "departure" });
    await ageVisit(db, first.visitId, 10);
    await api.end(db, w.caregiverA1, first.visitId); await sign(first.visitId);
    await retire(w.caregiverA1, s.client);
  });
  it("a repeated scan, a reload or a second device with a NEW key never turns an arrival into a checkout and never duplicates the punch", async () => {
    const s = await scenario();
    const a = await punch(w.caregiverA1, { hash: sha(s.label.token), intent: "arrival" });
    const results = await Promise.all([1, 2, 3, 4].map(() => punch(w.caregiverA1, { hash: sha(s.label.token), intent: "arrival" })));
    for (const r of results) expect(r).toMatchObject({ outcome: "not_saved", reason: "already_clocked_in", visitId: a.visitId });
    const v = (await db.admin.query("select status, time_out from ogevia.service_visits where id = $1", [a.visitId])).rows[0];
    expect(v).toMatchObject({ status: "draft", time_out: null });
    expect((await db.admin.query("select count(*)::int n from ogevia.service_visits where scheduled_shift_id = $1", [s.shift])).rows[0].n).toBe(1);
    expect((await db.admin.query("select count(*)::int n from ogevia.visit_punches where visit_id = $1 and outcome = 'saved'", [a.visitId])).rows[0].n).toBe(1);
    // Concurrent departures with different keys: exactly one checkout is saved.
    await ageVisit(db, a.visitId, 10);
    const deps = await Promise.all([1, 2, 3].map(() => punch(w.caregiverA1, { hash: sha(s.label.token), intent: "departure", visit: a.visitId })));
    expect(deps.filter((d) => d.outcome === "saved")).toHaveLength(1);
    expect(deps.filter((d) => d.outcome !== "saved").every((d) => d.reason === "no_active_visit")).toBe(true);
    await sign(a.visitId);
    await retire(w.caregiverA1, s.client);
  });
  it("a distinct departure on the matching running visit saves checkout and opens signing; early checkout and a missing visit are not guessed", async () => {
    const s = await scenario();
    const noVisit = await punch(w.caregiverA1, { hash: sha(s.label.token), intent: "departure" });
    expect(noVisit).toMatchObject({ outcome: "not_saved", reason: "no_active_visit" });
    const a = await punch(w.caregiverA1, { hash: sha(s.label.token), intent: "arrival" });
    expect(await punch(w.caregiverA1, { hash: sha(s.label.token), intent: "departure" })).toMatchObject({ outcome: "not_saved", reason: "too_soon" });
    await ageVisit(db, a.visitId, 10);
    await asReplicaShiftEnd(s.shift, 100);                                                         // scheduled to end in 100 minutes: leaving now is substantially early
    const early = await punch(w.caregiverA1, { hash: sha(s.label.token), intent: "departure" });
    expect(early).toMatchObject({ outcome: "needs_confirmation", reason: "early_checkout" });
    expect((await db.admin.query("select status from ogevia.service_visits where id = $1", [a.visitId])).rows[0].status).toBe("draft");
    const ok = await punch(w.caregiverA1, { hash: sha(s.label.token), intent: "departure", confirm: true });
    expect(ok).toMatchObject({ outcome: "saved", signing: "sign_now", locationResult: "within_range" });
    expect((await db.admin.query("select status, time_out from ogevia.service_visits where id = $1", [a.visitId])).rows[0].status).toBe("awaiting_signature");
    await sign(a.visitId);
    await retire(w.caregiverA1, s.client);
  });
  it("saves the checkout and flags the exception for bad, denied or low-accuracy location; the four results stay separate", async () => {
    const out: Record<string, any> = {};
    for (const [name, at, acc] of [["unavailable", null, null], ["low_accuracy", HOME, 900], ["outside_range", FAR, 15]] as const) {
      const s = await scenario();
      const a = await punch(w.caregiverA1, { hash: sha(s.label.token), intent: "arrival" });
      await ageVisit(db, a.visitId, 10);
      const d = await punch(w.caregiverA1, { hash: sha(s.label.token), intent: "departure", at, acc });
      out[name] = d;
      expect(d.outcome).toBe("saved");                                                             // actual checkout is always saved for an identifiable running visit
      expect(d.locationResult).toBe(name);
      const ex = (await db.admin.query("select kind, detail from ogevia.visit_exceptions where visit_id = $1 and kind = 'location_issue'", [a.visitId])).rows;
      expect(ex).toHaveLength(1);
      expect(ex[0].detail.result).toBe(name);
      expect(JSON.stringify(ex[0].detail)).not.toMatch(/34\.0|118\./);                            // no coordinates in the exception
      if (name !== "outside_range") { await sign(a.visitId); } else { /* handled below */ }
      await retire(w.caregiverA1, s.client);
    }
    expect(out.outside_range.distanceM).toBeGreaterThan(1000);
    expect(out.outside_range.signing).toBe("direct_required");
    expect(out.unavailable.signing).toBe("sign_now");
  });
  it("an unexpected off-site checkout of a home-only visit routes to direct client confirmation: no signing session on the phone, visit leaves the open state, follow-up is pending", async () => {
    const s = await scenario();
    const a = await punch(w.caregiverA1, { hash: sha(s.label.token), intent: "arrival" });
    await ageVisit(db, a.visitId, 10);
    const d = await punch(w.caregiverA1, { hash: sha(s.label.token), intent: "departure", at: FAR });
    expect(d).toMatchObject({ outcome: "saved", signing: "direct_required" });
    expect((await db.admin.query("select status, time_out is not null as out from ogevia.service_visits where id = $1", [a.visitId])).rows[0]).toMatchObject({ status: "administrator_review", out: true });
    const f = (await db.admin.query("select state, direct_signing_required, reason_code from ogevia.visit_signature_followups where visit_id = $1", [a.visitId])).rows[0];
    expect(f).toMatchObject({ state: "pending", direct_signing_required: true, reason_code: "off_site_checkout" });
    await expectPgError(call(w.caregiverA1, "select * from ogevia_api.open_signature_session($1)", [a.visitId]), "OGC09");
    // the caregiver can start the next visit: nothing is left open
    const s2 = await scenario();
    expect((await punch(w.caregiverA1, { hash: sha(s2.label.token), intent: "arrival" })).outcome).toBe("saved");
    await db.admin.query("update ogevia.shifts set status='cancelled' where id = any($1)", [[s2.shift]]);
  });
});

async function asReplicaShiftEnd(shift: string, minutes: number) {
  const c = await db.admin.connect();
  try { await c.query("set session_replication_role = replica"); await c.query("update ogevia.shifts set ends_at = now() + make_interval(mins => $2) where id = $1", [shift, minutes]); } finally { await c.query("reset session_replication_role"); c.release(); }
}

describe("0124 punch edge cases", () => {
  it("wrong home, no or other assignment, outside-window arrival and cancellation are not guessed: nothing is clocked and the attempt is kept", async () => {
    const s = await scenario();
    const other = await scenario();
    // Running visit at s; scanning the label of "other" is the wrong home for a departure, and an arrival is refused because another visit is open.
    const a = await punch(w.caregiverA1, { hash: sha(s.label.token), intent: "arrival" });
    expect(await punch(w.caregiverA1, { hash: sha(other.label.token), intent: "arrival" })).toMatchObject({ outcome: "not_saved", reason: "open_visit_elsewhere" });
    expect(await punch(w.caregiverA1, { hash: sha(other.label.token), intent: "departure" })).toMatchObject({ outcome: "not_saved", reason: "wrong_home" });
    expect((await db.admin.query("select status from ogevia.service_visits where id = $1", [a.visitId])).rows[0].status).toBe("draft");
    const kinds = (await db.admin.query("select kind from ogevia.visit_exceptions where caregiver_user_id = $1 and status = 'open'", [w.caregiverA1.userId])).rows.map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(["overlap", "failed_punch"]));
    await ageVisit(db, a.visitId, 10); await api.end(db, w.caregiverA1, a.visitId); await sign(a.visitId);
    // Someone else's label / a caregiver of another agency
    expect(await punch(w.caregiverB1, { hash: sha(s.label.token), intent: "arrival" })).toMatchObject({ outcome: "not_saved", reason: "label_unavailable" });
    expect(await preview(w.caregiverB1, sha(s.label.token))).toMatchObject({ state: "unavailable" });
    // Not assigned (caregiver A2's assignment ended)
    expect(await punch(w.caregiverA2, { hash: sha(s.label.token), intent: "arrival" })).toMatchObject({ outcome: "not_saved", reason: "not_assigned" });
    // Cancelled visit
    await db.admin.query("update ogevia.shifts set status = 'cancelled' where id = $1", [other.shift]);
    expect(await punch(w.caregiverA1, { hash: sha(other.label.token), intent: "arrival" })).toMatchObject({ outcome: "not_saved", reason: "visit_cancelled" });
    // Outside the window: shift starts in 3 hours
    const late = await scenario();
    await asReplicaShiftTimes(late.shift, 180, 300);
    expect(await punch(w.caregiverA1, { hash: sha(late.label.token), intent: "arrival" })).toMatchObject({ outcome: "not_saved", reason: "no_visit_in_window" });
    const attempts = (await db.admin.query("select outcome, reason from ogevia.visit_punches where caregiver_user_id = $1 and outcome = 'not_saved'", [w.caregiverA1.userId])).rows;
    expect(attempts.map((r) => r.reason)).toEqual(expect.arrayContaining(["open_visit_elsewhere", "wrong_home", "visit_cancelled", "no_visit_in_window"]));
    for (const x of [s, other, late]) await retire(w.caregiverA1, x.client);
  });
  it("two valid visits at one home: the caregiver chooses; the choice is honoured; a revoked or replaced label is refused and recorded", async () => {
    const s = await scenario();
    // two back-to-back shifts at the same client for the same caregiver, both inside the arrival window
    await asReplicaShiftEnd(s.shift, 30);
    await db.admin.query(
      `insert into ogevia.shifts (organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, starts_at, ends_at)
       select organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id, ends_at, ends_at + interval '120 minutes' from ogevia.shifts where id = $1`, [s.shift]);
    expect(await preview(w.caregiverA1, sha(s.label.token))).toMatchObject({ action: "choose" });
    const ask = await punch(w.caregiverA1, { hash: sha(s.label.token), intent: "arrival" });
    expect(ask).toMatchObject({ outcome: "needs_choice", reason: "choose_visit" });
    expect(ask.choices).toHaveLength(2);
    expect((await db.admin.query("select count(*)::int n from ogevia.service_visits where client_id = $1", [s.client])).rows[0].n).toBe(0);
    const chosen = await punch(w.caregiverA1, { hash: sha(s.label.token), intent: "arrival", shift: s.shift });
    expect(chosen.outcome).toBe("saved");
    expect((await db.admin.query("select scheduled_shift_id from ogevia.service_visits where id = $1", [chosen.visitId])).rows[0].scheduled_shift_id).toBe(s.shift);
    await ageVisit(db, chosen.visitId, 10); await api.end(db, w.caregiverA1, chosen.visitId); await sign(chosen.visitId);
    const [n] = await register();
    await call(w.ownerA, "select ogevia_api.replace_home_label($1,$2,$3,'Replaced')", [w.orgA, s.labelId, n!.code]);
    expect(await punch(w.caregiverA1, { hash: sha(s.label.token), intent: "arrival" })).toMatchObject({ outcome: "not_saved", reason: "label_revoked" });
    expect((await db.admin.query("select count(*)::int n from ogevia.visit_punches where reason = 'label_revoked'")).rows[0].n).toBe(1);
    await retire(w.caregiverA1, s.client);
  });
  it("a moved sticker shows as a location mismatch, not as a silent success", async () => {
    const s = await scenario();
    const f2 = await freshClient(db, w, w.caregiverA1, 300);
    const awayLoc = await saveLocation(f2.client, { lat: 34.2, lng: -118.5 });
    // The sticker is physically still at HOME but registered to a location 30+ km away.
    await call(w.ownerA, "select ogevia_api.deactivate_home_label($1,$2,'Peeled')", [w.orgA, s.labelId]);
    const [m] = await register();
    await call(w.ownerA, "select ogevia_api.assign_home_label($1,$2,$3,true,false)", [w.orgA, m!.code, awayLoc]);
    await db.admin.query("update ogevia.shifts set client_id = $2, service_id = $3 where id = $1", [s.shift, f2.client, f2.service]).catch(() => null);
    await retire(w.caregiverA1, f2.client);
    await retire(w.caregiverA1, s.client);
    const r = await db.admin.query("select * from ogevia.vv_location_result($1,$2,$3,20,$4)", [w.orgA, HOME.lat, HOME.lng, awayLoc]);
    expect(r.rows[0].result).toBe("outside_range");
  });
  it("approved community places: an app clock-in at the assigned visit screen; a label cannot start a community visit", async () => {
    await call(w.ownerA, "select ogevia_api.set_service_location_rule($1,$2,'home','home',true)", [w.orgA, w.serviceA]);
    const s = await scenario();
    await call(w.managerA, "select ogevia_api.set_shift_location_override($1,$2,'community','home','Outing')", [w.orgA, s.shift]);
    await saveLocation(s.client, { kind: "community", lat: 34.1, lng: -118.3 });
    expect(await punch(w.caregiverA1, { hash: sha(s.label.token), intent: "arrival" })).toMatchObject({ outcome: "not_saved", reason: "wrong_clock_in_method" });
    const app = await punch(w.caregiverA1, { org: w.orgA, shift: s.shift, intent: "arrival", at: { lat: 34.1, lng: -118.3 } });
    expect(app).toMatchObject({ outcome: "saved", locationResult: "within_range" });
    await ageVisit(db, app.visitId, 10);
    // community->home: departure at the home label
    const dep = await punch(w.caregiverA1, { hash: sha(s.label.token), intent: "departure", at: HOME });
    expect(dep).toMatchObject({ outcome: "saved", locationResult: "within_range", signing: "sign_now" });                    // not a home-only visit: no forced direct confirmation
    await sign(app.visitId);
    await call(w.ownerA, "select ogevia_api.set_service_location_rule($1,$2,'home','home',false)", [w.orgA, w.serviceA]);
    await retire(w.caregiverA1, s.client);
  });
});

async function asReplicaShiftTimes(shift: string, fromMin: number, toMin: number) {
  const c = await db.admin.connect();
  try { await c.query("set session_replication_role = replica"); await c.query("update ogevia.shifts set starts_at = now() + make_interval(mins => $2), ends_at = now() + make_interval(mins => $3) where id = $1", [shift, fromMin, toMin]); } finally { await c.query("reset session_replication_role"); c.release(); }
}

describe("0124 signing now or later", () => {
  it("sign now: a session is bound to the visit and time revision, single-use, short-lived and replaced by a newer one", async () => {
    const x = await checkedOut();
    const open = (v = x.visit) => call(w.caregiverA1, "select * from ogevia_api.open_signature_session($1)", [v]).then((r) => r[0]);
    const s1 = await open();
    expect(new Date(s1.time_out).getTime()).toBeGreaterThan(new Date(s1.time_in).getTime());
    const check = (id: string, v = x.visit, a: Actor = w.caregiverA1) => call(a, "select ogevia_api.check_signature_session($1,$2) as r", [id, v]).then((r) => r[0].r as string | null);
    expect(await check(s1.session_id)).toBeNull();
    const s2 = await open();                                                                       // a newer session replaces the first
    expect(await check(s1.session_id)).toBe("replaced");
    await expectPgError(call(w.caregiverA1, "select ogevia_api.consume_signature_session($1,$2)", [s1.session_id, x.visit]), "OGC09", /no longer valid/);
    expect(await check(s2.session_id, randomUUID())).toBe("wrong_visit");
    expect(await check(s2.session_id, x.visit, w.caregiverA2)).toBe("unknown");                      // someone else's session
    await expectPgError(call(w.caregiverA1, "select ogevia_api.consume_signature_session($1,$2)", [s2.session_id, randomUUID()]), "OGC09");
    // consume, register evidence and confirm in ONE transaction (as the API does); the visit is signed and the session is spent
    const evId = await asActor(db, w.caregiverA1.sub, async (c) => {
      await c.query("select ogevia_api.consume_signature_session($1,$2)", [s2.session_id, x.visit]);
      const key = `${w.orgA}/${x.visit}/client-signature.png`;
      const ev = (await c.query("select ogevia_api.register_visit_evidence($1,$2,'v1','image/png',2048,$3,null) as id", [x.visit, key, "b".repeat(64)])).rows[0].id;
      await c.query("select * from ogevia_api.confirm_service_visit($1,'client','draw',$2,null,null,null,null,null)", [x.visit, ev]);
      return ev;
    });
    expect(evId).toBeTruthy();
    expect((await db.admin.query("select status from ogevia.service_visits where id = $1", [x.visit])).rows[0].status).toBe("signed");
    expect(await check(s2.session_id)).toBe("reused");
    await expectPgError(call(w.caregiverA1, "select ogevia_api.consume_signature_session($1,$2)", [s2.session_id, x.visit]), "OGC09");   // reused
    await retire(w.caregiverA1, x.client);
  });
  it("rolling back the signing transaction releases the session; an expired session and a session for changed times are rejected", async () => {
    const x = await checkedOut();
    const s = (await call(w.caregiverA1, "select * from ogevia_api.open_signature_session($1)", [x.visit]))[0];
    await expect(asActor(db, w.caregiverA1.sub, async (c) => { await c.query("select ogevia_api.consume_signature_session($1,$2)", [s.session_id, x.visit]); throw new Error("storage failed"); })).rejects.toThrow("storage failed");
    expect((await call(w.caregiverA1, "select ogevia_api.check_signature_session($1,$2) as r", [s.session_id, x.visit]))[0].r).toBeNull();
    await db.admin.query("update ogevia.visit_signature_sessions set expires_at = now() - interval '1 second', issued_at = now() - interval '11 minutes' where id = $1", [s.session_id]);
    await expectPgError(call(w.caregiverA1, "select ogevia_api.consume_signature_session($1,$2)", [s.session_id, x.visit]), "OGC09");
    expect((await call(w.caregiverA1, "select ogevia_api.check_signature_session($1,$2) as r", [s.session_id, x.visit]))[0].r).toBe("expired");
    const s2 = (await call(w.caregiverA1, "select * from ogevia_api.open_signature_session($1)", [x.visit]))[0];
    await asReplicaVisitOut(x.visit);                                                              // the time revision changed after the session opened
    await expectPgError(call(w.caregiverA1, "select ogevia_api.consume_signature_session($1,$2)", [s2.session_id, x.visit]), "OGC09");
    expect((await call(w.caregiverA1, "select ogevia_api.check_signature_session($1,$2) as r", [s2.session_id, x.visit]))[0].r).toBe("stale_revision");
    const why = (await db.admin.query("select detail->>'why' w from ogevia.visit_signature_events where visit_id = $1 and action = 'session_rejected' order by id", [x.visit])).rows.map((r) => r.w);
    expect(why).toEqual(expect.arrayContaining(["expired", "stale_revision"]));
    await sign(x.visit);
    await retire(w.caregiverA1, x.client);
  });
  it("sign later keeps the actual checkout, leaves nothing open for the caregiver and creates a pending follow-up; staff set an owner and record delivery history", async () => {
    const x = await checkedOut();
    const outBefore = (await db.admin.query("select time_out from ogevia.service_visits where id = $1", [x.visit])).rows[0].time_out;
    await expectPgError(call(w.caregiverA2, "select ogevia_api.defer_visit_signature($1,'signing_later')", [x.visit]), "OGN04");
    await expectPgError(call(w.caregiverA1, "select ogevia_api.defer_visit_signature($1,'whatever')", [x.visit]), "OGV22");
    const fid = (await call(w.caregiverA1, "select ogevia_api.defer_visit_signature($1,'client_unavailable') as id", [x.visit]))[0].id;
    expect((await call(w.caregiverA1, "select ogevia_api.defer_visit_signature($1,'client_unavailable') as id", [x.visit]))[0].id).toBe(fid);   // idempotent
    const v = (await db.admin.query("select status, time_out, billable_minutes from ogevia.service_visits where id = $1", [x.visit])).rows[0];
    expect(v).toMatchObject({ status: "administrator_review", billable_minutes: 0 });
    expect(v.time_out).toEqual(outBefore);
    await call(w.managerA, "select ogevia_api.set_signature_followup_owner($1,$2,$3)", [w.orgA, x.visit, w.managerA.userId]);
    await call(w.managerA, "select ogevia_api.log_signature_delivery($1,$2,'link_copied',null,'copied','ok')", [w.orgA, x.visit]);
    await expectPgError(call(w.caregiverA1, "select ogevia_api.log_signature_delivery($1,$2,'link_copied',null,'copied','ok')", [w.orgA, x.visit]), "OGA03");
    const rep = (await call(w.managerA, "select * from ogevia_api.list_unsigned_checkouts($1)", [w.orgA])).find((r: any) => r.visit_id === x.visit);
    expect(rep).toMatchObject({ state: "pending", reason: "client_unavailable", owner_name: "MANAGER_A", last_delivery: "link_copied", direct_required: false });
    expect(rep.last_request_at).not.toBeNull();
    // the next visit is not blocked
    const s2 = await scenario();
    expect((await punch(w.caregiverA1, { hash: sha(s2.label.token), intent: "arrival" })).outcome).toBe("saved");
    await asReplicaCancel(s2);
  });
  it("a valid late signature clears the open view and keeps the history; the visit time, status and billable minutes are not changed by it", async () => {
    const x = await checkedOut();
    await call(w.caregiverA1, "select ogevia_api.defer_visit_signature($1,'signing_later')", [x.visit]);
    const before = (await db.admin.query("select time_in, time_out, status, billable_minutes from ogevia.service_visits where id = $1", [x.visit])).rows[0];
    // A late confirmation as the existing public flow records it (typed), written through the fixture path.
    const reqId = randomUUID();
    await db.admin.query(
      `insert into ogevia.visit_confirmation_requests (id, organization_id, visit_id, channel, recipient_name, recipient_role, identity_check, token_hash, code_hash, visit_snapshot, expires_at, created_by)
       values ($1,$2,$3,'link','Synthetic Signer','client','Verified by phone',$4,$5, ogevia.visit_snapshot_for_confirmation($3), now() + interval '7 days', $6)`,
      [reqId, w.orgA, x.visit, sha(randomUUID()), sha(randomUUID()), w.managerA.userId]);
    await db.admin.query(
      `insert into ogevia.visit_late_confirmations (id, organization_id, visit_id, request_id, outcome, method, signer_name, signer_role, attestation_version, confirmed_visit_snapshot, response_key)
       values ($1,$2,$3,$4,'confirmed','typed','Synthetic Signer','client','attest-v1', ogevia.visit_snapshot_for_confirmation($3), $5)`, [randomUUID(), w.orgA, x.visit, reqId, randomUUID()]);
    const open = await call(w.managerA, "select * from ogevia_api.list_unsigned_checkouts($1)", [w.orgA]);
    expect(open.find((r: any) => r.visit_id === x.visit)).toBeUndefined();
    const hist = (await call(w.managerA, "select * from ogevia_api.list_unsigned_checkouts($1,null,null,null,null,null,true)", [w.orgA])).find((r: any) => r.visit_id === x.visit);
    expect(hist).toMatchObject({ state: "resolved", resolution: "signed" });
    const after = (await db.admin.query("select time_in, time_out, status, billable_minutes from ogevia.service_visits where id = $1", [x.visit])).rows[0];
    expect(after).toEqual(before);
    const reg = (await call(w.managerA, "select * from ogevia_api.list_time_signature_register($1)", [w.orgA])).find((r: any) => r.visit_id === x.visit);
    expect(reg, JSON.stringify(reg)).toMatchObject({ signature_status: "signed", signature_method: "typed", punch_in_method: "NFC or QR", punch_out_method: "NFC or QR", location_in: "within_range", location_out: "within_range" });
    expect(Object.keys(reg).join()).not.toMatch(/lat|lng|gps|token|image|object_key/i);
    await retire(w.caregiverA1, x.client);
  });
});

async function asReplicaVisitOut(visit: string) {
  const c = await db.admin.connect();
  try { await c.query("set session_replication_role = replica"); await c.query("update ogevia.service_visits set time_out = time_out + interval '1 minute', worked_minutes = worked_minutes + 1 where id = $1", [visit]); } finally { await c.query("reset session_replication_role"); c.release(); }
}
async function asReplicaCancel(s: { shift: string; client: string }) {
  await db.admin.query("update ogevia.shifts set status = 'cancelled' where client_id = $1", [s.client]);
  const v = (await db.admin.query("select id from ogevia.service_visits where client_id = $1 and status = 'draft'", [s.client])).rows[0]?.id;
  if (v) { await ageVisit(db, v, 10); await api.end(db, w.caregiverA1, v); await sign(v); }
}

describe("0124 corrections, exceptions and reports", () => {
  it("a missed clock-out is corrected through a request and a different approver; a material change to a signed visit reopens Signature pending and keeps the original revision", async () => {
    const x = await checkedOut(HOME, 60);
    await sign(x.visit);
    const t0 = (await db.admin.query("select time_in, time_out from ogevia.service_visits where id = $1", [x.visit])).rows[0];
    const newOut = new Date(new Date(t0.time_out).getTime() - 20 * 60_000 + 0).toISOString();     // 20 minutes earlier than recorded
    await expect(call(w.caregiverA1, "select ogevia_api.request_punch_correction($1,'lost_tag','x',null,$2)", [x.visit, newOut])).rejects.toThrow(/check constraint/);   // a reason note of at least 3 characters
    const req = (await call(w.caregiverA1, "select ogevia_api.request_punch_correction($1,'lost_tag','The sticker was missing so the checkout was entered late',null,$2) as id", [x.visit, newOut]))[0].id;
    expect((await call(w.managerA, "select * from ogevia_api.list_visit_exceptions($1,'open','correction_request')", [w.orgA])).some((e: any) => e.visit_id === x.visit)).toBe(true);
    await expectPgError(call(w.caregiverA1, "select ogevia_api.decide_punch_correction($1,$2,true,'ok fine')", [w.orgA, req]), "OGA03");
    const newVisit = (await call(w.managerA, "select ogevia_api.decide_punch_correction($1,$2,true,'Verified with the caregiver','accepted') as id", [w.orgA, req]))[0].id;
    expect(newVisit).not.toBe(x.visit);
    expect((await db.admin.query("select status from ogevia.service_visits where id = $1", [x.visit])).rows[0].status).toBe("corrected");   // original kept, never overwritten
    const f = (await db.admin.query("select state, reason_code from ogevia.visit_signature_followups where visit_id = $1", [newVisit])).rows[0];
    expect(f).toMatchObject({ state: "pending", reason_code: "times_corrected" });
    const ev = (await db.admin.query("select detail from ogevia.visit_signature_events where visit_id = $1 and action = 'reopened'", [newVisit])).rows[0];
    expect(ev.detail.original_visit_id).toBe(x.visit);
    expect(ev.detail.original_revision).toMatch(/^[0-9a-f]{64}$/);
    expect((await db.admin.query("select count(*)::int n from ogevia.visit_confirmations where visit_id = $1 and confirmation_method = 'draw'", [x.visit])).rows[0].n).toBe(1);   // original signature kept
    const rep = (await call(w.managerA, "select * from ogevia_api.list_unsigned_checkouts($1)", [w.orgA])).find((r: any) => r.visit_id === newVisit);
    expect(rep).toMatchObject({ state: "pending", reason: "times_corrected" });
    const audit = (await call(w.managerA, "select * from ogevia_api.list_corrections_audit($1)", [w.orgA]));
    expect(audit.filter((a: any) => a.kind === "punch_correction" && a.needs_resigning === true && a.location_decision === "accepted")).toHaveLength(1);
    expect(audit.some((a: any) => a.kind === "time_correction")).toBe(true);
    expect(audit.some((a: any) => a.kind === "label_change")).toBe(true);
    await expectPgError(call(w.managerA, "select ogevia_api.decide_punch_correction($1,$2,true,'again please')", [w.orgA, req]), "OGC09");
    await retire(w.caregiverA1, x.client);
  });
  it("every report can be limited to one office (the client's primary office)", async () => {
    const x = await checkedOut();
    await call(w.caregiverA1, "select ogevia_api.defer_visit_signature($1,'signing_later')", [x.visit]);
    const east = (await call(w.ownerA, "select ogevia_api.create_office($1,'East Office',null) as id", [w.orgA]))[0].id;
    const west = (await call(w.ownerA, "select ogevia_api.create_office($1,'West Office',null) as id", [w.orgA]))[0].id;
    await call(w.managerA, "select ogevia_api.set_client_office($1,$2,$3)", [w.orgA, x.client, east]);
    const has = (rows: any[]) => rows.some((r) => r.visit_id === x.visit);
    expect(has(await call(w.managerA, "select * from ogevia_api.list_unsigned_checkouts($1,null,null,null,null,null,false,$2)", [w.orgA, east]))).toBe(true);
    expect(has(await call(w.managerA, "select * from ogevia_api.list_unsigned_checkouts($1,null,null,null,null,null,false,$2)", [w.orgA, west]))).toBe(false);
    expect(has(await call(w.managerA, "select * from ogevia_api.list_time_signature_register($1,null,null,null,null,null,null,$2)", [w.orgA, east]))).toBe(true);
    expect(has(await call(w.managerA, "select * from ogevia_api.list_time_signature_register($1,null,null,null,null,null,null,$2)", [w.orgA, west]))).toBe(false);
    expect(has(await call(w.ownerA, "select * from ogevia_api.list_punch_billing_review($1,null,null,null,null,null,$2)", [w.orgA, east]))).toBe(true);
    expect(has(await call(w.ownerA, "select * from ogevia_api.list_punch_billing_review($1,null,null,null,null,null,$2)", [w.orgA, west]))).toBe(false);
    const ex = await call(w.managerA, "select * from ogevia_api.list_visit_exceptions($1,null,null,null,null,null,null,null,$2)", [w.orgA, west]);
    expect(ex.some((e: any) => e.visit_id === x.visit)).toBe(false);
    await retire(w.caregiverA1, x.client);
  });
  it("overdue open visits and shifts with no punch are flagged without touching the actual or scheduled times; exceptions are reviewed with a history", async () => {
    const s = await scenario();
    const a = await punch(w.caregiverA1, { hash: sha(s.label.token), intent: "arrival" });
    await ageVisit(db, a.visitId, 200);
    await asReplicaShiftTimes(s.shift, -200, -60);                                                 // the scheduled end passed an hour ago; the visit is still open
    const before = (await db.admin.query("select time_in, time_out from ogevia.service_visits where id = $1", [a.visitId])).rows[0];
    await expectPgError(call(w.caregiverA1, "select ogevia_api.flag_overdue_visits($1)", [w.orgA]), "OGA03");
    const list = await call(w.managerA, "select * from ogevia_api.list_visit_exceptions($1,'open','overdue_clock_out')", [w.orgA]);
    const ex = list.find((e: any) => e.visit_id === a.visitId);
    expect(ex).toBeDefined();
    expect(ex.actual_time_out).toBeNull();
    expect(ex.scheduled_end).not.toBeNull();
    expect((await db.admin.query("select time_in, time_out from ogevia.service_visits where id = $1", [a.visitId])).rows[0]).toEqual(before);
    expect(await call(w.managerA, "select ogevia_api.flag_overdue_visits($1) as n", [w.orgA]).then((r) => r[0].n)).toBe(0);   // already flagged: no duplicate
    await call(w.managerA, "select ogevia_api.resolve_visit_exception($1,$2,'reviewing','Calling the caregiver')", [w.orgA, ex.exception_id]);
    await expectPgError(call(w.managerA, "select ogevia_api.resolve_visit_exception($1,$2,'resolved','')", [w.orgA, ex.exception_id]), "OGV22");
    await call(w.managerA, "select ogevia_api.resolve_visit_exception($1,$2,'resolved','Caregiver ended the visit by phone; time corrected')", [w.orgA, ex.exception_id]);
    await expectPgError(call(w.managerA, "select ogevia_api.resolve_visit_exception($1,$2,'resolved','again again')", [w.orgA, ex.exception_id]), "OGC09");
    const h = await call(w.managerA, "select action from ogevia_api.list_visit_exception_history($1,$2)", [w.orgA, ex.exception_id]);
    expect(h.map((r: any) => r.action)).toEqual(["opened", "reviewing", "resolved"]);
    await api.end(db, w.caregiverA1, a.visitId); await sign(a.visitId);
    await retire(w.caregiverA1, s.client);
    // A scheduled visit that never started is a missing punch
    const m = await scenario();
    await asReplicaShiftTimes(m.shift, -180, -60);
    await call(w.managerA, "select ogevia_api.flag_overdue_visits($1)", [w.orgA]);
    expect((await db.admin.query("select count(*)::int n from ogevia.visit_exceptions where kind = 'missing_punch' and shift_id = $1", [m.shift])).rows[0].n).toBe(1);
    await retire(w.caregiverA1, m.client);
  });
  it("exception, signature and billing reports are agency-isolated and permission-checked; billing holds are configured, not assumed", async () => {
    await expectPgError(call(w.managerB, "select * from ogevia_api.list_visit_exceptions($1)", [w.orgA]), "OGA03");
    await expectPgError(call(w.managerB, "select * from ogevia_api.list_unsigned_checkouts($1)", [w.orgA]), "OGA03");
    await expectPgError(call(w.caregiverA1, "select * from ogevia_api.list_corrections_audit($1)", [w.orgA]), "OGA03");
    await expectPgError(call(w.caregiverA1, "select * from ogevia_api.list_home_labels($1)", [w.orgA]), "OGA03");
    const x = await checkedOut();
    await call(w.caregiverA1, "select ogevia_api.defer_visit_signature($1,'signing_later')", [x.visit]);
    await db.admin.query("select 1");
    const row = () => call(w.ownerA, "select * from ogevia_api.list_punch_billing_review($1)", [w.orgA]).then((r) => r.find((q: any) => q.visit_id === x.visit));
    expect(await row()).toMatchObject({ signature_status: "pending", billing_hold: false, recorded_minutes: expect.any(Number) });
    await expectPgError(call(w.managerA, "select ogevia_api.save_verification_settings($1,30,30,5,600,100,true,false)", [w.orgA]), "OGA03");
    await call(w.ownerA, "select ogevia_api.save_verification_settings($1,30,30,5,600,100,true,false)", [w.orgA]);
    expect(await row()).toMatchObject({ billing_hold: true, hold_reasons: ["signature_pending"] });
    const base = await row();
    expect(base.recorded_minutes).toBe(10);                                                        // recorded time is preserved, not changed by the hold
    await call(w.ownerA, "select ogevia_api.save_verification_settings($1,30,30,5,600,100,false,false)", [w.orgA]);
    expect(await row()).toMatchObject({ billing_hold: false });
    await retire(w.caregiverA1, x.client);
  });
});

describe("0124 grants and row security", () => {
  it("every 0124 table has row security on and no privilege for the application role; no 0124 function is executable by PUBLIC; the application role may call only the 34 API functions", async () => {
    const tables = (await db.admin.query(
      `select c.relname, c.relrowsecurity, has_table_privilege('ogevia_app', c.oid, 'select,insert,update,delete') as app_any
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'ogevia' and c.relkind = 'r' and c.relname in ('visit_verification_settings','client_service_locations','service_location_rules','shift_location_overrides','home_labels','home_label_events',
              'visit_punches','visit_exceptions','visit_exception_events','visit_signature_followups','visit_signature_events','visit_signature_sessions','punch_correction_requests')`)).rows;
    expect(tables).toHaveLength(13);
    for (const t of tables) { expect(t.relrowsecurity, t.relname).toBe(true); expect(t.app_any, t.relname).toBe(false); }
    const fns = (await db.admin.query(
      `select n.nspname, p.proname, p.prosecdef, p.proconfig, has_function_privilege('public', p.oid, 'execute') as public_exec, has_function_privilege('ogevia_app', p.oid, 'execute') as app_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.oid in (select objid from pg_depend where deptype = 'n' and false) or p.proname ~ '^(vv_|save_service_location|list_service_locations|set_service_location_rule|set_shift_location_override|get_expected_locations|save_verification_settings|get_verification_settings|register_home_labels|assign_home_label|deactivate_home_label|replace_home_label|get_home_label_link|list_home_labels|list_home_label_history|resolve_home_label_code|preview_home_label|record_punch|open_signature_session|check_signature_session|consume_signature_session|defer_visit_signature|set_signature_followup_owner|log_signature_delivery|flag_overdue_visits|list_visit_exceptions|resolve_visit_exception|list_visit_exception_history|request_punch_correction|decide_punch_correction|list_unsigned_checkouts|list_time_signature_register|list_corrections_audit|list_punch_billing_review|authorize_verification_export)'`)).rows
      .filter((f) => (f.nspname === "ogevia" && f.proname.startsWith("vv_")) || f.nspname === "ogevia_api");
    expect(fns.filter((f) => f.nspname === "ogevia_api")).toHaveLength(34);
    for (const f of fns) {
      expect(f.public_exec, `${f.nspname}.${f.proname}`).toBe(false);
      expect(String(f.proconfig), `${f.nspname}.${f.proname} pins search_path`).toMatch(/search_path=ogevia, pg_temp/);
      expect(f.app_exec, `${f.nspname}.${f.proname}`).toBe(f.nspname === "ogevia_api");
    }
  });
});

describe("0124 rollback", () => {
  it("label history rows are append-only", async () => {
    await expect(db.admin.query("update ogevia.home_label_events set reason = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.admin.query("delete from ogevia.visit_punches")).rejects.toThrow(/append-only/);
  });
  it("the rollback removes every 0124 object and the migration applies again; visits, confirmations and audit rows are untouched", async () => {
    const visits = (await db.admin.query("select count(*)::int n from ogevia.service_visits")).rows[0].n;
    const audits = (await db.admin.query("select count(*)::int n from ogevia.audit_events")).rows[0].n;
    await run(DOWN);
    expect((await db.admin.query("select to_regclass('ogevia.home_labels') a, to_regprocedure('ogevia_api.record_punch(text,uuid,text,uuid,uuid,numeric,numeric,integer,uuid,boolean)') b")).rows[0]).toEqual({ a: null, b: null });
    expect((await db.admin.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname like 'vv\\_%' and n.nspname = 'ogevia'")).rows[0].n).toBe(0);
    expect((await db.admin.query("select count(*)::int n from ogevia.service_visits")).rows[0].n).toBe(visits);
    expect((await db.admin.query("select count(*)::int n from ogevia.audit_events")).rows[0].n).toBe(audits);
    await run(UP);
  });
});
