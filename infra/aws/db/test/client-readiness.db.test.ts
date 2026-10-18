// 0074 Client documents (upload is not approval), readiness stages, service holds, the client's audit timeline, the duplicate-name check and client-document issues (Board 2 decisions 6, 7, 12-16). SYNTHETIC data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, createTestDb, expectPgError, freshClient, orgToday, seedWorld, type Actor, type TestDb, type World } from "./harness.js";

let db: TestDb;
let w: World;
let today: string;
const q = (sql: string, params: unknown[] = []) => db.admin.query(sql, params);
const as = <T = any>(a: Actor, sql: string, params: unknown[] = []) => asActor(db, a.sub, async (c) => (await c.query(sql, params)).rows as any[] as T[]);
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const sha = (n: number) => String(n).padStart(64, "0");

beforeAll(async () => {
  db = await createTestDb();
  w = await seedWorld(db, 600);
  today = await orgToday(db);
});
afterAll(async () => db?.drop());

async function newType(name: string, expiry = false, actor = w.managerA) {
  return (await as(actor, "select ogevia_api.save_client_document_type($1,$2,'consent',$3,true,$4) as id", [w.orgA, name, expiry, randomUUID()]))[0].id as string;
}
async function require_(service: string, type: string, on = true) {
  await as(w.managerA, "select ogevia_api.set_client_document_requirement($1,$2,$3,$4,$5)", [w.orgA, service, type, on, randomUUID()]);
}
/** Requirements belong to the SERVICE, which these tests share: leave only this one. */
async function onlyRequire(service: string, type: string | null) {
  await q("update ogevia.client_document_requirements set removed_at = now() where service_id = $1 and removed_at is null and ($2::uuid is null or document_type_id <> $2)", [service, type]);
  if (type) await require_(service, type);
}
async function upload(actor: Actor, client: string, type: string, n: number, opts: { issued?: string | null; expires?: string | null } = {}) {
  const doc = (await as(actor, "select ogevia_api.ensure_client_document($1,$2,$3) as id", [w.orgA, client, type]))[0].id as string;
  const versionId = randomUUID();
  const r = await as(actor, "select * from ogevia_api.register_client_document_version($1,$2,$3,'s3v','application/pdf',2048,$4,$5,$6,$7)",
    [doc, versionId, `${w.orgA}/client-documents/${doc}/${versionId}`, sha(n), opts.issued ?? null, opts.expires ?? null, randomUUID()]);
  return { doc, versionId, versionNumber: r[0].version_number as number };
}
const docs = (client: string, a: Actor = w.managerA) => as(a, "select * from ogevia_api.list_client_documents($1,$2)", [w.orgA, client]);
const stateOf = async (client: string, type: string) => (await docs(client)).find((d) => d.document_type_id === type)?.state as string | undefined;
const review = (a: Actor, version: string, decision: string, reason: string | null = null) => as(a, "select ogevia_api.review_client_document_version($1,$2,$3,$4) as d", [version, decision, reason, randomUUID()]);
const readiness = (client: string, a: Actor = w.managerA) => as(a, "select ogevia_api.get_client_readiness($1,$2) as r", [w.orgA, client]).then((r) => r[0].r as Record<string, any>);
const reserve = (a: Actor, f: { client: string; service: string }, hoursAhead: number) =>
  as(a, "select * from ogevia_api.create_shift($1,$2,$3,$4::date,$5::time,$6::time,null,null)", [w.orgA, f.client, f.service, day(hoursAhead), "10:00", "11:00"]);

describe("client documents: configured by service, upload is never approval", () => {
  it("only people with documents.manage configure types and requirements; a caregiver cannot even read them; types are unique by name", async () => {
    await expectPgError(as(w.schedulerA, "select ogevia_api.save_client_document_type($1,'X Consent','consent',false,true,null)", [w.orgA]), "OGA03");
    await expectPgError(as(w.caregiverA1, "select * from ogevia_api.list_client_document_types($1)", [w.orgA]), "OGA03");
    await expectPgError(as(w.managerA, "select ogevia_api.save_client_document_type($1,'a','consent',false,true,null)", [w.orgA]), "OGV22");
    await expectPgError(as(w.managerA, "select ogevia_api.save_client_document_type($1,'Good name','nope',false,true,null)", [w.orgA]), "OGV22");
    const a = await newType("Consent to care");
    const b = await newType("  consent TO care ");
    expect(b).toBe(a); // one type per name, ignoring case and spacing
    const f = await freshClient(db, w, w.caregiverA1, 3000, w.orgA, { before: 40, after: 200 });
    await require_(f.service, a);
    const types = await as(w.managerA, "select * from ogevia_api.list_client_document_types($1)", [w.orgA]);
    expect(types.find((t) => t.document_type_id === a).required_for).toEqual([expect.objectContaining({ serviceId: f.service })]);
    await expectPgError(as(w.managerB, "select * from ogevia_api.list_client_document_types($1)", [w.orgA]), "OGN04");
  });

  it("a required document is Missing; an upload is Pending Review and never approved; the uploader cannot approve it; another reviewer can; rejection needs a reason and a new upload starts over", async () => {
    const t = await newType("Service agreement");
    const f = await freshClient(db, w, w.caregiverA1, 3000, w.orgA, { before: 40, after: 200 });
    await require_(f.service, t);
    expect(await stateOf(f.client, t)).toBe("missing");
    const up = await upload(w.managerA, f.client, t, 1);
    expect(up.versionNumber).toBe(1);
    expect(await stateOf(f.client, t)).toBe("pending_review");
    await expectPgError(review(w.managerA, up.versionId, "verified"), "OGA03"); // cannot approve what you uploaded
    await expectPgError(review(w.ownerA, up.versionId, "rejected", null), "OGV22");
    await review(w.ownerA, up.versionId, "rejected", "The signature page is missing (synthetic)");
    expect(await stateOf(f.client, t)).toBe("rejected");
    await expectPgError(review(w.ownerA, up.versionId, "verified"), "OGC09"); // reviewed once
    const up2 = await upload(w.managerA, f.client, t, 2);
    expect(up2.versionNumber).toBe(2);
    expect(await stateOf(f.client, t)).toBe("pending_review");
    await review(w.ownerA, up2.versionId, "verified");
    expect(await stateOf(f.client, t)).toBe("approved");
    expect((await docs(f.client)).find((d) => d.document_type_id === t)).toMatchObject({ version_count: 2, version_number: 2 });
    await expectPgError(q("update ogevia.client_document_versions set sha256 = $1 where id = $2", [sha(9), up2.versionId]), "OGC09");
    await expectPgError(q("delete from ogevia.client_document_versions where id = $1", [up.versionId]), "OGC09");
  });

  it("a retried upload with the same key stores one version; the expiry date is required when the type needs it; a past expiry makes it Expired", async () => {
    const t = await newType("Insurance card", true);
    const f = await freshClient(db, w, w.caregiverA1, 3000, w.orgA, { before: 40, after: 200 });
    await require_(f.service, t);
    const doc = (await as(w.managerA, "select ogevia_api.ensure_client_document($1,$2,$3) as id", [w.orgA, f.client, t]))[0].id as string;
    const vid = randomUUID(), key = randomUUID();
    const reg = (expires: string | null) => as(w.managerA, "select * from ogevia_api.register_client_document_version($1,$2,$3,'s3v','application/pdf',10,$4,$5,$6,$7)", [doc, vid, `${w.orgA}/client-documents/${doc}/${vid}`, sha(5), day(-400), expires, key]);
    await expectPgError(reg(null), "OGV22");
    await expectPgError(as(w.managerA, "select * from ogevia_api.register_client_document_version($1,$2,'wrong/key','s3v','application/pdf',10,$3,null,$4,null)", [doc, randomUUID(), sha(6), day(10)]), "OGV22");
    const a = await reg(day(-1)); const b = await reg(day(-1));
    expect(a[0].version_number).toBe(1); expect(b[0].document_version_id).toBe(a[0].document_version_id);
    expect((await q("select count(*)::int n from ogevia.client_document_versions where document_id = $1", [doc])).rows[0].n).toBe(1);
    await review(w.ownerA, vid, "verified");
    expect(await stateOf(f.client, t)).toBe("expired");
    const replay = await as(w.managerA, "select * from ogevia_api.get_client_document_upload_replay($1,$2)", [doc, key]);
    expect(replay).toHaveLength(1);
  });
});

describe("readiness: draft and pending clients cannot be scheduled; activation needs approved requirements; holds are per service", () => {
  it("draft blocks scheduling by every path (the reservation trigger); activation is refused until the requirement is approved; then the client can be scheduled; the stage is audited", async () => {
    const t = await newType("Intake form");
    const f = await freshClient(db, w, w.caregiverA1, 3000, w.orgA, { before: 40, after: 200 });
    await onlyRequire(f.service, t);
    expect((await readiness(f.client)).stage).toBe("active");
    await as(w.managerA, "select ogevia_api.set_client_preparation($1,$2,'draft','Waiting for the intake form',$3)", [w.orgA, f.client, randomUUID()]);
    expect(await readiness(f.client)).toMatchObject({ stage: "draft", canSchedule: false, ready: false });
    await expectPgError(reserve(w.managerA, f, 3), "OGC09");
    await as(w.managerA, "select ogevia_api.set_client_preparation($1,$2,'pending',null,$3)", [w.orgA, f.client, randomUUID()]);
    expect((await readiness(f.client)).stage).toBe("pending");
    await expectPgError(as(w.managerA, "select ogevia_api.set_client_preparation($1,$2,'active',null,$3)", [w.orgA, f.client, randomUUID()]), "OGC09");
    const up = await upload(w.managerA, f.client, t, 20);
    await expectPgError(as(w.managerA, "select ogevia_api.set_client_preparation($1,$2,'active',null,$3)", [w.orgA, f.client, randomUUID()]), "OGC09"); // pending review is not approved
    await review(w.ownerA, up.versionId, "verified");
    const r = await readiness(f.client);
    expect(r).toMatchObject({ ready: true, services: [expect.objectContaining({ state: "ready", unmet: 0 })] });
    await as(w.managerA, "select ogevia_api.set_client_preparation($1,$2,'active',null,$3)", [w.orgA, f.client, randomUUID()]);
    expect((await readiness(f.client)).stage).toBe("active");
    expect((await reserve(w.managerA, f, 4)).length).toBeGreaterThan(0);
    const audit = (await q("select reason, before_state, after_state from ogevia.audit_events where action = 'client.stage_changed' and entity_id = $1 order by id", [f.client])).rows;
    expect(audit.map((a: any) => a.after_state.stage)).toEqual(["draft", "pending", "active"]);
    await expectPgError(as(w.caregiverA1, "select ogevia_api.set_client_preparation($1,$2,'draft',null,null)", [w.orgA, f.client]), "OGA03");
    await expectPgError(as(w.managerB, "select ogevia_api.get_client_readiness($1,$2)", [w.orgA, f.client]), "OGN04");
  });

  it("a hold on one service blocks new scheduling of that service only, needs a reason and a release note, keeps history, and a retry opens one hold", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 3000, w.orgA, { before: 40, after: 200 });
    const key = randomUUID();
    const open = () => as(w.managerA, "select ogevia_api.open_client_service_hold($1,$2,$3,'The family asked us to pause this service',$4) as id", [w.orgA, f.client, f.service, key]);
    await expectPgError(as(w.managerA, "select ogevia_api.open_client_service_hold($1,$2,$3,'short',null)", [w.orgA, f.client, f.service]), "OGV22");
    const h1 = (await open())[0].id; const h2 = (await open())[0].id;
    expect(h2).toBe(h1);
    await expectPgError(as(w.managerA, "select ogevia_api.open_client_service_hold($1,$2,$3,'Another hold on the same service',null)", [w.orgA, f.client, f.service]), "OGC09");
    expect((await readiness(f.client)).services[0]).toMatchObject({ state: "held", hold: expect.objectContaining({ reason: "The family asked us to pause this service" }) });
    await expectPgError(reserve(w.managerA, f, 5), "OGC09");
    await expectPgError(as(w.managerA, "select ogevia_api.release_client_service_hold($1,$2,'ok',null)", [w.orgA, h1]), "OGV22");
    await expectPgError(as(w.schedulerA, "select ogevia_api.release_client_service_hold($1,$2,'Checked with the family by phone',null)", [w.orgA, h1]), "OGA03");
    await as(w.managerA, "select ogevia_api.release_client_service_hold($1,$2,'Checked with the family by phone',null)", [w.orgA, h1]);
    expect((await reserve(w.managerA, f, 5)).length).toBeGreaterThan(0);
    expect((await q("select released_at is not null as r, release_note from ogevia.client_service_holds where id = $1", [h1])).rows[0]).toMatchObject({ r: true, release_note: "Checked with the family by phone" });
    await expectPgError(as(w.managerA, "select ogevia_api.release_client_service_hold($1,$2,'Releasing it a second time',null)", [w.orgA, h1]), "OGC09");
    await expectPgError(q("delete from ogevia.client_service_holds where id = $1", [h1]), "OGC09");
  });

  it("an expired authorization is reported as such; it is not a stored hold", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 3000, w.orgA, { before: 60, after: -5 });
    expect((await readiness(f.client)).services[0]).toMatchObject({ state: "authorization_expired", authorization: expect.objectContaining({ state: "expired" }) });
    expect((await q("select count(*)::int n from ogevia.client_service_holds where client_id = $1", [f.client])).rows[0].n).toBe(0);
  });
});

describe("the client's audit timeline never shows values", () => {
  it("lists who did what, with field names only; a caregiver is refused; another agency is refused", async () => {
    const f = await freshClient(db, w, w.caregiverA1, 3000, w.orgA, { before: 40, after: 200 });
    await as(w.ownerA, "select ogevia_api.set_client_legal_name($1,$2,'Timeline','Person',null)", [w.orgA, f.client]);
    await as(w.managerA, "select ogevia_api.set_client_preparation($1,$2,'draft','Note for the timeline',null)", [w.orgA, f.client]);
    const rows = await as(w.managerA, "select * from ogevia_api.list_client_audit($1,$2,50)", [w.orgA, f.client]);
    expect(rows.map((r) => r.action)).toContain("client.stage_changed");
    expect(rows.every((r) => r.actor_name)).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/Timeline|Person/); // names never appear
    await expectPgError(as(w.caregiverA1, "select * from ogevia_api.list_client_audit($1,$2,50)", [w.orgA, f.client]), "OGA03");
    await expectPgError(as(w.managerB, "select * from ogevia_api.list_client_audit($1,$2,50)", [w.orgA, f.client]), "OGN04");
  });
});

describe("duplicate-name check", () => {
  it("finds the same name (any case or spacing) and a similar first name with the same last name; excludes the client itself; needs clients.names.read; other agencies are invisible", async () => {
    const a = await freshClient(db, w, w.caregiverA1, 3000, w.orgA, { before: 40, after: 200 });
    const b = await freshClient(db, w, w.caregiverA1, 3000, w.orgA, { before: 40, after: 200 });
    const other = await freshClient(db, w, w.caregiverB1, 3000, w.orgB, { before: 40, after: 200 });
    await as(w.ownerA, "select ogevia_api.set_client_legal_name($1,$2,'Maria Elena','Dup-Garcia',null)", [w.orgA, a.client]);
    await as(w.ownerA, "select ogevia_api.set_client_legal_name($1,$2,'Mariana','Dup-Garcia',null)", [w.orgA, b.client]);
    await as(w.managerB, "select ogevia_api.set_client_legal_name($1,$2,'Maria Elena','Dup-Garcia',null)", [w.orgB, other.client]).catch(() => undefined);
    const find = (first: string, last: string, exclude: string | null = null, actor = w.ownerA) => as(actor, "select * from ogevia_api.find_possible_duplicate_clients($1,$2,$3,$4)", [w.orgA, first, last, exclude]);
    const same = await find("  maria   ELENA ", "dup-garcia");
    expect(same.find((r) => r.client_id === a.client)).toMatchObject({ match: "same_name" });
    expect(same.find((r) => r.client_id === b.client)).toMatchObject({ match: "similar_name" });
    expect(same.some((r) => r.client_id === other.client)).toBe(false);
    expect((await find("Maria Elena", "Dup-Garcia", a.client)).some((r) => r.client_id === a.client)).toBe(false);
    expect(await find("Zed", "Dup-Garcia")).toHaveLength(0);
    expect(await find("", "Dup-Garcia")).toHaveLength(0);
    await expectPgError(find("Maria", "Dup-Garcia", null, w.caregiverA1), "OGA03");
  });
});

describe("client documents in the issue list", () => {
  it("a required, expired document for an active client is Urgent; a pending upload is routine; approving it clears the issue and the resolved history keeps it", async () => {
    const t = await newType("Annual consent", true);
    const f = await freshClient(db, w, w.caregiverA1, 3000, w.orgA, { before: 40, after: 200 });
    await require_(f.service, t);
    const up = await upload(w.managerA, f.client, t, 40, { issued: day(-400), expires: day(-1) });
    const issues = (client: string) => as(w.managerA, "select ogevia_api.list_action_issues($1,null,null,null,$2,null,null,200,0) as r", [w.orgA, client]).then((r) => r[0].r);
    // client filter uses the client id; document issues carry it
    let r = await issues(f.client);
    const pending = r.issues.find((i: any) => i.kind === "client_document");
    expect(pending).toMatchObject({ reason: "awaiting_review", severity: "routine", queue: "documents_compliance", clientId: f.client, action: "review_document" });
    await review(w.ownerA, up.versionId, "verified"); // approved but already past its expiry
    r = await issues(f.client);
    expect(r.issues.find((i: any) => i.kind === "client_document")).toMatchObject({ reason: "expired", severity: "urgent" });
    const up2 = await upload(w.managerA, f.client, t, 41, { issued: day(-1), expires: day(300) });
    await review(w.ownerA, up2.versionId, "verified");
    r = await issues(f.client);
    expect(r.issues.filter((i: any) => i.kind === "client_document")).toHaveLength(0);
    const hist = (await as(w.managerA, "select ogevia_api.get_client_issue_history($1,$2) as h", [w.orgA, f.client]))[0].h;
    expect(hist.resolved.map((x: any) => x.reason)).toEqual(expect.arrayContaining(["awaiting_review", "expired"]));
    await expectPgError(as(w.managerB, "select ogevia_api.get_client_issue_history($1,$2)", [w.orgA, f.client]), "OGN04");
  });
});
