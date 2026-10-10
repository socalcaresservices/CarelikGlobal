// Rollback 0039 on a POPULATED database keeps the approved hours and archives the request history. SYNTHETIC data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../scripts/migrations.js";
import { asActor, createTestDb, orgToday, seedWorld, setBaselineAvailability, type TestDb, type World } from "./harness.js";

const DIR = new URL("../rollback/", import.meta.url);
let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
});
afterAll(async () => db?.drop());

async function runDown(file: string) {
  const client = await db.admin.connect();
  try {
    await client.query("begin");
    await client.query("set local role ogevia_owner");
    await client.query(readFileSync(new URL(file, DIR), "utf8"));
    await client.query("reset role");
    await client.query("delete from ogevia_meta.schema_migrations where version = $1", [file.slice(0, 4)]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

describe("rollback 0039 keeps data", () => {
  it("keeps today's approved hours as plain rows, archives requests and exceptions, and the migration can be re-applied", async () => {
    const today = await orgToday(db);
    const rec = await setBaselineAvailability(db, w.orgA, w.caregiverA1, [{ weekday: 1, start_local: "08:00", end_local: "20:00" }]);
    const dow = (await db.admin.query("select extract(dow from $1::date)::int d", [today])).rows[0].d as number;
    const ask = (kind: string, windows: unknown[], from: string, until: string | null, base: number, reason: string) =>
      asActor(db, w.caregiverA1.sub, async (c) => (await c.query("select ogevia_api.request_availability_change($1,$2,$3::jsonb,$4::date,$5::date,$6,$7,null) as id", [w.orgA, kind, JSON.stringify(windows), from, until, reason, base])).rows[0].id as string);
    const ok = (id: string) => asActor(db, w.ownerA.sub, (c) => c.query("select ogevia_api.review_availability_request($1,$2,'approve','ok')", [w.orgA, id]));
    // Today's weekly layer: this weekday 09:00-17:00 (replaces the baseline). A future date marked unavailable.
    await ok(await ask("weekly", [{ weekday: dow, start_local: "09:00", end_local: "17:00" }], today, null, 0, "New hours"));
    const future = (await db.admin.query("select to_char($1::date + 20, 'YYYY-MM-DD') d", [today])).rows[0].d as string;
    await ok(await ask("date", [], future, null, 1, "Away"));
    const pendingId = await ask("weekly", [{ weekday: dow, start_local: "10:00", end_local: "11:00" }], today, null, 2, "Still deciding");

    await runDown("0039_availability_approval.down.sql");

    // Plain legacy rows: today's layer and the future exception.
    const windows = (await db.admin.query("select weekday, start_local::text s, end_local::text e from ogevia.caregiver_availability_windows where caregiver_record_id = $1 order by weekday", [rec])).rows;
    expect(windows).toEqual([{ weekday: dow, s: "09:00:00", e: "17:00:00" }]);
    const off = (await db.admin.query("select unavailable_date::text d from ogevia.caregiver_unavailable_dates where caregiver_record_id = $1", [rec])).rows;
    expect(off).toEqual([{ d: future }]);
    // The history is archived, including the request that was still pending.
    const archived = (await db.admin.query("select table_name from information_schema.tables where table_schema = 'ogevia' and table_name like 'archived_%_0039_%' order by 1")).rows.map((r) => r.table_name.replace(/_\d{14}$/, ""));
    expect(archived).toEqual(["archived_availability_requests_0039", "archived_caregiver_availability_state_0039", "archived_caregiver_availability_windows_0039", "archived_caregiver_unavailable_dates_0039"]);
    const arch = (await db.admin.query("select table_name from information_schema.tables where table_schema = 'ogevia' and table_name like 'archived_availability_requests_0039_%'")).rows[0].table_name;
    const rows = (await db.admin.query(`select id, status::text s from ogevia.${arch} order by requested_at`)).rows;
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.id === pendingId)!.s).toBe("pending");
    // Old behaviour is back: matching reads plain rows; the old direct function works again.
    expect((await db.admin.query("select to_regprocedure('ogevia_api.request_availability_change(uuid,text,jsonb,date,date,text,integer,uuid)') p")).rows[0].p).toBeNull();
    // Re-applying 0039 works and starts a fresh history over the plain rows.
    const client = await db.admin.connect();
    try { expect((await migrate(client)).applied).toEqual(["0039_availability_approval.sql"]); } finally { client.release(); }
    const state = await asActor(db, w.caregiverA1.sub, async (c) => (await c.query("select ogevia_api.get_availability($1,null) as r", [w.orgA])).rows[0].r);
    expect(state.weekly).toEqual([{ weekday: dow, start_local: "09:00", end_local: "17:00" }]);
    expect(state.exceptions).toHaveLength(1);
  });
});
