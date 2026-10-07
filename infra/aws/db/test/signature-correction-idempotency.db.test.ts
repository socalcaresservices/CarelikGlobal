import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ageVisit,
  api,
  asActor,
  createTestDb,
  endedVisit,
  expectPgError,
  freshClient,
  seedWorld,
  signedVisit,
  visitRow,
  type TestDb,
  type World,
} from "./harness.js";

let db: TestDb;
let w: World;
beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db);
});
afterAll(async () => db?.drop());

const confirmation = async (visit: string) =>
  (
    await db.admin.query(
      "select * from ogevia.visit_confirmations where visit_id = $1",
      [visit],
    )
  ).rows[0] as Record<string, unknown>;

describe("SIGNATURE: confirmation methods, signer roles, evidence metadata", () => {
  it.each(["client", "parent", "guardian", "authorized_representative"])(
    "accepts signer role %s",
    async (role) => {
      const f = await freshClient(db, w, w.caregiverA1, 600);
      const visit = await endedVisit(
        db,
        w.caregiverA1,
        w,
        20,
        w.orgA,
        f.client,
        f.service,
      );
      const ev = await api.registerEvidence(db, w.caregiverA1, w.orgA, visit);
      expect(
        (await api.confirm(db, w.caregiverA1, visit, { evidence: ev, role }))
          .status,
      ).toBe("signed");
      expect((await confirmation(visit)).signer_role).toBe(role);
    },
  );

  it("rejects an invalid signer role and an invalid method", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const visit = await endedVisit(
      db,
      w.caregiverA1,
      w,
      20,
      w.orgA,
      f.client,
      f.service,
    );
    await expectPgError(
      api.confirm(db, w.caregiverA1, visit, {
        method: "unable_to_confirm",
        reason: "x",
        role: "neighbor",
      }),
      "22P02",
    );
    await expectPgError(
      api.confirm(db, w.caregiverA1, visit, { method: "thumbprint" }),
      "OGV22",
    );
    await api.confirm(db, w.caregiverA1, visit, {
      method: "unable_to_confirm",
      reason: "cleanup",
    });
  });

  it("stores S3 metadata only, bound to the visit's UUID-only key, and links it to the confirmation", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const visit = await endedVisit(
      db,
      w.caregiverA1,
      w,
      25,
      w.orgA,
      f.client,
      f.service,
    );
    const ev = await api.registerEvidence(
      db,
      w.caregiverA1,
      w.orgA,
      visit,
      null,
      "B".repeat(64),
    );
    await api.confirm(db, w.caregiverA1, visit, { evidence: ev });
    const row = (
      await db.admin.query(
        "select * from ogevia.visit_evidence where id = $1",
        [ev],
      )
    ).rows[0];
    expect(row).toMatchObject({
      object_key: `${w.orgA}/${visit}/client-signature.png`,
      content_type: "image/png",
      byte_size: 2048,
      sha256_hex: "b".repeat(64),
      storage_provider: "s3",
      evidence_type: "client_signature",
      registered_by: w.caregiverA1.userId,
      object_version_id: "v1",
    });
    expect((await confirmation(visit)).evidence_id).toBe(ev);
  });

  it("rejects a key for another visit or organization, a non-PNG, oversize, or bad hash", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const visit = await endedVisit(
      db,
      w.caregiverA1,
      w,
      20,
      w.orgA,
      f.client,
      f.service,
    );
    const reg = (
      key: string,
      type = "image/png",
      size = 100,
      sha = "c".repeat(64),
    ) =>
      asActor(db, w.caregiverA1.sub, (c) =>
        c.query(
          "select ogevia_api.register_visit_evidence($1,$2,null,$3,$4,$5)",
          [visit, key, type, size, sha],
        ),
      );
    await expectPgError(
      reg(`${w.orgB}/${visit}/client-signature.png`),
      "OGV22",
    );
    await expectPgError(
      reg(`${w.orgA}/${randomUUID()}/client-signature.png`),
      "OGV22",
    );
    await expectPgError(
      reg(`${w.orgA}/${visit}/client-signature.png`, "image/jpeg"),
      "23514",
    );
    await expectPgError(
      reg(`${w.orgA}/${visit}/client-signature.png`, "image/png", 2_000_000),
      "23514",
    );
    await expectPgError(
      reg(
        `${w.orgA}/${visit}/client-signature.png`,
        "image/png",
        100,
        "not-a-hash",
      ),
      "23514",
    );
    await api.confirm(db, w.caregiverA1, visit, {
      method: "unable_to_confirm",
      reason: "cleanup",
    });
  });

  it("requires evidence for draw/assisted_mark and only the latest upload counts", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const visit = await endedVisit(
      db,
      w.caregiverA1,
      w,
      20,
      w.orgA,
      f.client,
      f.service,
    );
    await expectPgError(
      api.confirm(db, w.caregiverA1, visit, { method: "draw" }),
      "OGV22",
      /signature or mark/,
    );
    const first = await api.registerEvidence(
      db,
      w.caregiverA1,
      w.orgA,
      visit,
      null,
      "1".repeat(64),
    );
    const second = await api.registerEvidence(
      db,
      w.caregiverA1,
      w.orgA,
      visit,
      null,
      "2".repeat(64),
    );
    await expectPgError(
      api.confirm(db, w.caregiverA1, visit, {
        method: "assisted_mark",
        evidence: first,
      }),
      "OGV22",
    );
    expect(
      (
        await api.confirm(db, w.caregiverA1, visit, {
          method: "assisted_mark",
          evidence: second,
        })
      ).status,
    ).toBe("signed");
  });

  it("a manager cannot manufacture a confirmation for a caregiver's visit", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const visit = await endedVisit(
      db,
      w.caregiverA1,
      w,
      20,
      w.orgA,
      f.client,
      f.service,
    );
    await expectPgError(
      api.confirm(db, w.managerA, visit, {
        method: "unable_to_confirm",
        reason: "x",
      }),
      "OGA03",
    );
    await expectPgError(
      api.registerEvidence(db, w.managerA, w.orgA, visit),
      "OGA03",
    );
    await api.confirm(db, w.caregiverA1, visit, {
      method: "unable_to_confirm",
      reason: "cleanup",
    });
  });
});

describe("SIGNED VISIT immutability", () => {
  it("rejects a duplicate confirmation and any later evidence (no silent signature replacement)", async () => {
    const { visit, evidence } = await signedVisit(db, w.caregiverA1, w, 30);
    await expectPgError(
      api.confirm(db, w.caregiverA1, visit, { evidence }),
      "OGC09",
      /already locked/,
    );
    await expectPgError(
      api.registerEvidence(db, w.caregiverA1, w.orgA, visit),
      "OGC09",
    );
    const { rows } = await db.admin.query(
      "select count(*)::int as n from ogevia.visit_confirmations where visit_id = $1",
      [visit],
    );
    expect(rows[0].n).toBe(1);
  });

  it("rejects direct mutation of a signed visit, its confirmation, and its evidence - even by the owner", async () => {
    const { visit, evidence } = await signedVisit(db, w.caregiverA1, w, 30);
    for (const sql of [
      "update ogevia.service_visits set billable_minutes = 0 where id = $1",
      "update ogevia.service_visits set status = 'administrator_review' where id = $1",
      "update ogevia.service_visits set time_out = time_out + interval '1 hour' where id = $1",
      "delete from ogevia.service_visits where id = $1",
      "update ogevia.visit_confirmations set signer_role = 'guardian' where visit_id = $1",
      "delete from ogevia.visit_confirmations where visit_id = $1",
    ]) {
      await expectPgError(db.admin.query(sql, [visit]), "OGC09");
    }
    await expectPgError(
      db.admin.query(
        "update ogevia.visit_evidence set sha256_hex = $2 where id = $1",
        [evidence, "0".repeat(64)],
      ),
      "OGC09",
    );
    await expectPgError(
      db.admin.query("delete from ogevia.visit_evidence where id = $1", [
        evidence,
      ]),
      "OGC09",
    );
    expect((await visitRow(db, visit)).status).toBe("signed");
  });

  it("keeps audit events append-only", async () => {
    await expectPgError(
      db.admin.query("update ogevia.audit_events set action = 'x'"),
      "OGC09",
    );
    await expectPgError(
      db.admin.query("delete from ogevia.audit_events"),
      "OGC09",
    );
  });
});

describe("NO-SIGNER / administrator review", () => {
  it.each([
    ["unable_to_confirm", { reason: "Client asleep; guardian unavailable" }],
    ["typed", { name: "Synthetic Guardian" }],
    ["verbal", { name: "Synthetic Guardian" }],
  ])(
    "%s goes to administrator_review with zero verified and billable minutes",
    async (method, extra) => {
      const f = await freshClient(db, w, w.caregiverA1, 600);
      const visit = await endedVisit(
        db,
        w.caregiverA1,
        w,
        40,
        w.orgA,
        f.client,
        f.service,
      );
      const r = await api.confirm(db, w.caregiverA1, visit, {
        method,
        ...extra,
      });
      expect(r).toMatchObject({
        status: "administrator_review",
        billable_minutes: 0,
        worked_minutes: 40,
      });
      expect(await visitRow(db, visit)).toMatchObject({
        verified_minutes: 0,
        billable_minutes: 0,
        worked_minutes: 40,
      });
      expect(r.remaining_minutes).toBe("600");
    },
  );

  it("requires a reason for unable_to_confirm and a name for typed/verbal", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const visit = await endedVisit(
      db,
      w.caregiverA1,
      w,
      20,
      w.orgA,
      f.client,
      f.service,
    );
    await expectPgError(
      api.confirm(db, w.caregiverA1, visit, { method: "unable_to_confirm" }),
      "OGV22",
      /Explain why/,
    );
    await expectPgError(
      api.confirm(db, w.caregiverA1, visit, { method: "typed" }),
      "OGV22",
      /Enter the name/,
    );
    await api.confirm(db, w.caregiverA1, visit, {
      method: "unable_to_confirm",
      reason: "cleanup",
    });
  });

  it("a correction of an unconfirmed visit stays in review with zero billable (never silently signed)", async () => {
    const f = await freshClient(db, w, w.caregiverA3, 600, w.orgA, {
      before: 10,
      after: 10,
    });
    const visit = await endedVisit(
      db,
      w.caregiverA3,
      w,
      30,
      w.orgA,
      f.client,
      f.service,
    );
    await api.confirm(db, w.caregiverA3, visit, {
      method: "unable_to_confirm",
      reason: "No signer present",
    });
    const t = new Date(Date.now() - 20 * 3600_000);
    const corrected = await api.correct(
      db,
      w.managerA,
      visit,
      t,
      new Date(t.getTime() + 30 * 60_000),
      "Time fix",
    );
    expect(await visitRow(db, corrected)).toMatchObject({
      status: "administrator_review",
      billable_minutes: 0,
      verified_minutes: 0,
    });
  });
});

describe("CORRECTIONS preserve the original and a full audit trail", () => {
  it("records before/after, actor, timestamp, reason; retains the original as 'corrected'", async () => {
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
    const before = await visitRow(db, visit);
    const t = new Date(Date.now() - 30 * 3600_000);
    const corrected = await api.correct(
      db,
      w.managerA,
      visit,
      t,
      new Date(t.getTime() + 50 * 60_000),
      "Caregiver forgot to clock out",
    );
    const original = await visitRow(db, visit);
    expect(original.status).toBe("corrected");
    expect({ ...original, status: before.status, updated_at: null }).toEqual({
      ...before,
      updated_at: null,
    });
    const row = (
      await db.admin.query(
        "select * from ogevia.visit_corrections where original_visit_id = $1",
        [visit],
      )
    ).rows[0];
    expect(row).toMatchObject({
      corrected_visit_id: corrected,
      corrected_by: w.managerA.userId,
      reason: "Caregiver forgot to clock out",
    });
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.before_snapshot).toMatchObject({
      visitId: visit,
      workedMinutes: 30,
      status: "signed",
    });
    expect(row.after_snapshot).toMatchObject({
      workedMinutes: 50,
      managerCorrected: true,
    });
    expect(await visitRow(db, corrected)).toMatchObject({
      original_visit_id: visit,
      worked_minutes: 50,
      correction_reason: "Caregiver forgot to clock out",
    });
    const audit = (
      await db.admin.query(
        "select * from ogevia.audit_events where entity_id = $1 and action = 'service_visit.corrected'",
        [corrected],
      )
    ).rows[0];
    expect(audit).toMatchObject({
      actor_user_id: w.managerA.userId,
      reason: "Caregiver forgot to clock out",
      organization_id: w.orgA,
    });
    expect(audit.request_id).toBeTruthy();
    const listed = await asActor(
      db,
      w.managerA.sub,
      async (c) =>
        (
          await c.query("select * from ogevia_api.list_visit_corrections($1)", [
            visit,
          ])
        ).rows,
    );
    expect(listed).toHaveLength(1);
  });

  it("allows only one correction per row; the next correction targets the corrected row", async () => {
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
    const t = new Date(Date.now() - 50 * 3600_000);
    const c1 = await api.correct(
      db,
      w.managerA,
      visit,
      t,
      new Date(t.getTime() + 40 * 60_000),
      "First fix",
    );
    await expectPgError(
      api.correct(
        db,
        w.managerA,
        visit,
        t,
        new Date(t.getTime() + 41 * 60_000),
        "Again",
      ),
      "OGC09",
    );
    const c2 = await api.correct(
      db,
      w.managerA,
      c1,
      t,
      new Date(t.getTime() + 45 * 60_000),
      "Second fix",
    );
    expect((await visitRow(db, c2)).original_visit_id).toBe(visit);
  });

  it("requires visits.manage, a reason, a valid duration, and no overlap", async () => {
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
    const t = new Date(Date.now() - 80 * 3600_000);
    await expectPgError(
      api.correct(
        db,
        w.caregiverA3,
        visit,
        t,
        new Date(t.getTime() + 600_000),
        "self-fix",
      ),
      "OGA03",
    );
    await expectPgError(
      api.correct(
        db,
        w.schedulerA,
        visit,
        t,
        new Date(t.getTime() + 600_000),
        "no perm",
      ),
      "OGA03",
    );
    await expectPgError(
      api.correct(
        db,
        w.managerA,
        visit,
        t,
        new Date(t.getTime() + 600_000),
        "  ",
      ),
      "OGV22",
    );
    await expectPgError(
      api.correct(
        db,
        w.managerA,
        visit,
        t,
        new Date(t.getTime() + 25 * 3600_000),
        "too long",
      ),
      "OGV22",
    );
    // A second signed visit for the same caregiver occupies roughly [now-30m, now].
    const other = await signedVisit(
      db,
      w.caregiverA3,
      w,
      30,
      w.orgA,
      f.client,
      f.service,
    );
    const otherIn = (await visitRow(db, other.visit)).time_in as Date;
    await expectPgError(
      api.correct(
        db,
        w.managerA,
        visit,
        new Date(otherIn.getTime() + 60_000),
        new Date(otherIn.getTime() + 5 * 60_000),
        "overlap",
      ),
      "OGC09",
      /overlaps/,
    );
  });
});

describe("IDEMPOTENCY: retries never double-apply", () => {
  it("a repeated start with the same key returns the same visit", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const key = randomUUID();
    const a = await api.start(
      db,
      w.caregiverA1,
      w.orgA,
      f.client,
      f.service,
      key,
    );
    const b = await api.start(
      db,
      w.caregiverA1,
      w.orgA,
      f.client,
      f.service,
      key,
    );
    expect(b).toBe(a);
    const parallel = await Promise.all(
      Array.from({ length: 5 }, () =>
        api.start(db, w.caregiverA1, w.orgA, f.client, f.service, key),
      ),
    );
    expect(new Set(parallel)).toEqual(new Set([a]));
    await expectPgError(
      api.start(db, w.caregiverA1, w.orgA, w.clientA1, w.serviceA, key),
      "OGI09",
    );
    await ageVisit(db, a, 10);
    await api.end(db, w.caregiverA1, a);
    await api.confirm(db, w.caregiverA1, a, {
      method: "unable_to_confirm",
      reason: "cleanup",
    });
  });

  it("a repeated end returns the original server timestamps and changes nothing", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const visit = await api.start(
      db,
      w.caregiverA1,
      w.orgA,
      f.client,
      f.service,
    );
    await ageVisit(db, visit, 33);
    const first = await api.end(db, w.caregiverA1, visit);
    const second = await api.end(db, w.caregiverA1, visit);
    expect(second).toEqual(first);
    const { rows } = await db.admin.query(
      "select count(*)::int as n from ogevia.audit_events where entity_id = $1 and action = 'service_visit.ended'",
      [visit],
    );
    expect(rows[0].n).toBe(1);
    await api.confirm(db, w.caregiverA1, visit, {
      method: "unable_to_confirm",
      reason: "cleanup",
    });
  });

  it("a repeated confirm with the same key returns the stored result; one confirmation, one billing effect", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const visit = await endedVisit(
      db,
      w.caregiverA1,
      w,
      45,
      w.orgA,
      f.client,
      f.service,
    );
    const evidence = await api.registerEvidence(
      db,
      w.caregiverA1,
      w.orgA,
      visit,
      randomUUID(),
    );
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        api.confirm(db, w.caregiverA1, visit, { evidence, key }),
      ),
    );
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0]).toMatchObject({
      status: "signed",
      billable_minutes: 45,
    });
    const counts = (
      await db.admin.query(
        `select (select count(*) from ogevia.visit_confirmations where visit_id = $1)::int as confirmations,
              (select count(*) from ogevia.audit_events where entity_id = $1 and action = 'service_visit.confirmed')::int as audits`,
        [visit],
      )
    ).rows[0];
    expect(counts).toEqual({ confirmations: 1, audits: 1 });
    // A different request reusing the key is refused, not silently answered.
    await expectPgError(
      api.confirm(db, w.caregiverA1, visit, {
        method: "unable_to_confirm",
        reason: "x",
        key,
      }),
      "OGI09",
    );
  });

  it("repeated evidence registration and correction with the same key do not duplicate", async () => {
    const f = await freshClient(db, w, w.caregiverA3, 600, w.orgA, {
      before: 10,
      after: 10,
    });
    const visit = await endedVisit(
      db,
      w.caregiverA3,
      w,
      20,
      w.orgA,
      f.client,
      f.service,
    );
    const ekey = randomUUID();
    const e1 = await api.registerEvidence(
      db,
      w.caregiverA3,
      w.orgA,
      visit,
      ekey,
    );
    const e2 = await api.registerEvidence(
      db,
      w.caregiverA3,
      w.orgA,
      visit,
      ekey,
    );
    expect(e2).toBe(e1);
    await api.confirm(db, w.caregiverA3, visit, { evidence: e1 });
    const ckey = randomUUID();
    const t = new Date(Date.now() - 100 * 3600_000);
    const c1 = await api.correct(
      db,
      w.managerA,
      visit,
      t,
      new Date(t.getTime() + 25 * 60_000),
      "Retry-safe fix",
      ckey,
    );
    const c2 = await api.correct(
      db,
      w.managerA,
      visit,
      t,
      new Date(t.getTime() + 25 * 60_000),
      "Retry-safe fix",
      ckey,
    );
    expect(c2).toBe(c1);
    const { rows } = await db.admin.query(
      "select count(*)::int as n from ogevia.visit_corrections where original_visit_id = $1",
      [visit],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe("BILLING REVIEW contract", () => {
  it("exposes authoritative fields; signed = ready, administrator_review = needs_review; requires billing.visits.read", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 600);
    const signed = (
      await signedVisit(db, w.caregiverA1, w, 30, w.orgA, f.client, f.service)
    ).visit;
    const review = await endedVisit(
      db,
      w.caregiverA1,
      w,
      30,
      w.orgA,
      f.client,
      f.service,
    );
    await api.confirm(db, w.caregiverA1, review, {
      method: "unable_to_confirm",
      reason: "No signer",
    });
    const rows = await asActor(
      db,
      w.managerA.sub,
      async (c) =>
        (
          await c.query(
            "select * from ogevia_api.list_billing_review_visits($1, current_date - 40, current_date + 40)",
            [w.orgA],
          )
        ).rows,
    );
    const byId = new Map(rows.map((r) => [r.visit_id, r]));
    expect(byId.get(signed)).toMatchObject({
      review_state: "ready",
      visit_status: "signed",
      billable_minutes: 30,
      confirmation_method: "draw",
      has_signature_evidence: true,
      is_correction: false,
      authorization_lineage_id: f.auth,
      authorization_version: 1,
    });
    expect(byId.get(signed)!.latest_audit_event_id).toBeTruthy();
    expect(byId.get(review)).toMatchObject({
      review_state: "needs_review",
      billable_minutes: 0,
      has_signature_evidence: false,
    });
    expect(
      await asActor(
        db,
        w.caregiverA1.sub,
        async (c) =>
          (
            await c.query(
              "select * from ogevia_api.list_billing_review_visits($1, current_date - 40, current_date + 40)",
              [w.orgA],
            )
          ).rows,
      ),
    ).toEqual([]);
    expect(
      await asActor(
        db,
        w.schedulerA.sub,
        async (c) =>
          (
            await c.query(
              "select * from ogevia_api.list_billing_review_visits($1, current_date - 40, current_date + 40)",
              [w.orgA],
            )
          ).rows,
      ),
    ).toEqual([]);
  });

  it("never lists draft, awaiting, voided, or superseded (corrected) visits as billable", async () => {
    const rows = await asActor(
      db,
      w.ownerA.sub,
      async (c) =>
        (
          await c.query(
            "select visit_status from ogevia_api.list_billing_review_visits($1, '2000-01-01', '2100-01-01')",
            [w.orgA],
          )
        ).rows,
    );
    expect(new Set(rows.map((r) => r.visit_status))).toEqual(
      new Set(["signed", "administrator_review"]),
    );
  });

  it("audit payloads carry no names, notes, or signature content", async () => {
    const { rows } = await db.admin.query(
      "select concat_ws(' ', before_state::text, after_state::text) as t from ogevia.audit_events",
    );
    for (const r of rows) {
      expect(r.t).not.toMatch(
        /Synthetic|caregiverName|service_notes|typedSignerName|clientCode/,
      );
    }
  });
});
