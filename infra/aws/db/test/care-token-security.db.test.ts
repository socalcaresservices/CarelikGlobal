// Opaque-token (no-Cognito) care links: validity, expiry/revocation, scope,
// and the acceptance rules of the care-request workflow. SYNTHETIC data only.
// Public calls run exactly like the API: SET LOCAL ROLE ogevia_app, NO actor.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let fx: { client: string; service: string; auth: string };
let fx2: { client: string; service: string; auth: string };
const token = () => randomBytes(32).toString("hex");
const hash = (value: string) => createHash("sha256").update(value, "hex").digest("hex");
const NOT_VALID = /not valid or is no longer active/;

async function asPublic<T>(fn: (c: pg.PoolClient) => Promise<T>) {
  const c = await db.admin.connect();
  try {
    await c.query("begin");
    await c.query("set local role ogevia_app");
    const result = await fn(c);
    await c.query("commit");
    return result;
  } catch (error) {
    await c.query("rollback");
    throw error;
  } finally {
    c.release();
  }
}
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);

async function portal(client: string, org = w.orgA, manager: Actor = w.managerA) {
  const t = token();
  await asActor(db, manager.sub, (c) => c.query("select ogevia_api.create_client_care_portal($1,$2,$3,null)", [org, client, hash(t)]));
  return t;
}
/** A future slot `days` ahead, `hours` long (UTC-anchored, inside the authorization window). */
async function slot(days: number, hours = 4, startHour = 18) {
  const r = await q(
    `select (date_trunc('day', now()) + make_interval(days => $1, hours => $3))::text s,
            (date_trunc('day', now()) + make_interval(days => $1, hours => $3 + $2))::text e`,
    [days, hours, startHour],
  );
  return { s: r.rows[0].s as string, e: r.rows[0].e as string };
}
async function request(portalToken: string, service: string, days: number, hours = 4) {
  const { s, e } = await slot(days, hours);
  return asPublic(async (c) =>
    (await c.query("select * from ogevia_api.public_create_care_request($1,$2,$3,$4,null,$5)", [hash(portalToken), service, s, e, randomUUID()])).rows[0] as {
      request_id: string;
      status: string;
      short_notice: boolean;
    },
  );
}
async function offer(requestId: string, caregiver: Actor) {
  const t = token();
  const cr = (await q("select id from ogevia.caregiver_records where linked_user_id=$1 and organization_id=$2", [caregiver.userId, w.orgA])).rows[0].id as string;
  const id = await asActor(db, w.managerA.sub, async (c) =>
    (await c.query("select ogevia_api.send_care_offer($1,$2,$3,$4) id", [w.orgA, requestId, cr, hash(t)])).rows[0].id as string,
  );
  return { token: t, id, caregiverRecordId: cr };
}
const respond = (t: string, available: boolean) => asPublic((c) => c.query("select ogevia_api.public_respond_care_offer($1,$2,null) s", [hash(t), available]));
const assign = (requestId: string, offerId: string) =>
  asActor(db, w.managerA.sub, async (c) => (await c.query("select ogevia_api.assign_care_request($1,$2,$3) id", [w.orgA, requestId, offerId])).rows[0].id as string);

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  fx = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 20, after: 40 });
  fx2 = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 20, after: 40 });
  const allWeek = JSON.stringify([0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, specific_date: null, start_local: "00:00", end_local: "23:59" })));
  for (const a of [w.caregiverA1, w.caregiverA2, w.caregiverA3]) {
    await asActor(db, a.sub, (c) => c.query("select ogevia_api.replace_my_availability($1,$2::jsonb,'[]'::jsonb)", [w.orgA, allWeek]));
  }
});
afterAll(async () => db?.drop());

describe("portal tokens: invalid, revoked, expired, out of scope", () => {
  it("an unknown token fails every portal endpoint with one generic error", async () => {
    const t = token();
    await expectPgError(asPublic((c) => c.query("select * from ogevia_api.get_public_care_portal($1)", [hash(t)])), "OGN04", NOT_VALID);
    const { s, e } = await slot(10);
    await expectPgError(asPublic((c) => c.query("select * from ogevia_api.public_create_care_request($1,$2,$3,$4,null,$5)", [hash(t), fx.service, s, e, randomUUID()])), "OGN04", NOT_VALID);
    expect((await asPublic((c) => c.query("select * from ogevia_api.public_get_care_request($1,$2)", [hash(t), randomUUID()]))).rows).toEqual([]);
    await expectPgError(asPublic((c) => c.query("select ogevia_api.public_cancel_care_request($1,$2,null)", [hash(t), randomUUID()])), "OGN04");
  });

  it("the raw token (unhashed) is not accepted: only the SHA-256 is stored", async () => {
    const t = await portal(fx.client);
    await expectPgError(asPublic((c) => c.query("select * from ogevia_api.get_public_care_portal($1)", [t])), "OGN04");
    const stored = await q("select count(*)::int n from ogevia.client_care_portals where token_hash=$1", [t]);
    expect(stored.rows[0].n).toBe(0);
  });

  it("revocation: only care managers can revoke; revoked links never work again; audited", async () => {
    const t = await portal(fx.client);
    const req = await request(t, fx.service, 11);
    await expectPgError(asActor(db, w.caregiverA1.sub, (c) => c.query("select ogevia_api.revoke_client_care_portals($1,$2)", [w.orgA, fx.client])), "OGA03");
    const n = await asActor(db, w.managerA.sub, async (c) => (await c.query("select ogevia_api.revoke_client_care_portals($1,$2) n", [w.orgA, fx.client])).rows[0].n);
    expect(n).toBeGreaterThanOrEqual(1);
    await expectPgError(asPublic((c) => c.query("select * from ogevia_api.get_public_care_portal($1)", [hash(t)])), "OGN04", NOT_VALID);
    const { s, e } = await slot(12);
    await expectPgError(asPublic((c) => c.query("select * from ogevia_api.public_create_care_request($1,$2,$3,$4,null,$5)", [hash(t), fx.service, s, e, randomUUID()])), "OGN04");
    expect((await asPublic((c) => c.query("select * from ogevia_api.public_get_care_request($1,$2)", [hash(t), req.request_id]))).rows).toEqual([]);
    await expectPgError(asPublic((c) => c.query("select ogevia_api.public_cancel_care_request($1,$2,null)", [hash(t), req.request_id])), "OGN04");
    // Re-activating the flag alone does not resurrect a revoked link.
    await q("update ogevia.client_care_portals set is_active=true where token_hash=$1", [hash(t)]);
    await expectPgError(asPublic((c) => c.query("select * from ogevia_api.get_public_care_portal($1)", [hash(t)])), "OGN04");
    const audit = await q("select count(*)::int n from ogevia.audit_events where action='care_portal.revoked' and entity_id=$1", [fx.client]);
    expect(audit.rows[0].n).toBe(1);
    // A new link for the same client works.
    const fresh = await portal(fx.client);
    expect((await asPublic((c) => c.query("select * from ogevia_api.get_public_care_portal($1)", [hash(fresh)]))).rows.length).toBeGreaterThan(0);
  });

  it("expiry: a past expires_at is rejected, a future one works", async () => {
    const t = await portal(fx.client);
    await q("update ogevia.client_care_portals set expires_at=now()+interval '1 day' where token_hash=$1", [hash(t)]);
    expect((await asPublic((c) => c.query("select * from ogevia_api.get_public_care_portal($1)", [hash(t)]))).rows.length).toBeGreaterThan(0);
    await q("update ogevia.client_care_portals set expires_at=now()-interval '1 second' where token_hash=$1", [hash(t)]);
    await expectPgError(asPublic((c) => c.query("select * from ogevia_api.get_public_care_portal($1)", [hash(t)])), "OGN04", NOT_VALID);
    const { s, e } = await slot(13);
    await expectPgError(asPublic((c) => c.query("select * from ogevia_api.public_create_care_request($1,$2,$3,$4,null,$5)", [hash(t), fx.service, s, e, randomUUID()])), "OGN04");
  });

  it("a deleted client or suspended organization disables the link, including request creation", async () => {
    const extra = await freshClient(db, w, w.caregiverA1, 600, w.orgA, { before: 20, after: 40 });
    const t = await portal(extra.client);
    await q("update ogevia.clients set deleted_at=now() where id=$1", [extra.client]);
    const { s, e } = await slot(14);
    await expectPgError(asPublic((c) => c.query("select * from ogevia_api.public_create_care_request($1,$2,$3,$4,null,$5)", [hash(t), extra.service, s, e, randomUUID()])), "OGN04");
    const tb = await portal(w.clientB1, w.orgB, w.managerB);
    await q("update ogevia.organizations set status='suspended' where id=$1", [w.orgB]);
    try {
      await expectPgError(asPublic((c) => c.query("select * from ogevia_api.get_public_care_portal($1)", [hash(tb)])), "OGN04");
    } finally {
      await q("update ogevia.organizations set status='active' where id=$1", [w.orgB]);
    }
  });

  it("scope: a portal token only reaches its own client's requests", async () => {
    const t1 = await portal(fx.client);
    const t2 = await portal(fx2.client);
    const r2 = await request(t2, fx2.service, 15);
    expect((await asPublic((c) => c.query("select * from ogevia_api.public_get_care_request($1,$2)", [hash(t1), r2.request_id]))).rows).toEqual([]);
    await expectPgError(asPublic((c) => c.query("select ogevia_api.public_cancel_care_request($1,$2,null)", [hash(t1), r2.request_id])), "OGN04");
    expect((await q("select status from ogevia.care_requests where id=$1", [r2.request_id])).rows[0].status).toBe("requested");
    // Another organization's portal cannot read this organization's request either.
    const tb = await portal(w.clientB1, w.orgB, w.managerB);
    expect((await asPublic((c) => c.query("select * from ogevia_api.public_get_care_request($1,$2)", [hash(tb), r2.request_id]))).rows).toEqual([]);
  });

  it("scope: a portal can only request services authorized for ITS client (no service mixing)", async () => {
    const t = await portal(fx.client);
    const { s, e } = await slot(16);
    await expectPgError(asPublic((c) => c.query("select * from ogevia_api.public_create_care_request($1,$2,$3,$4,null,$5)", [hash(t), w.serviceB, s, e, randomUUID()])), "OGV22", /authorization/);
  });

  it("portal and offer tokens are not interchangeable", async () => {
    const t = await portal(fx.client);
    await expectPgError(asPublic((c) => c.query("select ogevia_api.public_respond_care_offer($1,true,null)", [hash(t)])), "OGN04");
    const r = await request(t, fx.service, 17);
    const o = await offer(r.request_id, w.caregiverA2);
    await expectPgError(asPublic((c) => c.query("select * from ogevia_api.get_public_care_portal($1)", [hash(o.token)])), "OGN04");
  });
});

describe("offer tokens: invalid, rotated, expired, wrong scope", () => {
  it("an unknown offer token fails every offer endpoint", async () => {
    const t = token();
    expect((await asPublic((c) => c.query("select * from ogevia_api.public_get_care_offer($1)", [hash(t)]))).rows).toEqual([]);
    await expectPgError(respond(t, true), "OGN04", NOT_VALID);
    await expectPgError(asPublic((c) => c.query("select ogevia_api.public_cancel_assigned_offer($1,'x')", [hash(t)])), "OGN04");
  });

  it("re-sending an offer rotates the link: the old token stops working", async () => {
    const pt = await portal(fx.client);
    const r = await request(pt, fx.service, 18);
    const first = await offer(r.request_id, w.caregiverA2);
    const second = await offer(r.request_id, w.caregiverA2);
    expect(second.id).toBe(first.id);
    await expectPgError(respond(first.token, true), "OGN04");
    expect((await respond(second.token, true)).rows[0].s).toBe("available");
  });

  it("links expire when the client cancels or the care has ended", async () => {
    const pt = await portal(fx.client);
    const r = await request(pt, fx.service, 19);
    const o = await offer(r.request_id, w.caregiverA2);
    await asPublic((c) => c.query("select ogevia_api.public_cancel_care_request($1,$2,null)", [hash(pt), r.request_id]));
    expect((await asPublic((c) => c.query("select * from ogevia_api.public_get_care_offer($1)", [hash(o.token)]))).rows).toEqual([]);
    await expectPgError(respond(o.token, true), "OGN04");

    const r2 = await request(pt, fx.service, 20);
    const o2 = await offer(r2.request_id, w.caregiverA2);
    await q("update ogevia.care_requests set starts_at=now()-interval '5 hours', ends_at=now()-interval '1 hour' where id=$1", [r2.request_id]);
    expect((await asPublic((c) => c.query("select * from ogevia_api.public_get_care_offer($1)", [hash(o2.token)]))).rows).toEqual([]);
    await expectPgError(respond(o2.token, false), "OGN04");
  });

  it("responses are refused once the care has started (link still shows status)", async () => {
    const pt = await portal(fx.client);
    const r = await request(pt, fx.service, 21);
    const o = await offer(r.request_id, w.caregiverA2);
    await q("update ogevia.care_requests set starts_at=now()-interval '1 minute', ends_at=now()+interval '3 hours' where id=$1", [r.request_id]);
    expect((await asPublic((c) => c.query("select * from ogevia_api.public_get_care_offer($1)", [hash(o.token)]))).rows).toHaveLength(1);
    await expectPgError(respond(o.token, true), "OGC09", /no longer open/);
  });

  it("only the assigned caregiver's link can call out; another caregiver's link cannot", async () => {
    const pt = await portal(fx.client);
    const r = await request(pt, fx.service, 22);
    const a2 = await offer(r.request_id, w.caregiverA2);
    const a3 = await offer(r.request_id, w.caregiverA3);
    await respond(a2.token, true);
    await respond(a3.token, true);
    await expectPgError(asPublic((c) => c.query("select ogevia_api.public_cancel_assigned_offer($1,'x')", [hash(a3.token)])), "OGN04");
    await assign(r.request_id, a2.id);
    await expectPgError(asPublic((c) => c.query("select ogevia_api.public_cancel_assigned_offer($1,'x')", [hash(a3.token)])), "OGN04");
    // The non-assigned caregiver's response no longer changes anything.
    expect((await respond(a3.token, true)).rows[0].s).toBe("filled");
    expect((await q("select assigned_caregiver_record_id from ogevia.care_requests where id=$1", [r.request_id])).rows[0].assigned_caregiver_record_id).toBe(a2.caregiverRecordId);
  });
});

describe("care workflow acceptance rules", () => {
  it("three-hour minimum and short-notice flag (< 72 h)", async () => {
    const pt = await portal(fx.client);
    const { s, e } = await slot(23, 2);
    await expectPgError(asPublic((c) => c.query("select * from ogevia_api.public_create_care_request($1,$2,$3,$4,null,$5)", [hash(pt), fx.service, s, e, randomUUID()])), "OGV22", /3 hours/);
    expect((await request(pt, fx.service, 24, 3)).short_notice).toBe(false);
    const soon = await q("select (now()+interval '30 hours')::text s, (now()+interval '34 hours')::text e");
    const short = await asPublic(async (c) =>
      (await c.query("select * from ogevia_api.public_create_care_request($1,$2,$3,$4,null,$5)", [hash(pt), fx.service, soon.rows[0].s, soon.rows[0].e, randomUUID()])).rows[0],
    );
    expect(short.short_notice).toBe(true);
  });

  it("the same request key is idempotent (link re-submit does not duplicate)", async () => {
    const pt = await portal(fx.client);
    const { s, e } = await slot(25);
    const key = randomUUID();
    const call = () => asPublic(async (c) => (await c.query("select * from ogevia_api.public_create_care_request($1,$2,$3,$4,null,$5)", [hash(pt), fx.service, s, e, key])).rows[0].request_id);
    expect(await call()).toBe(await call());
  });

  it("Available / Not available never assigns; only the agency assigns; reservation made once", async () => {
    const pt = await portal(fx.client);
    const r = await request(pt, fx.service, 26);
    const yes = await offer(r.request_id, w.caregiverA2);
    const no = await offer(r.request_id, w.caregiverA3);
    await respond(yes.token, true);
    await respond(no.token, false);
    const before = await q("select status, assigned_shift_id from ogevia.care_requests where id=$1", [r.request_id]);
    expect(before.rows[0]).toEqual({ status: "accepted_pending_assignment", assigned_shift_id: null });
    expect((await q("select count(*)::int n from ogevia.authorization_reservations where care_request_id=$1", [r.request_id])).rows[0].n).toBe(0);
    // A caregiver who said Not available is filtered from candidates.
    const candidates = await asActor(db, w.managerA.sub, async (c) => (await c.query("select caregiver_record_id from ogevia_api.list_available_caregivers($1,$2)", [w.orgA, r.request_id])).rows.map((x) => x.caregiver_record_id));
    expect(candidates).not.toContain(no.caregiverRecordId);
    // A caregiver cannot assign.
    await expectPgError(asActor(db, w.caregiverA2.sub, (c) => c.query("select ogevia_api.assign_care_request($1,$2,$3)", [w.orgA, r.request_id, yes.id])), "OGA03");
    const shift = await assign(r.request_id, yes.id);
    expect((await q("select count(*)::int n, sum(reserved_minutes)::int m from ogevia.authorization_reservations where care_request_id=$1", [r.request_id])).rows[0]).toEqual({ n: 1, m: 240 });
    expect((await q("select status from ogevia.shifts where id=$1", [shift])).rows[0].status).toBe("scheduled");
    // Notifications: caregiver and client portal are told about the assignment.
    const notes = await q("select recipient_type, event_key from ogevia.care_notifications where care_request_id=$1 and event_key='assignment_confirmed' order by 1", [r.request_id]);
    expect(notes.rows.map((x) => x.recipient_type).sort()).toEqual(["caregiver", "client_portal"]);
  });

  it("explicit availability and conflicts filter candidates", async () => {
    const pt = await portal(fx.client);
    const r = await request(pt, fx.service, 27);
    // A2 blocks that date; A3 already has an overlapping scheduled shift.
    const day = (await q("select (starts_at at time zone 'America/Los_Angeles')::date::text d from ogevia.care_requests where id=$1", [r.request_id])).rows[0].d;
    const allWeek = JSON.stringify([0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, specific_date: null, start_local: "00:00", end_local: "23:59" })));
    await asActor(db, w.caregiverA2.sub, (c) => c.query("select ogevia_api.replace_my_availability($1,$2::jsonb,$3::jsonb)", [w.orgA, allWeek, JSON.stringify([day])]));
    const a3 = (await q("select id from ogevia.caregiver_records where linked_user_id=$1", [w.caregiverA3.userId])).rows[0].id;
    await q(
      "insert into ogevia.shifts(organization_id,client_id,service_id,caregiver_user_id,caregiver_record_id,starts_at,ends_at,status) select organization_id,client_id,service_id,$2,$3,starts_at+interval '1 hour',ends_at+interval '1 hour','scheduled' from ogevia.care_requests where id=$1",
      [r.request_id, w.caregiverA3.userId, a3],
    );
    const ids = await asActor(db, w.managerA.sub, async (c) => (await c.query("select caregiver_record_id from ogevia_api.list_available_caregivers($1,$2)", [w.orgA, r.request_id])).rows.map((x) => x.caregiver_record_id));
    const a2 = (await q("select id from ogevia.caregiver_records where linked_user_id=$1", [w.caregiverA2.userId])).rows[0].id;
    expect(ids).not.toContain(a2);
    expect(ids).not.toContain(a3);
    await asActor(db, w.caregiverA2.sub, (c) => c.query("select ogevia_api.replace_my_availability($1,$2::jsonb,'[]'::jsonb)", [w.orgA, allWeek]));
  });

  it("caregiver call-out keeps the same shift + reservation and returns to Coverage Needed", async () => {
    const pt = await portal(fx.client);
    const r = await request(pt, fx.service, 28);
    const o = await offer(r.request_id, w.caregiverA2);
    await respond(o.token, true);
    const shift = await assign(r.request_id, o.id);
    await asPublic((c) => c.query("select ogevia_api.public_cancel_assigned_offer($1,'Sick')", [hash(o.token)]));
    const after = await q("select status, assigned_shift_id from ogevia.care_requests where id=$1", [r.request_id]);
    expect(after.rows[0]).toEqual({ status: "coverage_needed", assigned_shift_id: shift });
    expect((await q("select count(*)::int n from ogevia.authorization_reservations where care_request_id=$1 and released_at is null", [r.request_id])).rows[0].n).toBe(1);
    expect((await q("select count(*)::int n from ogevia.care_notifications where care_request_id=$1 and event_key='coverage_needed'", [r.request_id])).rows[0].n).toBeGreaterThan(0);
    // The same link cannot call out twice.
    await expectPgError(asPublic((c) => c.query("select ogevia_api.public_cancel_assigned_offer($1,'again')", [hash(o.token)])), "OGN04");
  });

  it("client cancellation releases the reservation, cancels the shift, and alerts staff + caregiver", async () => {
    const pt = await portal(fx.client);
    const r = await request(pt, fx.service, 29);
    const o = await offer(r.request_id, w.caregiverA2);
    await respond(o.token, true);
    const shift = await assign(r.request_id, o.id);
    await asPublic((c) => c.query("select ogevia_api.public_cancel_care_request($1,$2,'No longer needed')", [hash(pt), r.request_id]));
    expect((await q("select status from ogevia.shifts where id=$1", [shift])).rows[0].status).toBe("cancelled");
    expect((await q("select release_reason from ogevia.authorization_reservations where care_request_id=$1", [r.request_id])).rows[0].release_reason).toBe("client_cancelled");
    const notes = await q("select distinct recipient_type from ogevia.care_notifications where care_request_id=$1 and event_key like 'client_cancelled%' order by 1", [r.request_id]);
    expect(notes.rows.map((x) => x.recipient_type).sort()).toEqual(["caregiver", "staff"]);
    // Client sees the status through the link; the request is now closed to offers.
    const view = await asPublic((c) => c.query("select status from ogevia_api.public_get_care_request($1,$2)", [hash(pt), r.request_id]));
    expect(view.rows[0].status).toBe("client_cancelled");
  });
});

describe("portal request list (0012): a reusable link shows only its own upcoming requests", () => {
  const list = (t: string) => asPublic((c) => c.query("select * from ogevia_api.public_list_care_requests($1)", [hash(t)]));

  it("lists this link's requests with status, and only those", async () => {
    const mine = await portal(fx.client);
    const sibling = await portal(fx.client); // second link for the SAME client
    const other = await portal(fx2.client);
    const a = await request(mine, fx.service, 8);
    const b = await request(mine, fx.service, 9);
    await request(sibling, fx.service, 10);
    await request(other, fx2.service, 11);
    const rows = (await list(mine)).rows;
    expect(rows.map((r) => r.request_id).sort()).toEqual([a.request_id, b.request_id].sort());
    expect(rows[0]).toMatchObject({ status: "requested", short_notice: false, caregiver_name: null });
    expect(Object.keys(rows[0]).sort()).toEqual(["caregiver_name", "ends_at", "request_id", "service_code", "service_name", "short_notice", "starts_at", "status"]);
  });

  it("shows the caregiver first name only while assigned, and the cancelled status after a client cancel", async () => {
    const pt = await portal(fx.client);
    const r = await request(pt, fx.service, 12);
    const o = await offer(r.request_id, w.caregiverA2);
    await respond(o.token, true);
    expect((await list(pt)).rows[0].caregiver_name).toBeNull();
    await assign(r.request_id, o.id);
    expect((await list(pt)).rows[0]).toMatchObject({ status: "assigned" });
    expect((await list(pt)).rows[0].caregiver_name).toBeTruthy();
    await asPublic((c) => c.query("select ogevia_api.public_cancel_care_request($1,$2,null)", [hash(pt), r.request_id]));
    expect((await list(pt)).rows[0]).toMatchObject({ status: "client_cancelled", caregiver_name: null });
  });

  it("excludes requests that have already ended", async () => {
    const pt = await portal(fx.client);
    const r = await request(pt, fx.service, 13);
    await q("update ogevia.care_requests set starts_at=now()-interval '5 hours', ends_at=now()-interval '1 hour' where id=$1", [r.request_id]);
    expect((await list(pt)).rows).toHaveLength(0);
  });

  it("unknown, raw (unhashed), revoked and expired links are refused (OGN04), never an empty success", async () => {
    await expectPgError(list(token()), "OGN04", NOT_VALID);
    const pt = await portal(fx2.client);
    await expectPgError(asPublic((c) => c.query("select * from ogevia_api.public_list_care_requests($1)", [pt])), "OGN04");
    await q("update ogevia.client_care_portals set expires_at=now()-interval '1 second' where token_hash=$1", [hash(pt)]);
    await expectPgError(list(pt), "OGN04");
    const rv = await portal(fx2.client);
    await asActor(db, w.managerA.sub, (c) => c.query("select ogevia_api.revoke_client_care_portals($1,$2)", [w.orgA, fx2.client]));
    await expectPgError(list(rv), "OGN04");
  });

  it("an offer token cannot be used as a portal token", async () => {
    const pt = await portal(fx.client);
    const r = await request(pt, fx.service, 14);
    const o = await offer(r.request_id, w.caregiverA3);
    await expectPgError(list(o.token), "OGN04");
  });
});
