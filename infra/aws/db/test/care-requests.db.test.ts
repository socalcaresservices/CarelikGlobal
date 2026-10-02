import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, freshClient, seedWorld, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const token = () => randomBytes(32).toString("base64url");

async function publicCall<T>(sql: string, params: unknown[]): Promise<T> {
  const c = await db.admin.connect();
  try {
    await c.query("begin");
    await c.query("set local role ogevia_app");
    const result = await c.query(sql, params);
    await c.query("commit");
    return result.rows as T;
  } catch (error) {
    await c.query("rollback");
    throw error;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db);
});
afterAll(async () => db?.drop());

describe("care request / caregiver availability workflow", () => {
  it("client link -> request -> caregiver accepts -> agency assigns -> client sees confirmation -> client cancels", async () => {
    const fresh = await freshClient(db, w, w.caregiverA1, 600, w.orgA, { before: 1, after: 10 });
    const clientToken = token();
    const clientHash = hash(clientToken);

    await asActor(db, w.managerA.sub, async (c) => {
      await c.query("select ogevia_api.create_client_request_link($1,$2,$3,null)", [w.orgA, fresh.client, clientHash]);
    });

    const rawStored = await db.admin.query(
      "select count(*)::int as n from ogevia.client_request_links where token_hash = $1",
      [clientToken],
    );
    expect(rawStored.rows[0].n).toBe(0);

    const context = await publicCall<Array<{ organization_name: string; services: Array<{ serviceId: string }> }>>(
      "select * from ogevia_api.public_request_link_context($1)",
      [clientHash],
    );
    expect(context).toHaveLength(1);
    expect(context[0]!.services.some((s) => s.serviceId === fresh.service)).toBe(true);

    const start = new Date(Date.now() + 2 * 60 * 60_000);
    const end = new Date(start.getTime() + 4 * 60 * 60_000);
    const idem = randomUUID();
    const createSql = "select ogevia_api.public_create_care_request($1,$2,$3,$4,$5,$6) as id";
    const first = await publicCall<Array<{ id: string }>>(createSql, [clientHash, fresh.service, start, end, "Synthetic request", idem]);
    const replay = await publicCall<Array<{ id: string }>>(createSql, [clientHash, fresh.service, start, end, "Synthetic request", idem]);
    const requestId = first[0]!.id;
    expect(replay[0]!.id).toBe(requestId);

    const caregiverA1 = (await db.admin.query<{ id: string }>(
      "select id from ogevia.caregiver_records where organization_id=$1 and linked_user_id=$2",
      [w.orgA, w.caregiverA1.userId],
    )).rows[0]!.id;
    const caregiverA2 = (await db.admin.query<{ id: string }>(
      "select id from ogevia.caregiver_records where organization_id=$1 and linked_user_id=$2",
      [w.orgA, w.caregiverA2.userId],
    )).rows[0]!.id;

    const candidates = await asActor(db, w.schedulerA.sub, async (c) =>
      (await c.query("select * from ogevia_api.list_care_request_candidates($1)", [requestId])).rows,
    );
    expect(candidates[0].caregiver_record_id).toBe(caregiverA1);
    expect(candidates[0].priority_score).toBe(100);

    const offer1Token = token();
    const offer2Token = token();
    const expires = new Date(Date.now() + 24 * 60 * 60_000);
    await asActor(db, w.schedulerA.sub, async (c) => {
      await c.query("select ogevia_api.create_care_request_offer($1,$2,$3,$4)", [requestId, caregiverA1, hash(offer1Token), expires]);
      await c.query("select ogevia_api.create_care_request_offer($1,$2,$3,$4)", [requestId, caregiverA2, hash(offer2Token), expires]);
    });

    const my = await asActor(db, w.caregiverA1.sub, async (c) =>
      (await c.query("select * from ogevia_api.list_my_care_opportunities($1)", [w.orgA])).rows,
    );
    expect(my.some((row) => row.request_id === requestId && row.offer_status === "pending")).toBe(true);

    const response = await publicCall<Array<{ status: string }>>(
      "select ogevia_api.public_respond_care_offer($1,true) as status",
      [hash(offer1Token)],
    );
    expect(response[0]!.status).toBe("available");

    const shiftId = await asActor(db, w.schedulerA.sub, async (c) =>
      (await c.query<{ id: string }>("select ogevia_api.assign_care_request($1,$2) as id", [requestId, caregiverA1])).rows[0]!.id,
    );
    const assigned = await db.admin.query(
      "select status, assigned_shift_id, assigned_caregiver_record_id from ogevia.care_requests where id=$1",
      [requestId],
    );
    expect(assigned.rows[0]).toMatchObject({ status: "assigned", assigned_shift_id: shiftId, assigned_caregiver_record_id: caregiverA1 });

    const offers = await db.admin.query(
      "select caregiver_record_id, status from ogevia.care_request_offers where care_request_id=$1 order by caregiver_record_id",
      [requestId],
    );
    expect(offers.rows.find((r) => r.caregiver_record_id === caregiverA1)?.status).toBe("assigned");
    expect(offers.rows.find((r) => r.caregiver_record_id === caregiverA2)?.status).toBe("not_selected");

    const confirmed = await publicCall<Array<{ requests: Array<{ requestId: string; status: string; caregiverName: string | null }> }>>(
      "select * from ogevia_api.public_request_link_context($1)",
      [clientHash],
    );
    expect(confirmed[0]!.requests.find((r) => r.requestId === requestId)).toMatchObject({ status: "assigned" });
    expect(confirmed[0]!.requests.find((r) => r.requestId === requestId)?.caregiverName).toBeTruthy();

    await publicCall("select ogevia_api.public_cancel_care_request($1,$2,$3)", [clientHash, requestId, "Plans changed"]);
    expect((await db.admin.query("select status from ogevia.care_requests where id=$1", [requestId])).rows[0].status).toBe("cancelled");
    expect((await db.admin.query("select status from ogevia.shifts where id=$1", [shiftId])).rows[0].status).toBe("cancelled");
  });

  it("does not let another tenant manage a care request", async () => {
    const request = await db.admin.query<{ id: string }>(
      "select id from ogevia.care_requests where organization_id=$1 limit 1",
      [w.orgA],
    );
    await expect(
      asActor(db, w.managerB.sub, async (c) => c.query("select * from ogevia_api.list_care_request_candidates($1)", [request.rows[0]!.id])),
    ).rejects.toMatchObject({ code: "OGA03" });
  });

  it("requires explicit caregiver acceptance when offers exist", async () => {
    const fresh = await freshClient(db, w, w.caregiverA1, 600, w.orgA, { before: 1, after: 10 });
    const start = new Date(Date.now() + 3 * 60 * 60_000);
    const end = new Date(start.getTime() + 2 * 60 * 60_000);
    const requestId = (await db.admin.query<{ id: string }>(
      "insert into ogevia.care_requests (organization_id,client_id,service_id,requested_start,requested_end,source) values ($1,$2,$3,$4,$5,'staff') returning id",
      [w.orgA, fresh.client, fresh.service, start, end],
    )).rows[0]!.id;
    const caregiver = (await db.admin.query<{ id: string }>(
      "select id from ogevia.caregiver_records where organization_id=$1 and linked_user_id=$2",
      [w.orgA, w.caregiverA1.userId],
    )).rows[0]!.id;
    await asActor(db, w.schedulerA.sub, async (c) => {
      await c.query("select ogevia_api.create_care_request_offer($1,$2,$3,$4)", [requestId, caregiver, hash(token()), new Date(Date.now() + 86_400_000)]);
    });
    await expect(
      asActor(db, w.schedulerA.sub, async (c) => c.query("select ogevia_api.assign_care_request($1,$2)", [requestId, caregiver])),
    ).rejects.toMatchObject({ code: "OGC09" });
  });
});
