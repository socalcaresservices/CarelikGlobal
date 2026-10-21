// 0036 Missing-signature recovery: a visit without a client signature stays
// pending (not forced closed) while a confirmation is collected later by a
// staff-copied secure link + one-time code given by phone, or on paper. A
// person reviews the response; acceptance makes the visit eligible for the
// separate human billing approval only. SYNTHETIC data only.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, asActor, createTestDb, endedVisit, expectPgError, freshClient, seedWorld, signedVisit, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
});
afterAll(async () => db?.drop());

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const q = async (a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[]);
/** Public routes run as the application role with no signed-in user (as the API does). */
const pub = async (sql: string, params: unknown[]) => {
  const c = await db.admin.connect();
  try {
    await c.query("begin");
    await c.query("set local role ogevia_app");
    const rows = (await c.query(sql, params)).rows as any[];
    await c.query("commit");
    return rows;
  } catch (error) {
    await c.query("rollback");
    throw error;
  } finally {
    c.release();
  }
};

async function person(org: string, role: string): Promise<Actor> {
  const sub = randomUUID();
  const userId = (await db.admin.query("insert into ogevia.app_users (cognito_sub, display_name) values ($1, 'Synthetic Pat Caregiver') returning id", [sub])).rows[0].id;
  await db.admin.query("insert into ogevia.organization_memberships (organization_id, user_id, role, status) values ($1,$2,$3,'active')", [org, userId, role]);
  if (role === "caregiver") {
    await db.admin.query("insert into ogevia.caregiver_records (organization_id, linked_user_id, caregiver_code, first_name, last_name) values ($1,$2,$3,'Synthetic','Pat')", [org, userId, "CG-" + sub.slice(0, 6)]);
  }
  return { userId, sub };
}

/** A visit confirmed "unable to confirm": administrator_review, 0 billable. */
async function noSignerVisit(minutes = 45, authMinutes = 600) {
  const cg = await person(w.orgA, "caregiver");
  const c = await freshClient(db, w, cg, authMinutes);
  const visit = await endedVisit(db, cg, w, minutes, w.orgA, c.client, c.service);
  await api.confirm(db, cg, visit, { method: "unable_to_confirm", reason: "Client asleep; parent not home (synthetic)" });
  const lineage = (await db.admin.query("select lineage_id from ogevia.client_authorizations where id = $1", [c.auth])).rows[0].lineage_id;
  return { visit, cg, client: c.client, service: c.service, auth: c.auth, lineage };
}

function newLink() {
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const tokenHash = sha(token);
  const code = String(100000 + Math.floor(Math.random() * 900000));
  return { tokenHash, code, codeHash: sha(`${tokenHash}:${code}`), wrong: sha(`${tokenHash}:000000`) };
}
const request = (a: Actor, visit: string, o: Partial<{ channel: string; name: string; role: string; check: string | null; link: ReturnType<typeof newLink> | null; days: number }> = {}) => {
  const link = o.link === undefined ? newLink() : o.link;
  const channel = o.channel ?? "link";
  return q(a, "select * from ogevia_api.create_visit_confirmation_request($1, $2, $3, $4, $5, $6, $7, $8, null)",
    [visit, channel, o.name ?? "Synthetic Parent Rivera", o.role ?? "parent", o.check === undefined ? "Called the number on file and confirmed the parent's name" : o.check,
     channel === "link" ? link?.tokenHash ?? null : null, channel === "link" ? link?.codeHash ?? null : null, o.days ?? 7]).then((r) => ({ ...r[0], link }));
};
const open = (tokenHash: string, codeHash: string) => pub("select * from ogevia_api.public_open_visit_confirmation($1, $2)", [tokenHash, codeHash]).then((r) => r[0]);
const respond = (l: { tokenHash: string; codeHash: string }, o: Partial<{ id: string; outcome: string; method: string; name: string; dispute: string | null; attested: boolean; key: string; org: string }> = {}) => {
  const id = o.id ?? randomUUID();
  const method = o.method ?? "typed";
  const draw = method === "draw";
  return pub("select * from ogevia_api.public_respond_visit_confirmation($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
    [l.tokenHash, l.codeHash, id, o.outcome ?? "confirmed", method, o.name ?? "Synthetic Parent Rivera", o.dispute ?? null, o.attested ?? true,
     draw ? `${o.org ?? w.orgA}/${id}/client-signature.png` : null, draw ? "v1" : null, draw ? 2048 : null, draw ? "b".repeat(64) : null, o.key ?? randomUUID()]).then((r) => r[0]);
};
const review = (a: Actor, late: string, outcome: string, reason = "Checked against the schedule (synthetic)") =>
  q(a, "select * from ogevia_api.review_late_visit_confirmation($1, $2, $3, null)", [late, outcome, reason]).then((r) => r[0]);
const attention = (a: Actor = w.managerA) => q(a, "select * from ogevia_api.get_attention_summary($1)", [w.orgA]).then((r) => r[0]);
const reviewRow = (a: Actor, visit: string) => q(a, "select * from ogevia_api.get_visit_review($1)", [visit]).then((r) => r[0]);
const billingRow = async (visit: string) => {
  const d = (await db.admin.query("select service_date::text d from ogevia.service_visits where id = $1", [visit])).rows[0].d;
  return (await q(w.managerA, "select * from ogevia_api.list_billing_review_visits($1, $2::date, $2::date)", [w.orgA, d])).find((r) => r.visit_id === visit);
};
const usage = async (lineage: string, visit: string) => {
  const d = (await db.admin.query("select service_date::text d from ogevia.service_visits where id = $1", [visit])).rows[0].d;
  return Number((await db.admin.query("select ogevia.authorization_month_usage($1, $2::date) n", [lineage, d])).rows[0].n);
};

describe("pending for recovery instead of forced closure", () => {
  it("a no-signer visit can be put on hold with a request: it leaves the Needs attention count and shows as awaiting signature", async () => {
    const v = await noSignerVisit();
    const before = await attention();
    expect((await reviewRow(w.managerA, v.visit))).toMatchObject({ can_request_confirmation: true, recovery_state: null, allowed_decisions: ["close_not_billable"] });
    await request(w.managerA, v.visit);
    const after = await attention();
    expect(after.needs_review).toBe(before.needs_review - 1);
    expect(after.awaiting_signature).toBe(before.awaiting_signature + 1);
    expect(after.total).toBe(before.total - 1);
    expect(await reviewRow(w.managerA, v.visit)).toMatchObject({ recovery_state: "awaiting_response", can_request_confirmation: false, allowed_decisions: [] });
    expect(await billingRow(v.visit)).toMatchObject({ review_state: "awaiting_signature", eligible_minutes: 0 });
    // The visit itself is unchanged and nothing was approved.
    expect((await db.admin.query("select status, billable_minutes from ogevia.service_visits where id = $1", [v.visit])).rows[0]).toEqual({ status: "administrator_review", billable_minutes: 0 });
    expect(Number((await db.admin.query("select count(*) n from ogevia.billing_approvals where visit_id = $1", [v.visit])).rows[0].n)).toBe(0);
  });

  it("refuses requests that do not fit: signed visit, second open request, missing phone verification, caregiver, other agency", async () => {
    const v = await noSignerVisit();
    const { visit: signed } = await signedVisit(db, w.caregiverA1, w, 30);
    await expectPgError(request(w.managerA, signed), "OGC09", /only for a visit in review without a client signature/);
    await expectPgError(request(w.managerA, v.visit, { check: null }), "OGV22", /verify the person by phone/);
    await expectPgError(request(w.managerA, v.visit, { days: 45 }), "OGV22", /1 to 30 days/);
    await expectPgError(request(v.cg, v.visit), "OGA03");
    await expectPgError(request(w.managerB, v.visit), "OGN04");
    await request(w.managerA, v.visit);
    await expectPgError(request(w.managerA, v.visit), "OGC09", /already open; revoke it first/);
  });
});

describe("the secure link and one-time code", () => {
  it("shows the visit only with the right code; five wrong codes lock the link and the visit returns to Needs attention", async () => {
    const v = await noSignerVisit(45);
    const r = await request(w.managerA, v.visit);
    const l = r.link!;
    expect(await open(l.tokenHash, l.wrong)).toMatchObject({ status: "wrong_code", attempts_left: 4, agency_name: null, service_name: null });
    const ok = await open(l.tokenHash, l.codeHash);
    expect(ok).toMatchObject({ status: "ok", recipient_name: "Synthetic Parent Rivera", worked_minutes: 45, caregiver_first_name: "Synthetic" });
    // Only first name, service, times: no client code, name, DOB or payer identifiers are returned.
    expect(Object.keys(ok).sort()).toEqual(["agency_name", "attempts_left", "caregiver_first_name", "expires_at", "organization_id", "recipient_name",
      "service_date", "service_name", "status", "time_in", "time_out", "timezone", "worked_minutes"]);
    for (let i = 0; i < 4; i++) await open(l.tokenHash, l.wrong);
    expect(await open(l.tokenHash, l.codeHash)).toMatchObject({ status: "locked" });
    expect(await respond(l)).toMatchObject({ status: "locked", late_confirmation_id: null });
    expect(await reviewRow(w.managerA, v.visit)).toMatchObject({ recovery_state: null, can_request_confirmation: true });
    const reqs = await q(w.managerA, "select * from ogevia_api.list_visit_confirmation_requests($1)", [v.visit]);
    expect(reqs[0]).toMatchObject({ state: "locked", failed_code_attempts: 5 });
    expect(Number((await db.admin.query("select count(*) n from ogevia.audit_events where entity_id = $1 and action = 'visit.confirmation_request_locked'", [r.request_id])).rows[0].n)).toBe(1);
    // A new request closes the locked one and keeps it on record.
    const r2 = await request(w.managerA, v.visit);
    const states = (await q(w.managerA, "select request_id, state, revoke_reason from ogevia_api.list_visit_confirmation_requests($1)", [v.visit]));
    expect(states.find((s) => s.request_id === r.request_id)).toMatchObject({ state: "revoked", revoke_reason: "Closed when a new request was made (locked)" });
    expect(states.find((s) => s.request_id === r2.request_id)).toMatchObject({ state: "open" });
  });

  it("an unknown, revoked or expired link reads 'unavailable' with no detail", async () => {
    const x = newLink();
    expect(await open(x.tokenHash, x.codeHash)).toMatchObject({ status: "unavailable", attempts_left: null });
    const v = await noSignerVisit();
    const r = await request(w.managerA, v.visit);
    await q(w.managerA, "select ogevia_api.revoke_visit_confirmation_request($1, 'Wrong recipient (synthetic)', null)", [r.request_id]);
    expect(await open(r.link!.tokenHash, r.link!.codeHash)).toMatchObject({ status: "unavailable" });
    const v2 = await noSignerVisit();
    const r2 = await request(w.managerA, v2.visit, { days: 1 });
    {
      const c = await db.admin.connect();
      try {
        await c.query("set session_replication_role = replica");
        await c.query("update ogevia.visit_confirmation_requests set expires_at = now() - interval '1 minute', created_at = now() - interval '2 days' where id = $1", [r2.request_id]);
      } finally { await c.query("reset session_replication_role"); c.release(); }
    }
    expect(await open(r2.link!.tokenHash, r2.link!.codeHash)).toMatchObject({ status: "unavailable" });
    // Expired: back in Needs attention, a new request may be made.
    expect(await reviewRow(w.managerA, v2.visit)).toMatchObject({ recovery_state: null, can_request_confirmation: true });
  });
});

describe("response, review and billing eligibility", () => {
  it("a confirmed response goes to review; acceptance makes the visit eligible for human approval up to the accepted minutes, and nothing more", async () => {
    const v = await noSignerVisit(45);
    const r = await request(w.managerA, v.visit);
    const before = await attention();
    const key = randomUUID();
    const res = await respond(r.link!, { method: "draw", key });
    expect(res.status).toBe("ok");
    // A retry with the same key returns the same response; a second response is refused.
    expect(await respond(r.link!, { method: "draw", key, id: randomUUID() })).toEqual(res);
    expect(await respond(r.link!)).toMatchObject({ status: "unavailable" });
    const after = await attention();
    expect(after.late_responses_to_review).toBe(before.late_responses_to_review + 1);
    expect(after.awaiting_signature).toBe(before.awaiting_signature - 1);
    expect(await billingRow(v.visit)).toMatchObject({ review_state: "late_response_to_review", eligible_minutes: 0 });
    // Not approvable before review.
    await expectPgError(q(w.managerA, "select ogevia_api.approve_visit_for_billing($1, 45, null, null)", [v.visit]), "OGC09", /must be resolved first/);

    const usageBefore = await usage(v.lineage, v.visit);
    const rv = await review(w.managerA, res.late_confirmation_id, "accepted");
    expect(rv).toMatchObject({ accepted_minutes: 45, capped_by_authorization: false });
    expect(await usage(v.lineage, v.visit)).toBe(usageBefore + 45);
    expect(await billingRow(v.visit)).toMatchObject({ review_state: "reviewed_eligible", eligible_minutes: 45, review_decision: "accept_late_confirmation" });
    // The locked visit and its original confirmation are untouched; no approval was created.
    expect((await db.admin.query("select status, billable_minutes from ogevia.service_visits where id = $1", [v.visit])).rows[0]).toEqual({ status: "administrator_review", billable_minutes: 0 });
    expect((await db.admin.query("select confirmation_method from ogevia.visit_confirmations where visit_id = $1", [v.visit])).rows[0].confirmation_method).toBe("unable_to_confirm");
    expect(Number((await db.admin.query("select count(*) n from ogevia.billing_approvals where visit_id = $1", [v.visit])).rows[0].n)).toBe(0);
    // A manager without billing.approve cannot approve; the Administrator can, within the accepted minutes.
    await expectPgError(q(w.ownerA, "select ogevia_api.approve_visit_for_billing($1, 46, null, null)", [v.visit]), "OGV22", /between 0 and the billable minutes \(45\)/);
    const approval = (await q(w.ownerA, "select ogevia_api.approve_visit_for_billing($1, 45, null, null) id", [v.visit]))[0].id;
    expect((await db.admin.query("select approved_minutes, billable_minutes_at_approval, source_snapshot->>'lateAcceptedMinutes' late from ogevia.billing_approvals where id = $1", [approval])).rows[0])
      .toEqual({ approved_minutes: 45, billable_minutes_at_approval: 45, late: "45" });
    // While approved, the acceptance cannot be revoked.
    const decision = (await reviewRow(w.managerA, v.visit)).decision_id;
    await expectPgError(q(w.managerA, "select ogevia_api.revoke_visit_review_decision($1, 'Synthetic', null)", [decision]), "OGC09", /void the approval first/);
  });

  it("accepted minutes are capped by the authorization's remaining time, and flagged", async () => {
    const v = await noSignerVisit(45, 30);
    const r = await request(w.managerA, v.visit);
    const res = await respond(r.link!);
    expect(await review(w.managerA, res.late_confirmation_id, "accepted")).toMatchObject({ accepted_minutes: 30, capped_by_authorization: true });
    expect(await usage(v.lineage, v.visit)).toBe(30);
  });

  it("a dispute can never be accepted; recording it as reviewed returns the visit to Needs attention with nothing billable", async () => {
    const v = await noSignerVisit();
    const r = await request(w.managerA, v.visit);
    await expectPgError(respond(r.link!, { outcome: "disputed", dispute: "" }), "OGV22", /Describe what is wrong/);
    const res = await respond(r.link!, { outcome: "disputed", dispute: "The caregiver left an hour early (synthetic)" });
    await expectPgError(review(w.managerA, res.late_confirmation_id, "accepted"), "OGC09", /cannot be accepted/);
    await review(w.managerA, res.late_confirmation_id, "rejected", "Dispute noted; correcting the times (synthetic)");
    expect(await reviewRow(w.managerA, v.visit)).toMatchObject({ recovery_state: null, allowed_decisions: ["close_not_billable"], can_request_confirmation: true });
    expect(await billingRow(v.visit)).toMatchObject({ review_state: "needs_review", eligible_minutes: 0 });
    await expectPgError(review(w.managerA, res.late_confirmation_id, "rejected"), "OGC09", /already reviewed/);
  });

  it("a confirmation of the visit as it was cannot be accepted after the visit was corrected", async () => {
    const v = await noSignerVisit(60);
    const r = await request(w.managerA, v.visit);
    const res = await respond(r.link!);
    const t = (await db.admin.query("select time_in, time_out from ogevia.service_visits where id = $1", [v.visit])).rows[0];
    await api.correct(db, w.managerA, v.visit, t.time_in, new Date(new Date(t.time_out).getTime() - 15 * 60_000), "Synthetic: left early");
    await expectPgError(review(w.managerA, res.late_confirmation_id, "accepted"), "OGC09", /visit changed after this confirmation/);
  });

  it("a link sent before a correction stops working (void)", async () => {
    const v = await noSignerVisit(60);
    const r = await request(w.managerA, v.visit);
    const t = (await db.admin.query("select time_in, time_out from ogevia.service_visits where id = $1", [v.visit])).rows[0];
    await api.correct(db, w.managerA, v.visit, t.time_in, new Date(new Date(t.time_out).getTime() - 10 * 60_000), "Synthetic: left early");
    expect(await open(r.link!.tokenHash, r.link!.codeHash)).toMatchObject({ status: "unavailable" });
  });

  it("an accepted late confirmation can be revoked before approval; the visit returns to Needs attention", async () => {
    const v = await noSignerVisit(30);
    const r = await request(w.managerA, v.visit);
    const res = await respond(r.link!);
    await review(w.managerA, res.late_confirmation_id, "accepted");
    const decision = (await reviewRow(w.managerA, v.visit)).decision_id;
    await q(w.managerA, "select ogevia_api.revoke_visit_review_decision($1, 'Accepted in error (synthetic)', null)", [decision]);
    expect(await billingRow(v.visit)).toMatchObject({ review_state: "needs_review", eligible_minutes: 0 });
    expect(await usage(v.lineage, v.visit)).toBe(0);
  });
});

describe("paper fallback", () => {
  it("staff record a signed paper form against an open paper request; it is reviewed the same way", async () => {
    const v = await noSignerVisit(40);
    const r = await request(w.managerA, v.visit, { channel: "paper", check: null, link: null, days: 14 });
    const id = randomUUID();
    const today = (await db.admin.query("select ogevia.organization_local_date($1, now())::text d", [w.orgA])).rows[0].d;
    const paper = (key: string, signedOn = today, role = "guardian") => q(w.managerA, "select ogevia_api.record_paper_visit_confirmation($1, $2, $3, $4, $5::date, $6, 'v1', 'application/pdf', 4096, $7, null) id",
      [r.request_id, id, "Synthetic Guardian Lee", role, signedOn, key, "c".repeat(64)]);
    await expectPgError(paper(`${w.orgA}/${id}/client-signature.png`), "OGV22", /Attach the scanned form/);
    await expectPgError(paper(`${w.orgA}/documents/${id}/paper-form`, "2020-01-01"), "OGV22", /between the visit date and today/);
    await expectPgError(q(v.cg, "select ogevia_api.record_paper_visit_confirmation($1, $2, 'X Y', 'guardian', $3::date, $4, 'v1', 'application/pdf', 1, $5, null)",
      [r.request_id, id, today, `${w.orgA}/documents/${id}/paper-form`, "c".repeat(64)]), "OGA03");
    expect((await paper(`${w.orgA}/documents/${id}/paper-form`))[0].id).toBe(id);
    expect(await q(w.managerA, "select object_key, content_type from ogevia_api.get_late_confirmation_evidence($1)", [id])).toEqual([{ object_key: `${w.orgA}/documents/${id}/paper-form`, content_type: "application/pdf" }]);
    expect(await q(w.managerB, "select * from ogevia_api.get_late_confirmation_evidence($1)", [id])).toEqual([]);
    expect(await review(w.managerA, id, "accepted")).toMatchObject({ accepted_minutes: 40 });
  });
});

describe("records and isolation", () => {
  it("requests, responses and reviews are append-only; another agency sees nothing", async () => {
    const v = await noSignerVisit();
    const r = await request(w.managerA, v.visit);
    const res = await respond(r.link!);
    await expectPgError(db.admin.query("update ogevia.visit_late_confirmations set signer_name = 'Changed' where id = $1", [res.late_confirmation_id]), "OGC09");
    await expectPgError(db.admin.query("delete from ogevia.visit_late_confirmations where id = $1", [res.late_confirmation_id]), "OGC09");
    await expectPgError(db.admin.query("update ogevia.visit_confirmation_requests set recipient_name = 'Changed' where id = $1", [r.request_id]), "OGC09");
    await expectPgError(db.admin.query("update ogevia.visit_confirmation_requests set responded_at = now() where id = $1", [r.request_id]), "OGC09");
    expect(await q(w.managerB, "select * from ogevia_api.list_visit_confirmation_requests($1)", [v.visit])).toEqual([]);
    await expectPgError(review(w.managerB, res.late_confirmation_id, "accepted"), "OGN04");
    await expectPgError(q(w.managerB, "select ogevia_api.revoke_visit_confirmation_request($1, 'x y z', null)", [r.request_id]), "OGN04");
    const actions = (await db.admin.query("select action from ogevia.audit_events where entity_id in ($1, $2) order by id", [r.request_id, res.late_confirmation_id])).rows.map((x) => x.action);
    expect(actions).toEqual(["visit.confirmation_requested", "visit.late_confirmation_received"]);
    // No token, code or hash appears in any audit row.
    const leaked = (await db.admin.query("select count(*) n from ogevia.audit_events where (coalesce(before_state::text, '') || coalesce(after_state::text, '')) like '%' || $1 || '%'", [r.link!.tokenHash])).rows[0].n;
    expect(Number(leaked)).toBe(0);
  });
});

describe("rounding covers reviewed visits once approved", () => {
  it("a review-accepted, approved visit is rounded and no longer counts as open for its day", async () => {
    const v = await noSignerVisit(50, 6000);
    const payer = (await db.admin.query("select payer from ogevia.client_authorizations where id = $1", [v.auth])).rows[0].payer;
    await q(w.ownerA, "select * from ogevia_api.set_billing_rounding_policy($1, $2, $3, 'up', 15, 'per_visit', 'Synthetic payer manual 9.9', '2026-01-15', '2026-01-01', 'Synthetic', null)", [w.orgA, payer, v.service]);
    const r = await request(w.managerA, v.visit);
    const res = await respond(r.link!);
    await review(w.managerA, res.late_confirmation_id, "accepted");
    await q(w.ownerA, "select ogevia_api.approve_visit_for_billing($1, 50, null, null)", [v.visit]);
    const d = (await db.admin.query("select service_date::text d from ogevia.service_visits where id = $1", [v.visit])).rows[0].d;
    const row = (await q(w.managerA, "select * from ogevia_api.list_billing_rounding_preview($1, $2::date, $2::date)", [w.orgA, d])).find((x) => x.visit_id === v.visit);
    expect(row).toMatchObject({ state: "ready_to_approve", approved_minutes: 50, proposed_minutes: 60 });
  });
});

describe("rollback", () => {
  it("rollback 0036 refuses while recovery records exist", async () => {
    const run = async (file: string) => {
      const c = await db.admin.connect();
      try {
        await c.query("begin");
        await c.query("set local role ogevia_owner");
        await c.query(readFileSync(new URL(`../rollback/${file}`, import.meta.url), "utf8"));
      } finally {
        await c.query("rollback");
        c.release();
      }
    };
    await expectPgError(run("0036_signature_recovery.down.sql"), "P0001", /ROLLBACK REFUSED: missing-signature recovery records exist/);
  });
});
