// 0125 (PENDING): the Authorization Worklist. SYNTHETIC data only. Applies every pending migration (offices 0110-0111 are needed for the office filter), then 0125.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, signedVisit, type Actor, type TestDb, type World } from "./harness.js";

const PENDING = new URL("../pending/migrations/", import.meta.url);
const DOWN = new URL("../pending/rollback/0125_authorization_worklist.down.sql", import.meta.url);
let db: TestDb; let w: World;
const run = async (sql: string) => { const c = await db.admin.connect(); try { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(sql); await c.query("reset role"); await c.query("commit"); } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); } };
const call = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const worklist = (a: Actor, o: { client?: string | null; office?: string | null; program?: string | null; status?: string | null; days?: number; pct?: number; from?: string | null; to?: string | null; org?: string } = {}) =>
  call(a, "select * from ogevia_api.list_authorization_worklist($1,null,$2,$3,$4,$5,$6,$7,$8,$9)", [o.org ?? w.orgA, o.client ?? null, o.office ?? null, o.program ?? null, o.status ?? null, o.days ?? 30, o.pct ?? 85, o.from ?? null, o.to ?? null]);
const row = (rows: any[], client: string) => rows.find((r) => r.client_id === client);

beforeAll(async () => {
  db = await createTestDb({ includeLiveTest: true });
  w = await seedWorld(db, 1400);
  for (const f of readdirSync(PENDING).filter((x) => x.endsWith(".sql")).sort()) await run(readFileSync(new URL(f, PENDING), "utf8"));
}, 240_000);
afterAll(async () => db?.drop());

describe("0125 authorization worklist", () => {
  it("classifies missing, expired, expiring, exhausted, nearly exhausted and ok, with authorized, used, scheduled and remaining minutes", async () => {
    const ok = await freshClient(db, w, w.caregiverA1, 600, w.orgA, { before: 20, after: 100 }); await signedVisit(db, w.caregiverA1, w, 30, w.orgA, ok.client, ok.service);
    const near = await freshClient(db, w, w.caregiverA1, 60, w.orgA, { before: 20, after: 100 }); await signedVisit(db, w.caregiverA1, w, 55, w.orgA, near.client, near.service);
    const gone = await freshClient(db, w, w.caregiverA1, 30, w.orgA, { before: 20, after: 100 }); await signedVisit(db, w.caregiverA1, w, 30, w.orgA, gone.client, gone.service);
    const expired = await freshClient(db, w, w.caregiverA1, 300, w.orgA, { before: 60, after: -5 });
    const expiring = await freshClient(db, w, w.caregiverA1, 300, w.orgA, { before: 20, after: 10 });
    // a client with an active assignment and no authorization at all
    const missing = (await db.admin.query("insert into ogevia.clients (organization_id) values ($1) returning id", [w.orgA])).rows[0].id as string;
    const c = await db.admin.connect();
    try { await c.query("set session_replication_role = replica"); await c.query("insert into ogevia.caregiver_assignments (organization_id, caregiver_user_id, client_id, service_id, effective_start) values ($1,$2,$3,$4,$5::date)", [w.orgA, w.caregiverA1.userId, missing, w.serviceA, await orgToday(db)]); }
    finally { await c.query("reset session_replication_role"); c.release(); }
    const rows = await worklist(w.managerA);
    expect(row(rows, ok.client), JSON.stringify(row(rows, ok.client))).toMatchObject({ status: "ok", authorized_minutes: 600, used_minutes: 30, remaining_minutes: 570, percent_committed: 5 });
    expect(row(rows, near.client)).toMatchObject({ status: "nearly_exhausted", authorized_minutes: 60, used_minutes: 55, remaining_minutes: 5, percent_committed: 92 });
    expect(row(rows, gone.client)).toMatchObject({ status: "exhausted", authorized_minutes: 30, used_minutes: 30, remaining_minutes: 0 });
    expect(row(rows, expired.client)).toMatchObject({ status: "expired", days_to_expiry: -5 });
    expect(row(rows, expiring.client)).toMatchObject({ status: "expiring", days_to_expiry: 10 });
    expect(row(rows, missing)).toMatchObject({ status: "missing", authorization_id: null, authorized_minutes: null });
    expect(row(rows, ok.client).program).toBe("SYNTHETIC-PAYER");
    // worst first: missing, expired, exhausted, expiring, nearly exhausted, ok
    const order = rows.map((r: any) => r.status); const rank = ["missing", "expired", "exhausted", "expiring", "nearly_exhausted", "ok"];
    expect(order.map((s: string) => rank.indexOf(s))).toEqual([...order.map((s: string) => rank.indexOf(s))].sort((a, b) => a - b));
    // filters
    expect((await worklist(w.managerA, { status: "missing" })).every((r: any) => r.status === "missing")).toBe(true);
    const attention = await worklist(w.managerA, { status: "attention" });
    expect(attention.some((r: any) => r.status === "ok")).toBe(false);
    expect(row(attention, near.client)).toBeDefined();
    expect((await worklist(w.managerA, { client: near.client })).map((r: any) => r.client_id)).toEqual([near.client]);
    expect(await worklist(w.managerA, { program: "NOT-A-PROGRAM" })).toEqual([]);
    expect((await worklist(w.managerA, { days: 5 })).find((r: any) => r.client_id === expiring.client)?.status).toBe("ok");        // 10 days away is outside a 5-day window
    expect((await worklist(w.managerA, { pct: 99 })).find((r: any) => r.client_id === near.client)?.status).toBe("ok");
    // date filter: the window starts tomorrow, so the authorization that ended 5 days ago no longer covers it: the assigned client is MISSING one for that window, not expired
    const tomorrow = (await db.admin.query("select to_char((now() at time zone 'America/Los_Angeles')::date + 1, 'YYYY-MM-DD') d")).rows[0].d;
    expect(row(await worklist(w.managerA, { from: tomorrow }), expired.client)).toMatchObject({ status: "missing" });
  });

  it("a renewed authorization is not reported as expired, and nothing here returns a client name", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 300, w.orgA, { before: 60, after: -5 });
    // the same client and service get a newer current authorization that still runs
    await db.admin.query(
      `insert into ogevia.client_authorizations (organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end, lineage_id, version_number, is_current)
       select organization_id, client_id, service_id, 'SYNTHETIC-PAYER', 300, current_date - 4, current_date + 90, gen_random_uuid(), 1, true from ogevia.client_authorizations where id = $1`, [f.auth]).catch(async () => {
      const id = randomUUID();
      await db.admin.query(`insert into ogevia.client_authorizations (id, organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end, lineage_id) values ($1,$2,$3,$4,'SYNTHETIC-PAYER',300,current_date - 4,current_date + 90,$1)`, [id, w.orgA, f.client, f.service]);
    });
    const mine = (await worklist(w.managerA, { client: f.client }));
    expect(mine.some((r: any) => r.status === "expired")).toBe(false);
    expect(Object.keys(mine[0] ?? {}).join()).not.toMatch(/client_name|legal|first_name|last_name|dob|address/i);
  });

  it("offices: the worklist can be limited to one office (the client's primary office)", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 300);
    const north = (await call(w.ownerA, "select ogevia_api.create_office($1,'North Office',null) as id", [w.orgA]))[0].id;
    const south = (await call(w.ownerA, "select ogevia_api.create_office($1,'South Office',null) as id", [w.orgA]))[0].id;
    await call(w.managerA, "select ogevia_api.set_client_office($1,$2,$3)", [w.orgA, f.client, north]);
    expect(row(await worklist(w.managerA, { office: north }), f.client)).toMatchObject({ office_name: "North Office" });
    expect(row(await worklist(w.managerA, { office: south }), f.client)).toBeUndefined();
  });

  it("only people who may read authorizations see it, only their own agency; limits and statuses are validated", async () => {
    await expectPgError(worklist(w.caregiverA1), "OGA03");
    await expectPgError(worklist(w.managerB), "OGN04".replace("OGN04", "OGN04") as any).catch(async () => expectPgError(worklist(w.managerB), "OGA03"));
    await expectPgError(worklist(w.managerA, { status: "bogus" }), "OGV22");
    await expectPgError(worklist(w.managerA, { days: 0 }), "OGV22");
    await expectPgError(worklist(w.managerA, { pct: 100 }), "OGV22");
    await expectPgError(worklist(w.managerA, { from: "2026-12-31", to: "2026-01-01" }), "OGV22");
    expect((await worklist(w.schedulerA)).length).toBeGreaterThan(0);                                     // authorizations.read is enough
    expect((await worklist(w.managerB, { org: w.orgB })).every((r: any) => r.client_id !== w.clientA1)).toBe(true);
  });

  it("rolls back cleanly and applies again", async () => {
    await run(readFileSync(DOWN, "utf8"));
    expect((await db.admin.query("select to_regprocedure('ogevia_api.list_authorization_worklist(uuid,date,uuid,uuid,text,text,integer,integer,date,date)') p")).rows[0].p).toBeNull();
    await run(readFileSync(new URL("0125_authorization_worklist.sql", PENDING), "utf8"));
  });
});
