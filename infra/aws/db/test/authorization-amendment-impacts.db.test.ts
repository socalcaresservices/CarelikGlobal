// 0068: an authorization amendment reports, stores and keeps the reserved shifts (and visits) it affects, and changes none of them (owner request 2026-10-17,
// blocker 3; directive section 8). SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, signedVisit, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
let monthStart: string;
type Fx = { client: string; service: string; auth: string };
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
const as = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const summaryFor = async (f: Fx, month = monthStart) => (await as(w.managerA, "select * from ogevia_api.list_monthly_service_summary($1,$2::date,$3)", [w.orgA, month, f.client]))[0];
const impacts = (all = false, a: Actor = w.managerA, org = w.orgA) => as(a, "select * from ogevia_api.list_authorization_amendment_impacts($1,$2)", [org, all]);
const ack = (a: Actor, id: string, note = "Moved two shifts to next month (synthetic)") => as(a, "select ogevia_api.acknowledge_authorization_amendment_impact($1,$2,$3) r", [w.orgA, id, note]);
async function reserved(f: Fx, startHours: number, minutes: number) {
  const shift = (await q(
    `insert into ogevia.shifts (organization_id, client_id, service_id, starts_at, ends_at, status, authorization_lineage_id)
     select $1,$2,$3, now() + make_interval(hours => $4), now() + make_interval(hours => $4, mins => $5), 'scheduled', a.lineage_id from ogevia.client_authorizations a where a.id = $6 returning id`,
    [w.orgA, f.client, f.service, startHours, minutes, f.auth])).rows[0].id as string;
  await q(`insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
           select $1, a.lineage_id, null, $2, (s.starts_at at time zone 'America/Los_Angeles')::date, $3 from ogevia.client_authorizations a, ogevia.shifts s where a.id = $4 and s.id = $2`,
    [w.orgA, shift, minutes, f.auth]);
  return shift;
}
const state = async (f: Fx) => ({
  reservations: (await q("select r.shift_id, r.released_at, r.release_reason, r.reserved_minutes from ogevia.authorization_reservations r join ogevia.shifts s on s.id = r.shift_id where s.client_id = $1 order by r.shift_id", [f.client])).rows,
  shifts: (await q("select id, status::text from ogevia.shifts where client_id = $1 order by id", [f.client])).rows,
  visits: (await q("select id, status::text, billable_minutes from ogevia.service_visits where client_id = $1 order by id", [f.client])).rows,
});

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
  monthStart = `${today.slice(0, 7)}-01`;
});
afterAll(async () => db?.drop());

describe("a decrease reports the reserved shifts that no longer fit, and changes nothing", () => {
  it("used + time-ordered reservations against the new cap: the later shifts are listed with minutes, kind, and the version; every row is stored", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
    const v = await signedVisit(db, w.caregiverA1, w, 100, w.orgA, f.client, f.service); // 100 used
    const s1 = await reserved(f, 24 + 1, 120), s2 = await reserved(f, 48 + 1, 120), s3 = await reserved(f, 72 + 1, 120), s4 = await reserved(f, 96 + 1, 120);
    // keep all four in the same agency month as the visit for a deterministic split
    await q("update ogevia.authorization_reservations set service_date = $1::date where shift_id in ($2,$3,$4,$5)", [today, s1, s2, s3, s4]);
    const before = await state(f);
    const rows = await api.amend(db, w.managerA, f.auth, 300, "Synthetic: payer lowered the month");
    const shiftRows = rows.filter((r: any) => /reserved_shift/.test(r.impact_kind ?? ""));
    // free = 300 - 100 used = 200: s1 (120) fits; s2 would make 240 > 200, so s2, s3, s4 are reported
    expect(shiftRows.map((r: any) => r.affected_shift_id).sort()).toEqual([s2, s3, s4].sort());
    expect(shiftRows.every((r: any) => r.impact_kind === "reserved_shift_over_cap" && r.impact_minutes === 120)).toBe(true);
    const visitRows = rows.filter((r: any) => r.affected_visit_id);
    expect(visitRows.map((r: any) => [r.affected_visit_id, r.impact_kind])).toEqual([[v.visit, "decrease_now_exceeds"]]);
    expect(await state(f)).toEqual(before); // nothing released, cancelled, re-billed or moved
    // stored: still there when read later, with version and new cap
    const stored = (await impacts()).filter((r) => r.shift_id && [s1, s2, s3, s4].includes(r.shift_id));
    expect(stored).toHaveLength(3);
    expect(stored[0]).toMatchObject({ impact_kind: "reserved_shift_over_cap", new_version_number: 2, new_monthly_minutes: 300, still_applicable: true, acknowledged_at: null, amended_by_name: expect.any(String) });
    expect((await q("select detail from ogevia.authorization_amendment_impacts where shift_id = $1", [s4])).rows[0].detail).toMatchObject({ used_minutes: 100, new_monthly_minutes: 300, bucket: "ahead" });
    expect((await summaryFor(f))).toMatchObject({ authorized_minutes: 300, reserved_minutes: 480, remaining_minutes: -280, over_limit_minutes: 280 }); // 100 + 480 committed, not clamped
  });

  it("acknowledging needs a note, is once, is audited, and keeps the row; an impact stops applying when its shift is released", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
    const s1 = await reserved(f, 25, 120), s2 = await reserved(f, 49, 120);
    await q("update ogevia.authorization_reservations set service_date = $1::date where shift_id in ($2,$3)", [today, s1, s2]);
    await api.amend(db, w.managerA, f.auth, 120, "Synthetic: lowered to one shift");
    const open = (await impacts()).filter((r) => [s1, s2].includes(r.shift_id));
    expect(open.map((r) => r.shift_id)).toEqual([s2]); // s1 fits, s2 does not
    const id = open[0].impact_id;
    await expectPgError(ack(w.managerA, id, "x"), "OGV22", /note/);
    await expectPgError(ack(w.caregiverA1, id), "OGA03");
    await expectPgError(as(w.managerB, "select ogevia_api.acknowledge_authorization_amendment_impact($1,$2,'Checked and handled it') r", [w.orgA, id]), "OGN04");
    expect((await ack(w.managerA, id))[0].r).toMatchObject({ acknowledged: true });
    await expectPgError(ack(w.managerA, id), "OGC09", /already acknowledged/);
    expect((await impacts()).map((r) => r.impact_id)).not.toContain(id);
    const all = (await impacts(true)).find((r) => r.impact_id === id);
    expect(all).toMatchObject({ acknowledgement_note: "Moved two shifts to next month (synthetic)", acknowledged_by_name: expect.any(String) });
    expect((await q("select count(*)::int n from ogevia.audit_events where entity_id = $1 and action = 'authorization_amendment_impact.acknowledged'", [id])).rows[0].n).toBe(1);
    await expect(q("delete from ogevia.authorization_amendment_impact_acks where impact_id = $1", [id])).rejects.toThrow();
    await expect(q("update ogevia.authorization_amendment_impacts set minutes = 1 where id = $1", [id])).rejects.toThrow();
  });

  it("the attention overview counts open, still-applicable impacts and stops counting one whose reservation is gone", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
    const s1 = await reserved(f, 26, 120), s2 = await reserved(f, 50, 120);
    await q("update ogevia.authorization_reservations set service_date = $1::date where shift_id in ($2,$3)", [today, s1, s2]);
    const count = async () => (await as(w.managerA, "select ogevia_api.get_attention_overview($1,48) o", [w.orgA]))[0].o.amendmentImpacts.count as number;
    const base = await count();
    await api.amend(db, w.managerA, f.auth, 120, "Synthetic: lowered");
    expect(await count()).toBe(base + 1);
    await as(w.managerA, "select ogevia_api.cancel_shift($1,$2,'Synthetic: moved out',null)", [w.orgA, s2]); // the person fixes it: the reservation is released
    expect(await count()).toBe(base);
    expect((await as(w.caregiverA1, "select ogevia_api.get_attention_overview($1,48) o", [w.orgA]).catch(() => [{ o: { amendmentImpacts: null } }]))[0].o.amendmentImpacts).toBeNull();
  });

  it("a shortened period reports reserved shifts outside it, separately from over-cap shifts", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
    const inside = await reserved(f, 24, 60), outside = await reserved(f, 24 * 6, 60);
    const rows = await api.amend(db, w.managerA, f.auth, 20000, "Synthetic: payer ended the period early", { start: day(-40), end: day(3) });
    const kinds = Object.fromEntries(rows.filter((r: any) => r.affected_shift_id).map((r: any) => [r.affected_shift_id, r.impact_kind]));
    expect(kinds).toEqual({ [outside]: "reserved_shift_outside_period" });
    expect(kinds[inside]).toBeUndefined();
  });

  it("per month: a lowered cap is applied to each agency month on its own", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
    const a1 = await reserved(f, 24, 120), a2 = await reserved(f, 48, 120);
    const b1 = await reserved(f, 24 * 33, 120), b2 = await reserved(f, 24 * 34, 120);
    const d = async (id: string) => (await q("select service_date::text d from ogevia.authorization_reservations where shift_id = $1", [id])).rows[0].d as string;
    await q("update ogevia.authorization_reservations set service_date = $1::date where shift_id in ($2,$3)", [monthStart, a1, a2]);
    const nextMonth = (await q("select to_char(($1::date + interval '1 month')::date + 4, 'YYYY-MM-DD') d", [monthStart])).rows[0].d as string;
    await q("update ogevia.authorization_reservations set service_date = $1::date where shift_id in ($2,$3)", [nextMonth, b1, b2]);
    void d;
    const rows = await api.amend(db, w.managerA, f.auth, 150, "Synthetic: lowered for every month");
    // each month has 240 reserved against 150: the first shift of each month fits, the second does not
    expect(rows.filter((r: any) => r.affected_shift_id).map((r: any) => r.affected_shift_id).sort()).toEqual([a2, b2].sort());
  });

  it("approved rounding adjustments count as used", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
    const v = await signedVisit(db, w.caregiverA1, w, 60, w.orgA, f.client, f.service);
    const s1 = await reserved(f, 24, 120);
    await q("update ogevia.authorization_reservations set service_date = $1::date where shift_id = $2", [today, s1]);
    const lineage = (await q("select lineage_id from ogevia.client_authorizations where id = $1", [f.auth])).rows[0].lineage_id;
    await q("set session_replication_role = replica");
    const policy = (await q(`insert into ogevia.billing_rounding_policies (organization_id, payer_key, payer_label, service_id, version, method, effective_from, reason, created_by)
       values ($1,'none-am','None (synthetic)',$2,1,'none',$3,'Synthetic fixture',$4) returning id`, [w.orgA, f.service, monthStart, w.ownerA.userId])).rows[0].id;
    await q(`insert into ogevia.billing_rounding_adjustments (organization_id, unit_kind, authorization_lineage_id, client_id, service_id, service_date, policy_id,
         covered_visit_ids, base_minutes, proposed_minutes, adjustment_minutes, capped_by_authorization, approved_by)
       values ($1,'day',$2,$3,$4,$5::date,$6,$7::uuid[],60,90,30,false,$8)`, [w.orgA, lineage, f.client, f.service, today, policy, [v.visit], w.ownerA.userId]);
    await q("set session_replication_role = origin");
    // used = 60 + 30 = 90; cap 200 leaves 110 < 120 reserved: the shift is reported only because the adjustment is counted
    const rows = await api.amend(db, w.managerA, f.auth, 200, "Synthetic: lowered");
    expect(rows.filter((r: any) => r.affected_shift_id).map((r: any) => r.affected_shift_id)).toEqual([s1]);
    expect((await q("select detail from ogevia.authorization_amendment_impacts where shift_id = $1", [s1])).rows[0].detail).toMatchObject({ used_minutes: 90 });
  });
});

describe("increases, history and retries", () => {
  it("an increase reports no reserved shifts; later amendments keep earlier impacts (history is never rewritten)", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 400, w.orgA, { before: 40, after: 200 });
    const s1 = await reserved(f, 24, 120), s2 = await reserved(f, 48, 120), s3 = await reserved(f, 72, 120);
    await q("update ogevia.authorization_reservations set service_date = $1::date where shift_id in ($2,$3,$4)", [today, s1, s2, s3]);
    const up = await api.amend(db, w.managerA, f.auth, 500, "Synthetic: raised");
    expect(up.filter((r: any) => r.affected_shift_id)).toEqual([]);
    const down = await api.amend(db, w.managerA, up[0]!.new_authorization_id, 240, "Synthetic: lowered below the three shifts");
    expect(down.filter((r: any) => r.affected_shift_id).map((r: any) => r.affected_shift_id)).toEqual([s3]);
    const raised = await api.amend(db, w.managerA, down[0]!.new_authorization_id, 900, "Synthetic: raised again");
    expect(raised.filter((r: any) => r.affected_shift_id)).toEqual([]);
    const history = (await impacts(true)).filter((r) => r.shift_id === s3);
    expect(history).toHaveLength(1); // the earlier impact is still on record after the increase
    expect(history[0]).toMatchObject({ new_version_number: 3 });
    expect((await q("select version_number from ogevia.client_authorizations where client_id = $1 order by version_number", [f.client])).rows.map((r) => r.version_number)).toEqual([1, 2, 3, 4]);
  });

  it("a retried amendment (same key) returns the stored impacts and records none twice", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
    const s1 = await reserved(f, 24, 120), s2 = await reserved(f, 48, 120);
    await q("update ogevia.authorization_reservations set service_date = $1::date where shift_id in ($2,$3)", [today, s1, s2]);
    const key = randomUUID();
    const per = (await q("select period_start::text s, period_end::text e from ogevia.client_authorizations where id = $1", [f.auth])).rows[0];
    const call = () => as(w.managerA, "select * from ogevia_api.amend_client_authorization($1,120,$2::date,$3::date,'SYNTHETIC-PAYER','Synthetic retry',null,null,null,$4)", [f.auth, per.s, per.e, key]);
    const first = await call();
    const second = await call();
    expect(second.map((r) => r.impact_id).sort()).toEqual(first.map((r) => r.impact_id).sort());
    expect((await q("select count(*)::int n from ogevia.authorization_amendment_impacts where to_authorization_id = $1", [first[0].new_authorization_id])).rows[0].n).toBe(first.filter((r) => r.impact_id).length);
  });

  it("two amendments at once: one wins, the other is refused as superseded, and impacts are recorded once", async () => {
    for (let round = 0; round < 4; round++) {
      const f = await freshClient(db, w, w.caregiverA1, 20000, w.orgA, { before: 40, after: 200 });
      const s1 = await reserved(f, 24, 120), s2 = await reserved(f, 48, 120);
      await q("update ogevia.authorization_reservations set service_date = $1::date where shift_id in ($2,$3)", [today, s1, s2]);
      const res = await Promise.allSettled([api.amend(db, w.managerA, f.auth, 120, "Synthetic: first"), api.amend(db, w.ownerA, f.auth, 100, "Synthetic: second")]);
      expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of res) if (r.status === "rejected") { expect((r.reason as { code?: string }).code).toBe("OGC09"); }
      const n = (await q("select count(*)::int n from ogevia.authorization_amendment_impacts i join ogevia.client_authorizations a on a.id = i.to_authorization_id where a.client_id = $1 and i.shift_id is not null", [f.client])).rows[0].n;
      const cap = (await q("select monthly_authorized_minutes m from ogevia.client_authorizations where client_id = $1 and is_current", [f.client])).rows[0].m;
      expect(n).toBe(cap === 120 ? 1 : 2); // 2 x 120 reserved: a 120 cap fits one shift, a 100 cap fits none; recorded once, for the winner only
    }
  });
});

describe("who can see them", () => {
  it("managers see their agency's impacts; a caregiver is refused; another agency sees nothing of this agency's", async () => {
    await expectPgError(impacts(false, w.caregiverA1), "OGA03");
    await expectPgError(impacts(false, w.managerB, w.orgA), "OGN04");
    expect((await impacts(true, w.managerB, w.orgB))).toEqual([]);
  });
});
