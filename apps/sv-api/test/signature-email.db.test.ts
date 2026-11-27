// Signing-link email through the real handler with a fake sender. SYNTHETIC data only; nothing is sent anywhere.
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, freshClient, seedWorld, type TestDb, type World } from "../../../infra/aws/db/test/harness";
import { createHandler } from "../src/handler";
import { MemoryEvidenceStore } from "../src/evidence";
import { MemoryIdentityAdmin } from "../src/identity";
import type { EmailMessage, EmailResult } from "../src/notify";
import { CONFIG, event } from "./fixtures";

let db: TestDb, w: World;
const sent: EmailMessage[] = [];
let next: Array<EmailResult | "throw"> = [];
const logs: string[] = [];
const send = async (m: EmailMessage): Promise<EmailResult> => { sent.push(m); const n = next.shift(); if (n === "throw") throw new Error("boom"); return n ?? { ok: true, messageId: "m1" }; };
let withEmail: ReturnType<typeof createHandler>, withoutEmail: ReturnType<typeof createHandler>;
beforeAll(async () => {
  vi.stubEnv("OGEVIA_QR_ENCRYPTION_KEY", "e".repeat(64));
  db = await createTestDb({ includeLiveTest: true }); w = await seedWorld(db, 1400);
  const dir = new URL("../../../infra/aws/db/pending/migrations/", import.meta.url);
  const c = await db.admin.connect();
  try { for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) { await c.query("begin"); await c.query("set local role ogevia_owner"); await c.query(readFileSync(new URL(f, dir), "utf8")); await c.query("reset role"); await c.query("commit"); } } finally { c.release(); }
  const common = { config: CONFIG, db: { connect: () => db.admin.connect() }, evidence: new MemoryEvidenceStore(), identity: new MemoryIdentityAdmin(), log: (r: unknown) => logs.push(JSON.stringify(r)) };
  withEmail = createHandler({ ...common, email: { send, appOrigin: "https://app.example.test" } });
  withoutEmail = createHandler(common);
}, 240_000);
afterAll(async () => { vi.unstubAllEnvs(); await db?.drop(); });

const post = async (h: typeof withEmail, visit: string, sub: string, body: Record<string, unknown> = {}, key?: string) => {
  const r = await h(event("POST /v1/visits/{visitId}/signature-link-email", { sub, path: { visitId: visit }, ...(key ? { key } : {}), body: { organizationId: w.orgA, recipientName: "Synthetic Parent", recipientRole: "parent", recipientEmail: "parent@example.test", identityCheck: "Called the number on file", expiresInDays: 7, ...body } }));
  return { status: r.statusCode, body: JSON.parse(r.body || "{}") as any };
};
const events = async (visit: string) => (await db.admin.query("select action, detail from ogevia.visit_signature_events where visit_id = $1 order by id", [visit])).rows;
const requestsOf = async (visit: string) => (await db.admin.query("select id, revoked_at, revoke_reason, responded_at from ogevia.visit_confirmation_requests where visit_id = $1 order by created_at", [visit])).rows;

describe("POST /v1/visits/{visitId}/signature-link-email", () => {
  it("emails only the link (no code), records the delivery without address, link or code, and a resend revokes the earlier link", async () => {
    const visit = await deferredVisit(await freshClient(db, w, w.caregiverA1, 600));
    sent.length = 0;
    const first = await post(withEmail, visit, w.managerA.sub);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ emailSent: true }); expect(first.body.token).toBeUndefined(); expect(first.body.code).toMatch(/^\d{6}$/);   // the staff member reads the code out by phone
    const codeToPhone = first.body.code as string;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "parent@example.test", subject: "Please confirm a care visit" });
    expect(sent[0]!.text).toMatch(/^.*asks you to review and confirm a care visit\./);
    expect(sent[0]!.text).toMatch(/https:\/\/app\.example\.test\/confirm-visit#[0-9a-f]{64}/);
    expect(sent[0]!.text + sent[0]!.html).not.toContain(codeToPhone);
    const ev = await events(visit);
    expect(ev.map((e: any) => e.action)).toEqual(expect.arrayContaining(["request_created", "email_queued"]));
    expect(JSON.stringify(ev)).not.toMatch(/parent@example|confirm-visit|[0-9a-f]{64}/);
    expect(logs.join("\n")).not.toMatch(/parent@example|confirm-visit#/);
    // resend (new key): the open link is revoked first, the new one is open
    const second = await post(withEmail, visit, w.managerA.sub);
    expect(second.status).toBe(201);
    const reqs = await requestsOf(visit);
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toMatchObject({ revoke_reason: "Replaced by a new emailed link" }); expect(reqs[0].revoked_at).not.toBeNull(); expect(reqs[1].revoked_at).toBeNull();
    expect((await events(visit)).map((e: any) => e.action)).toContain("link_revoked");
    // the same retry key cannot email the same link twice
    const key = crypto.randomUUID();
    await post(withEmail, visit, w.managerA.sub, {}, key);
    sent.length = 0;
    const replay = await post(withEmail, visit, w.managerA.sub, {}, key);
    expect(replay.status).toBe(409); expect(sent).toHaveLength(0);
  });

  it("when the email fails the delivery failure is recorded and the link and code come back for copying; a transient error is retried once", async () => {
    const visit = await deferredVisit(await freshClient(db, w, w.caregiverA1, 600));
    sent.length = 0; next = [{ ok: false, error: "recipient_not_allowed", transient: false }];
    const bad = await post(withEmail, visit, w.managerA.sub);
    expect(bad.status).toBe(201);
    expect(bad.body).toMatchObject({ emailSent: false, error: "recipient_not_allowed" }); expect(bad.body.token).toMatch(/^[0-9a-f]{64}$/); expect(bad.body.code).toMatch(/^\d{6}$/);
    expect(sent).toHaveLength(1);
    expect((await events(visit)).some((e: any) => e.action === "delivery_failed" && e.detail.status === "recipient_not_allowed")).toBe(true);
    sent.length = 0; next = [{ ok: false, error: "throttling_exception", transient: true }, "throw"];
    const flaky = await post(withEmail, visit, w.managerA.sub);
    expect(flaky.body.emailSent).toBe(false); expect(sent).toHaveLength(2);
    sent.length = 0; next = [{ ok: false, error: "throttling_exception", transient: true }, { ok: true, messageId: "m2" }];
    expect((await post(withEmail, visit, w.managerA.sub)).body.emailSent).toBe(true); expect(sent).toHaveLength(2);
  });

  it("is unavailable (503, no link created) where the environment has no email function, and is permission-checked, agency-isolated and validated", async () => {
    const visit = await deferredVisit(await freshClient(db, w, w.caregiverA1, 600));
    const before = (await requestsOf(visit)).length;
    expect((await post(withoutEmail, visit, w.managerA.sub)).status).toBe(503);
    expect((await requestsOf(visit)).length).toBe(before);
    expect((await post(withEmail, visit, w.caregiverA1.sub)).status).toBe(403);
    expect((await post(withEmail, visit, w.managerB.sub)).status).toBe(404);
    for (const bad of [{ recipientEmail: "nope" }, { recipientEmail: "a@b" }, { recipientEmail: "x@example.test\r\nBcc: y@z.test" }, { recipientRole: "stranger" }, { identityCheck: "" }, { expiresInDays: 99 }]) {
      expect((await post(withEmail, visit, w.managerA.sub, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await requestsOf(visit)).length).toBe(before);
  });
});

/** A finished visit with no signature: started, ended and sent to review with "unable to confirm" (the existing no-signature path). */
async function deferredVisit(f: { client: string; service: string }) {
  const { ageVisit, api } = await import("../../../infra/aws/db/test/harness");
  const visit = await api.start(db, w.caregiverA1, w.orgA, f.client, f.service);
  await ageVisit(db, visit, 20); await api.end(db, w.caregiverA1, visit);
  await api.confirm(db, w.caregiverA1, visit, { method: "unable_to_confirm", reason: "Client asleep; will sign later (synthetic)" });
  await db.admin.query("update ogevia.shifts set status = 'cancelled' where client_id = $1", [f.client]);
  return visit;
}
