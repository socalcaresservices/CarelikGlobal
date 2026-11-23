// Automatic texting for open shifts. The sender is an interface; ONLY the mock exists. The mock records what would have been sent and never touches a network.
// A live sender (AWS End User Messaging SMS or another provider) is a separate owner decision (see docs/release-train-2/open-shift-sms.md); until then a message addressed to the
// 'live' provider is recorded as a permanent failure ("live_not_enabled") so it is never silently dropped and never sent.
import type { ConnectionSource } from "./db";

export interface SmsMessage { readonly to: string; readonly body: string; readonly from: string | null; readonly messageId: string }
export type SmsResult = { readonly ok: true; readonly providerMessageId: string } | { readonly ok: false; readonly error: string; readonly transient: boolean };
export interface SmsSender { readonly kind: "mock" | "live"; send(message: SmsMessage): Promise<SmsResult> }

/** The mock: remembers every message in memory (tests and the TEST run read `sent`), can be told to fail, and never makes a network call. */
export class MockSmsSender implements SmsSender {
  readonly kind = "mock" as const;
  readonly sent: SmsMessage[] = [];
  failWith: { error: string; transient: boolean } | null = null;
  async send(message: SmsMessage): Promise<SmsResult> {
    if (this.failWith) return { ok: false, ...this.failWith };
    this.sent.push(message);
    return { ok: true, providerMessageId: `mock-${message.messageId}` };
  }
}

export type SmsMode = "mock";
export function createSmsSender(mode: SmsMode | undefined): SmsSender | undefined {
  return mode === "mock" ? new MockSmsSender() : undefined;
}

export interface SmsSweepDeps {
  readonly db: ConnectionSource;
  readonly dbSetRole?: string | undefined;
  readonly sender: SmsSender;
  readonly log?: (record: Record<string, unknown>) => void;
}
export interface SmsSweepResult { readonly claimed: number; readonly sent: number; readonly retried: number; readonly failed: number }
const SAFE_ROLE = /^[a-z_][a-z0-9_]{0,62}$/;

/** Claims due texts (consent re-checked in the database), sends each through the sender, records the outcome. Phone numbers never reach the log. */
export async function runSmsSweep(deps: SmsSweepDeps): Promise<SmsSweepResult> {
  if (deps.dbSetRole !== undefined && !SAFE_ROLE.test(deps.dbSetRole)) throw new Error("The database role is malformed.");
  const log = deps.log ?? ((record) => console.log(JSON.stringify(record)));
  const inTx = async <T>(work: (query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>) => Promise<T>): Promise<T> => {
    const client = await deps.db.connect();
    let broken = false;
    try {
      await client.query("begin");
      try {
        if (deps.dbSetRole) await client.query(`set local role ${deps.dbSetRole}`);
        const result = await work((sql, params) => client.query(sql, params));
        await client.query("commit");
        return result;
      } catch (error) { await client.query("rollback"); throw error; }
    } catch (error) { broken = !(error as { code?: unknown })?.code; throw error; } finally { client.release(broken ? true : undefined); }
  };
  let claimed = 0, sent = 0, retried = 0, failed = 0;
  for (let batch = 0; batch < 3; batch++) {
    const due = await inTx(async (query) => (await query("select * from ogevia_api.system_sms_claim(20)")).rows);
    if (due.length === 0) break;
    claimed += due.length;
    for (const row of due) {
      let result: SmsResult;
      if (row.provider !== deps.sender.kind) result = { ok: false, error: "live_not_enabled", transient: false };
      else {
        try { result = await deps.sender.send({ to: row.phone_e164, body: row.body, from: row.sender_id ?? null, messageId: row.id }); }
        catch { result = { ok: false, error: "send_failed", transient: true }; }
      }
      try {
        const state = await inTx(async (query) => (await query("select ogevia_api.system_sms_record($1,$2,$3,$4) as s", [
          row.id, result.ok ? "sent" : result.transient ? "transient" : "permanent", result.ok ? result.providerMessageId : null, result.ok ? null : result.error])).rows[0]?.s as string);
        if (state === "sent") sent += 1; else if (state === "retry") retried += 1; else if (state === "failed") failed += 1;
      } catch { log({ level: "error", task: "sms-sweep", status: "record_failed" }); }
    }
  }
  return { claimed, sent, retried, failed };
}
