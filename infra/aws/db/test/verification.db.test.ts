import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  createTestDb,
  endedVisit,
  freshClient,
  seedWorld,
  signedVisit,
  type TestDb,
  type World,
} from "./harness.js";

const DIR = new URL("../verification/", import.meta.url);
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db);
  // Representative synthetic activity: signed, review, corrected, amended.
  const f = await freshClient(db, w, w.caregiverA3, 600, w.orgA, {
    before: 10,
    after: 10,
  });
  const { visit } = await signedVisit(
    db,
    w.caregiverA3,
    w,
    30,
    w.orgA,
    f.client,
    f.service,
  );
  const t = new Date(Date.now() - 48 * 3600_000);
  await api.correct(
    db,
    w.managerA,
    visit,
    t,
    new Date(t.getTime() + 40 * 60_000),
    "Synthetic correction",
  );
  const review = await endedVisit(
    db,
    w.caregiverA3,
    w,
    20,
    w.orgA,
    f.client,
    f.service,
  );
  await api.confirm(db, w.caregiverA3, review, {
    method: "unable_to_confirm",
    reason: "No signer",
  });
  await api.amend(db, w.managerA, f.auth, 30);
  await signedVisit(db, w.caregiverB1, w, 25, w.orgB, w.clientB1, w.serviceB);
});
afterAll(async () => db?.drop());

describe("VERIFICATION scripts (read-only, as ogevia_readonly)", () => {
  it.each(files)(
    "%s passes every check in a READ ONLY transaction",
    async (file) => {
      const client = await db.admin.connect();
      try {
        await client.query("begin transaction read only");
        await client.query("set local role ogevia_readonly");
        const { rows } = await client.query<{
          check_name: string;
          ok: boolean;
          detail: string | null;
        }>(readFileSync(new URL(file, DIR), "utf8"));
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.filter((r) => !r.ok)).toEqual([]);
      } finally {
        await client.query("rollback");
        client.release();
      }
    },
  );

  it("contains no data-modifying statements", () => {
    for (const file of files) {
      const sql = readFileSync(new URL(file, DIR), "utf8").replace(
        /--.*$/gm,
        "",
      );
      expect(sql, file).not.toMatch(
        /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy)\b/i,
      );
    }
  });

  it("detects a seeded violation (negative control)", async () => {
    const client = await db.admin.connect();
    try {
      await client.query("begin");
      // Simulate migrated legacy data: an overlapping CURRENT authorization.
      await client.query(
        "alter table ogevia.client_authorizations drop constraint client_authorizations_one_current_per_coverage",
      );
      await client.query(
        `insert into ogevia.client_authorizations (organization_id, client_id, service_id, payer, monthly_authorized_minutes, period_start, period_end)
         select organization_id, client_id, service_id, 'DUP', 1, period_start, period_end
         from ogevia.client_authorizations where id = $1`,
        [w.authA1],
      );
      const { rows } = await client.query(
        readFileSync(new URL("06_authorization_invariants.sql", DIR), "utf8"),
      );
      expect(
        rows.find(
          (r) => r.check_name === "no_overlapping_current_authorizations",
        )?.ok,
      ).toBe(false);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
