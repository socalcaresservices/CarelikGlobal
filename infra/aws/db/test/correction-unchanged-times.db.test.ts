// 0018: a correction keeps a time the manager left unchanged exactly as
// stored (seconds and microseconds), while a changed time is stored as given.
// SYNTHETIC data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  createTestDb,
  freshClient,
  seedWorld,
  signedVisit,
  type TestDb,
  type World,
} from "./harness.js";

let db: TestDb;
let w: World;

/**
 * Gives a visit microsecond-precise times, as the server clock records them.
 * Time Out moves to second 12 of the PREVIOUS minute so it is never in the
 * future (a correction refuses a future Time Out), whatever second the test
 * runs at. Uses one dedicated connection so the trigger bypass applies to the
 * update itself (a pooled query could run on another connection).
 */
async function withMicroseconds(visit: string) {
  const c = await db.admin.connect();
  try {
    await c.query("set session_replication_role = replica");
    await c.query(
      `update ogevia.service_visits
          set time_in = date_trunc('minute', time_in) + interval '37.123456 seconds',
              time_out = date_trunc('minute', time_out) - interval '1 minute' + interval '12.654321 seconds'
        where id = $1`,
      [visit],
    );
  } finally {
    await c.query("reset session_replication_role");
    c.release();
  }
  return (
    await db.admin.query<{ time_in: Date; time_out: Date; in_text: string; out_text: string }>(
      "select time_in, time_out, time_in::text as in_text, time_out::text as out_text from ogevia.service_visits where id = $1",
      [visit],
    )
  ).rows[0]!;
}

const textOf = async (id: string) =>
  (
    await db.admin.query<{ in_text: string; out_text: string }>(
      "select time_in::text as in_text, time_out::text as out_text from ogevia.service_visits where id = $1",
      [id],
    )
  ).rows[0]!;

describe("0018 corrections keep unchanged times exactly", () => {
  beforeAll(async () => {
    db = await createTestDb();
    w = await seedWorld(db, 6000);
  });
  afterAll(async () => db?.drop());

  it("keeps an unchanged Time In to the microsecond when only Time Out is corrected", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 6000);
    const { visit } = await signedVisit(db, w.caregiverA1, w, 60, w.orgA, f.client, f.service);
    const original = await withMicroseconds(visit);
    // What the API hands the browser: a JS Date (millisecond precision).
    expect(original.time_in.getMilliseconds()).toBe(123);
    const laterOut = new Date(original.time_out.getTime() - 10 * 60_000);
    laterOut.setSeconds(0, 0);

    const revised = await api.correct(db, w.managerA, visit, original.time_in, laterOut, "Left earlier (synthetic)");
    const after = await textOf(revised);
    expect(after.in_text).toBe(original.in_text);
    expect(after.in_text).toMatch(/:37\.123456/);
    expect(new Date(after.out_text).getTime()).toBe(laterOut.getTime());

    const audit = (
      await db.admin.query(
        "select before_snapshot->>'timeIn' as before_in, after_snapshot->>'timeIn' as after_in from ogevia.visit_corrections where corrected_visit_id = $1",
        [revised],
      )
    ).rows[0];
    expect(audit.after_in).toBe(audit.before_in);
  });

  it("keeps an unchanged Time Out, and stores a changed Time In as given (no snapping)", async () => {
    // A different caregiver, so this visit cannot overlap the first test's.
    const f = await freshClient(db, w, w.caregiverA2, 6000);
    const { visit } = await signedVisit(db, w.caregiverA2, w, 90, w.orgA, f.client, f.service);
    const original = await withMicroseconds(visit);
    const laterIn = new Date(original.time_in.getTime() + 5 * 60_000);
    laterIn.setSeconds(0, 0);

    const revised = await api.correct(db, w.managerA, visit, laterIn, original.time_out, "Arrived later (synthetic)");
    const after = await textOf(revised);
    expect(after.out_text).toBe(original.out_text);
    expect(new Date(after.in_text).getTime()).toBe(laterIn.getTime());
    expect(after.in_text).not.toMatch(/\.\d/);
  });
});
