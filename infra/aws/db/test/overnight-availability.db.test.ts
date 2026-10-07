// 0037 Overnight caregiver availability. SYNTHETIC data only. Every care request is inserted with fixed
// agency-local dates (not "today"), so the suite gives the same answer whenever it runs.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let fresh: { client: string; service: string; auth: string };
const LA = "America/Los_Angeles";
type Win = { weekday?: number; date?: string; start: string; end: string };

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  fresh = await freshClient(db, w, w.caregiverA1, 6000, w.orgA, { before: 4000, after: 4000 });
});
afterAll(async () => db?.drop());

const recordOf = async (a: Actor) =>
  (await db.admin.query<{ id: string }>("select id from ogevia.caregiver_records where linked_user_id = $1", [a.userId])).rows[0]!.id;

async function setWindows(a: Actor, windows: Win[], unavailable: string[] = []) {
  const id = await recordOf(a);
  await db.admin.query("delete from ogevia.caregiver_availability_windows where caregiver_record_id = $1", [id]);
  await db.admin.query("delete from ogevia.caregiver_unavailable_dates where caregiver_record_id = $1", [id]);
  for (const x of windows) {
    await db.admin.query(
      "insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, specific_date, start_local, end_local) values ($1,$2,$3,$4,$5,$6)",
      [w.orgA, id, x.date ? null : x.weekday, x.date ?? null, x.start, x.end],
    );
  }
  for (const d of unavailable) {
    await db.admin.query("insert into ogevia.caregiver_unavailable_dates(organization_id, caregiver_record_id, unavailable_date) values ($1,$2,$3)", [w.orgA, id, d]);
  }
}

/** A care request from an agency-local start to an agency-local end ("YYYY-MM-DD HH:MM"). */
async function request(startLocal: string, endLocal: string, tz = LA): Promise<string> {
  const r = await db.admin.query<{ id: string }>(
    `insert into ogevia.care_requests(organization_id, client_id, service_id, authorization_lineage_id, starts_at, ends_at, requested_minutes, request_key)
     values ($1,$2,$3,$4, $5::timestamp at time zone $7::text, $6::timestamp at time zone $7::text, 180, gen_random_uuid()) returning id`,
    [w.orgA, fresh.client, fresh.service, fresh.auth, startLocal, endLocal, tz],
  );
  return r.rows[0]!.id;
}

async function matches(requestId: string, actor: Actor = w.managerA, org = w.orgA): Promise<string[]> {
  const rows = await asActor(db, actor.sub, async (c) =>
    (await c.query<{ caregiver_record_id: string }>("select * from ogevia_api.list_available_caregivers($1,$2)", [org, requestId])).rows,
  );
  const a1 = await recordOf(w.caregiverA1);
  const a2 = await recordOf(w.caregiverA2);
  return rows.map((x) => (x.caregiver_record_id === a1 ? "A1" : x.caregiver_record_id === a2 ? "A2" : "other")).sort();
}
const A1_ONLY = ["A1"];
const NOBODY: string[] = [];

describe("window shape", () => {
  it("accepts an overnight window and a daytime window; refuses equal start and end", async () => {
    const id = await recordOf(w.caregiverA1);
    const ins = (s: string, e: string) =>
      db.admin.query("insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, start_local, end_local) values ($1,$2,1,$3,$4)", [w.orgA, id, s, e]);
    await ins("22:00", "06:00");
    await ins("08:00", "17:00");
    await ins("20:00", "00:00"); // until midnight is also "ends the next day at 00:00"
    await expectPgError(ins("09:00", "09:00"), "23514", /availability_time/);
    await setWindows(w.caregiverA1, []);
  });

  it("a caregiver can save an overnight window through the application function, and read it back", async () => {
    await setWindows(w.caregiverA1, []);
    await asActor(db, w.caregiverA1.sub, (c) =>
      c.query("select ogevia_api.replace_my_availability($1,$2::jsonb,'[]'::jsonb)", [
        w.orgA, JSON.stringify([{ weekday: 6, specific_date: null, start_local: "22:00", end_local: "06:00" }]),
      ]),
    );
    const back = await asActor(db, w.caregiverA1.sub, async (c) =>
      (await c.query("select weekday, start_local::text s, end_local::text e from ogevia_api.get_my_availability($1)", [w.orgA])).rows,
    );
    expect(back).toEqual([{ weekday: 6, s: "22:00:00", e: "06:00:00" }]);
    await setWindows(w.caregiverA1, []);
  });

  it("the fixed dates used below fall on the weekdays the tests assume", async () => {
    const r = await db.admin.query<{ d: string; dow: number }>(
      "select d::text, extract(dow from d::date)::int dow from unnest(array['2026-10-12','2026-10-17','2026-10-18','2026-10-31','2026-11-01','2026-03-07','2026-12-31']) d",
    );
    expect(Object.fromEntries(r.rows.map((x) => [x.d, x.dow]))).toEqual({
      "2026-10-12": 1, "2026-10-17": 6, "2026-10-18": 0, "2026-10-31": 6, "2026-11-01": 0, "2026-03-07": 6, "2026-12-31": 4,
    });
  });
});

describe("daytime and weekend availability is preserved", () => {
  it("a request inside one day's window matches; outside it, or touching neither edge, does not; the edges are inclusive", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 1, start: "08:00", end: "20:00" }]);
    expect(await matches(await request("2026-10-12 10:00", "2026-10-12 14:00"))).toEqual(A1_ONLY);
    expect(await matches(await request("2026-10-12 08:00", "2026-10-12 20:00"))).toEqual(A1_ONLY);
    expect(await matches(await request("2026-10-12 07:00", "2026-10-12 11:00"))).toEqual(NOBODY);
    expect(await matches(await request("2026-10-12 18:00", "2026-10-12 21:00"))).toEqual(NOBODY);
    expect(await matches(await request("2026-10-13 10:00", "2026-10-13 14:00"))).toEqual(NOBODY); // Tuesday: no window
  });

  it("weekend days (0 and 6) and date-specific windows work as before", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 6, start: "09:00", end: "17:00" }, { weekday: 0, start: "09:00", end: "17:00" }, { date: "2026-10-14", start: "10:00", end: "16:00" }]);
    expect(await matches(await request("2026-10-17 10:00", "2026-10-17 14:00"))).toEqual(A1_ONLY);
    expect(await matches(await request("2026-10-18 10:00", "2026-10-18 14:00"))).toEqual(A1_ONLY);
    expect(await matches(await request("2026-10-14 11:00", "2026-10-14 15:00"))).toEqual(A1_ONLY);
    expect(await matches(await request("2026-10-14 08:00", "2026-10-14 12:00"))).toEqual(NOBODY);
  });

  it("the source label is date-specific when a window exists for that very date, otherwise recurring", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 3, start: "08:00", end: "20:00" }, { date: "2026-10-14", start: "08:00", end: "20:00" }]);
    const dated = await request("2026-10-14 10:00", "2026-10-14 14:00");
    const rows = await asActor(db, w.managerA.sub, async (c) => (await c.query("select availability_source s from ogevia_api.list_available_caregivers($1,$2)", [w.orgA, dated])).rows);
    expect(rows).toEqual([{ s: "date-specific" }]);
    await setWindows(w.caregiverA1, [{ weekday: 3, start: "08:00", end: "20:00" }]);
    const rec = await asActor(db, w.managerA.sub, async (c) => (await c.query("select availability_source s from ogevia_api.list_available_caregivers($1,$2)", [w.orgA, dated])).rows);
    expect(rec).toEqual([{ s: "recurring" }]);
  });
});

describe("overnight matching", () => {
  it("a Monday 22:00 to 06:00 window covers a Monday night request that stays inside it", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 1, start: "22:00", end: "06:00" }]);
    expect(await matches(await request("2026-10-12 22:00", "2026-10-13 06:00"))).toEqual(A1_ONLY);
    expect(await matches(await request("2026-10-12 23:00", "2026-10-13 05:00"))).toEqual(A1_ONLY);
  });

  it("does not match a request that starts before the window, ends after it, or runs the wrong night", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 1, start: "22:00", end: "06:00" }]);
    expect(await matches(await request("2026-10-12 21:00", "2026-10-13 02:00"))).toEqual(NOBODY);
    expect(await matches(await request("2026-10-12 22:00", "2026-10-13 07:00"))).toEqual(NOBODY);
    expect(await matches(await request("2026-10-13 22:00", "2026-10-14 06:00"))).toEqual(NOBODY); // Tuesday night: no window
    expect(await matches(await request("2026-10-11 22:00", "2026-10-12 06:00"))).toEqual(NOBODY); // Sunday night
  });

  it("the part of the night after midnight belongs to the window that began the evening before", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 1, start: "22:00", end: "06:00" }]);
    expect(await matches(await request("2026-10-13 01:00", "2026-10-13 04:00"))).toEqual(A1_ONLY); // Tuesday small hours
    expect(await matches(await request("2026-10-13 05:00", "2026-10-13 08:00"))).toEqual(NOBODY); // runs past 06:00
  });

  it("a daytime window does not cover a request that runs past midnight (the old matcher said it did)", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 1, start: "08:00", end: "20:00" }]);
    expect(await matches(await request("2026-10-12 19:00", "2026-10-13 02:00"))).toEqual(NOBODY);
  });

  it("a window that ends at midnight (20:00 to 00:00) covers an evening request ending at 00:00", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 1, start: "20:00", end: "00:00" }]);
    expect(await matches(await request("2026-10-12 20:00", "2026-10-13 00:00"))).toEqual(A1_ONLY);
    expect(await matches(await request("2026-10-12 21:00", "2026-10-13 01:00"))).toEqual(NOBODY);
  });

  it("a date-specific overnight window runs from that date into the next", async () => {
    await setWindows(w.caregiverA1, [{ date: "2026-10-20", start: "22:00", end: "06:00" }]);
    expect(await matches(await request("2026-10-20 23:00", "2026-10-21 05:00"))).toEqual(A1_ONLY);
    expect(await matches(await request("2026-10-21 23:00", "2026-10-22 05:00"))).toEqual(NOBODY);
  });
});

describe("weekday, month and year boundaries", () => {
  it("Saturday night runs into Sunday (6 to 0) and Sunday night into Monday (0 to 1)", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 6, start: "22:00", end: "06:00" }, { weekday: 0, start: "22:00", end: "06:00" }]);
    expect(await matches(await request("2026-10-17 23:00", "2026-10-18 05:00"))).toEqual(A1_ONLY);
    expect(await matches(await request("2026-10-18 23:00", "2026-10-19 05:00"))).toEqual(A1_ONLY);
    // Friday night has no window, even though Saturday's runs into Sunday
    expect(await matches(await request("2026-10-16 23:00", "2026-10-17 05:00"))).toEqual(NOBODY);
  });

  it("a Saturday-only overnight window does not cover a Sunday-night request", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 6, start: "22:00", end: "06:00" }]);
    expect(await matches(await request("2026-10-18 22:00", "2026-10-19 02:00"))).toEqual(NOBODY);
  });

  it("works across a month end and a year end", async () => {
    await setWindows(w.caregiverA1, [{ date: "2026-12-31", start: "22:00", end: "06:00" }]);
    expect(await matches(await request("2026-12-31 23:00", "2027-01-01 05:00"))).toEqual(A1_ONLY);
    await setWindows(w.caregiverA1, [{ date: "2026-10-31", start: "22:00", end: "06:00" }]);
    expect(await matches(await request("2026-10-31 22:30", "2026-11-01 00:30"))).toEqual(A1_ONLY);
  });
});

describe("overlapping and adjacent windows", () => {
  it("overlapping windows on the same day are merged: together they cover what neither does alone", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 1, start: "08:00", end: "14:00" }, { weekday: 1, start: "12:00", end: "20:00" }]);
    expect(await matches(await request("2026-10-12 10:00", "2026-10-12 18:00"))).toEqual(A1_ONLY);
    expect(await matches(await request("2026-10-12 10:00", "2026-10-12 21:00"))).toEqual(NOBODY);
  });

  it("adjacent windows join, but a gap does not", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 1, start: "08:00", end: "12:00" }, { weekday: 1, start: "12:00", end: "17:00" }]);
    expect(await matches(await request("2026-10-12 11:00", "2026-10-12 14:00"))).toEqual(A1_ONLY);
    await setWindows(w.caregiverA1, [{ weekday: 1, start: "08:00", end: "12:00" }, { weekday: 1, start: "13:00", end: "17:00" }]);
    expect(await matches(await request("2026-10-12 11:00", "2026-10-12 14:00"))).toEqual(NOBODY);
  });

  it("an overnight window followed by a morning window on the next day covers the whole stretch", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 1, start: "22:00", end: "06:00" }, { weekday: 2, start: "06:00", end: "12:00" }]);
    expect(await matches(await request("2026-10-12 23:00", "2026-10-13 10:00"))).toEqual(A1_ONLY);
  });

  it("a duplicate window changes nothing", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 1, start: "08:00", end: "20:00" }, { weekday: 1, start: "08:00", end: "20:00" }]);
    expect(await matches(await request("2026-10-12 09:00", "2026-10-12 13:00"))).toEqual(A1_ONLY);
  });
});

describe("dates marked unavailable", () => {
  it("block every date the request touches, and only those", async () => {
    const win: Win[] = [{ weekday: 1, start: "22:00", end: "06:00" }];
    const night = () => request("2026-10-12 22:00", "2026-10-13 06:00");
    await setWindows(w.caregiverA1, win, ["2026-10-12"]);
    expect(await matches(await night())).toEqual(NOBODY);
    await setWindows(w.caregiverA1, win, ["2026-10-13"]);
    expect(await matches(await night())).toEqual(NOBODY);
    await setWindows(w.caregiverA1, win, ["2026-10-14"]);
    expect(await matches(await night())).toEqual(A1_ONLY);
  });

  it("a request that ends exactly at midnight does not touch the next date", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 1, start: "20:00", end: "00:00" }], ["2026-10-13"]);
    expect(await matches(await request("2026-10-12 20:00", "2026-10-13 00:00"))).toEqual(A1_ONLY);
  });

  it("a daytime request is excluded only on its own unavailable date, as before", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 1, start: "08:00", end: "20:00" }], ["2026-10-12"]);
    expect(await matches(await request("2026-10-12 10:00", "2026-10-12 14:00"))).toEqual(NOBODY);
    expect(await matches(await request("2026-10-19 10:00", "2026-10-19 14:00"))).toEqual(A1_ONLY);
  });
});

describe("agency time zone and daylight saving", () => {
  it("windows are read in the agency's own time zone, not the database's or the request's", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 1, start: "22:00", end: "06:00" }]);
    // The same wall-clock night, expressed as instants in New York, matches only once the agency is in New York.
    const ny = await request("2026-10-12 22:00", "2026-10-13 06:00", "America/New_York");
    expect(await matches(ny)).toEqual(NOBODY); // agency is still Los Angeles: that is 19:00 to 03:00 there
    await db.admin.query("update ogevia.organizations set timezone = 'America/New_York' where id = $1", [w.orgA]);
    expect(await matches(ny)).toEqual(A1_ONLY);
    expect(await matches(await request("2026-10-12 22:00", "2026-10-13 06:00", LA))).toEqual(NOBODY); // 01:00 to 09:00 in New York
    await db.admin.query("update ogevia.organizations set timezone = 'America/Los_Angeles' where id = $1", [w.orgA]);
  });

  it("a night with the extra hour (fall back, 2026-11-01) is covered; the request's real length is used", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 6, start: "22:00", end: "06:00" }]);
    expect(await matches(await request("2026-10-31 22:00", "2026-11-01 06:00"))).toEqual(A1_ONLY); // 9 real hours
    expect(await matches(await request("2026-10-31 23:00", "2026-11-01 05:00"))).toEqual(A1_ONLY);
    expect(await matches(await request("2026-10-31 22:00", "2026-11-01 06:30"))).toEqual(NOBODY);
  });

  it("a night with a missing hour (spring forward, 2026-03-08) is covered; one minute over is not", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 6, start: "22:00", end: "06:00" }]);
    expect(await matches(await request("2026-03-07 22:00", "2026-03-08 06:00"))).toEqual(A1_ONLY); // 7 real hours
    expect(await matches(await request("2026-03-07 22:00", "2026-03-08 06:01"))).toEqual(NOBODY);
  });

  it("a Honolulu agency (no daylight saving) reads the same window in its own zone", async () => {
    await db.admin.query("update ogevia.organizations set timezone = 'Pacific/Honolulu' where id = $1", [w.orgA]);
    await setWindows(w.caregiverA1, [{ weekday: 1, start: "22:00", end: "06:00" }]);
    expect(await matches(await request("2026-10-12 22:00", "2026-10-13 06:00", "Pacific/Honolulu"))).toEqual(A1_ONLY);
    await db.admin.query("update ogevia.organizations set timezone = 'America/Los_Angeles' where id = $1", [w.orgA]);
  });
});

describe("everything else in matching is unchanged", () => {
  it("a caregiver with a shift that overlaps the request is excluded; a declined offer excludes; other agencies and caregivers see nothing", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 1, start: "22:00", end: "06:00" }]);
    const id = await request("2026-10-12 22:00", "2026-10-13 06:00");
    expect(await matches(id)).toEqual(A1_ONLY);
    // A caregiver cannot list candidates; another agency's manager cannot read this agency's request.
    expect(await matches(id, w.caregiverA1)).toEqual(NOBODY);
    expect(await matches(id, w.managerB, w.orgB)).toEqual(NOBODY);
    // A declined offer excludes the caregiver.
    const a1 = await recordOf(w.caregiverA1);
    await db.admin.query(
      "insert into ogevia.care_request_offers(organization_id, care_request_id, caregiver_record_id, token_hash, status) values ($1,$2,$3,encode(sha256(gen_random_uuid()::text::bytea),'hex'),'not_available')",
      [w.orgA, id, a1],
    );
    expect(await matches(id)).toEqual(NOBODY);
  });

  it("the helper function is not callable by the application role", async () => {
    await expect(
      asActor(db, w.managerA.sub, (c) => c.query("select ogevia.availability_covers($1,$2,'America/Los_Angeles',now(),now() + interval '4 hours',current_date,current_date)", [w.orgA, w.orgA])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("rollback", () => {
  const down = readFileSync(new URL("../rollback/0037_overnight_availability.down.sql", import.meta.url), "utf8");
  it("refuses while an overnight window exists, and a refusal changes nothing", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 1, start: "22:00", end: "06:00" }]);
    const client = await db.admin.connect();
    try {
      await client.query("begin");
      await client.query("set local role ogevia_owner");
      await expect(client.query(down)).rejects.toThrow(/ROLLBACK REFUSED: overnight availability windows exist/);
      await client.query("rollback");
    } finally {
      client.release();
    }
    expect((await db.admin.query("select count(*)::int n from ogevia.caregiver_availability_windows where end_local < start_local")).rows[0].n).toBe(1);
    expect(await matches(await request("2026-10-12 22:00", "2026-10-13 06:00"))).toEqual(A1_ONLY);
  });

  it("with no overnight window it restores the 0011 constraint and matcher, and daytime matching still works", async () => {
    await setWindows(w.caregiverA1, [{ weekday: 1, start: "08:00", end: "20:00" }]);
    const client = await db.admin.connect();
    try {
      await client.query("begin");
      await client.query("set local role ogevia_owner");
      await client.query(down);
      await client.query("reset role");
      // Inside the same transaction: the old rules are back.
      const id = (await client.query("select id from ogevia.care_requests limit 1")).rows[0].id as string;
      await client.query("savepoint s");
      await expect(client.query("insert into ogevia.caregiver_availability_windows(organization_id, caregiver_record_id, weekday, start_local, end_local) select $1, id, 1, '22:00','06:00' from ogevia.caregiver_records limit 1", [w.orgA])).rejects.toThrow(/availability_time/);
      await client.query("rollback to savepoint s");
      const fn = await client.query("select pg_get_functiondef('ogevia_api.list_available_caregivers(uuid,uuid)'::regprocedure) d");
      expect(fn.rows[0].d).toContain("w.start_local<=q.local_start");
      expect(fn.rows[0].d).not.toContain("availability_covers");
      expect((await client.query("select to_regprocedure('ogevia.availability_covers(uuid,uuid,text,timestamptz,timestamptz,date,date)') p")).rows[0].p).toBeNull();
      expect(id).toBeTruthy();
      await client.query("rollback"); // leave the database as it was
    } finally {
      client.release();
    }
  });
});
