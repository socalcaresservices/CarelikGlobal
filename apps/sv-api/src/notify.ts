import type { ConnectionSource } from "./db";
import { runSmsSweep, type SmsSender } from "./sms";

/**
 * The scheduled notification run (0113). An EventBridge rule invokes the API Lambda with { "ogevia-task": "notify-sweep" }. Two jobs, both safe to repeat:
 *   1. for agencies with auto-notify on, create the cover-shift notifications for shifts that need cover inside their window (ogevia_api.system_cover_notify_*);
 *   2. when an email sender is wired, claim due deliveries, send each through the email Lambda and record the outcome (retry/failure rules live in the database).
 * Logging policy (same as the API): counts and error codes only. Never an address, name, subject or message body.
 */
export const NOTIFY_SWEEP_TASK = "notify-sweep";

export function isNotifySweepEvent(event: unknown): boolean {
  return typeof event === "object" && event !== null && (event as Record<string, unknown>)["ogevia-task"] === NOTIFY_SWEEP_TASK
    && !("routeKey" in event) && !("requestContext" in event);
}

export interface EmailMessage { readonly to: string; readonly subject: string; readonly text: string; readonly html: string; readonly deliveryId: string }
export type EmailResult = { readonly ok: true; readonly messageId: string } | { readonly ok: false; readonly error: string; readonly transient: boolean };
export type SendEmail = (message: EmailMessage) => Promise<EmailResult>;

export interface NotifyDeps {
  readonly db: ConnectionSource;
  readonly dbSetRole?: string | undefined;
  readonly sendEmail?: SendEmail | undefined;
  /** The text sender (the mock until the owner approves a live sender). When present, the run also escalates unfilled shifts and sends due texts. */
  readonly sms?: SmsSender | undefined;
  readonly appOrigin?: string | undefined;
  readonly log?: (record: Record<string, unknown>) => void;
}
export interface NotifyResult { readonly organizations: number; readonly shiftsNotified: number; readonly notifications: number; readonly blockedShifts: number; readonly claimed: number; readonly sent: number; readonly retried: number; readonly failed: number; readonly failedOrganizations: number; readonly escalated?: number; readonly smsSent?: number; readonly smsFailed?: number }

const SAFE_ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The message shown to the caregiver: the stored title and body, and one link back into the app. No client detail is ever in either. */
export function composeEmail(row: { to_email: string; subject: string; body: string; link: string | null; delivery_id: string }, appOrigin: string): EmailMessage {
  const url = row.link ? `${appOrigin}${row.link}` : appOrigin;
  const text = `${row.body}\n\nOpen Ogevia: ${url}\n\nYou receive this because cover-shift emails are on for your agency. You can turn them off in Notifications > Preferences.`;
  const html = `<!doctype html><html lang="en"><body style="font-family:Arial,Helvetica,sans-serif;color:#1d2a2e;line-height:1.5"><p style="font-size:18px;font-weight:700">${esc(row.subject)}</p><p>${esc(row.body)}</p><p><a href="${esc(url)}" style="display:inline-block;padding:12px 20px;background:#0f5f66;color:#ffffff;text-decoration:none;border-radius:6px">Open Ogevia</a></p><p style="font-size:12px;color:#4a5a5f">You receive this because cover-shift emails are on for your agency. You can turn them off in Notifications &gt; Preferences.</p></body></html>`;
  return { to: row.to_email, subject: row.subject, text, html, deliveryId: row.delivery_id };
}

export async function runNotifySweep(deps: NotifyDeps): Promise<NotifyResult> {
  const log = deps.log ?? ((record) => console.log(JSON.stringify(record)));
  if (deps.dbSetRole !== undefined && !SAFE_ROLE.test(deps.dbSetRole)) throw new Error("The database role is malformed.");
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
    } catch (error) {
      broken = !(error as { code?: unknown })?.code;
      throw error;
    } finally { client.release(broken ? true : undefined); }
  };
  const sqlState = (error: unknown) => { const c = (error as { code?: unknown })?.code; return typeof c === "string" && /^[0-9A-Z]{5}$/.test(c) ? { sqlState: c } : {}; };

  const orgs = await inTx(async (query) => (await query("select ogevia_api.system_cover_notify_orgs() as id")).rows.map((r) => r.id as string));
  let shifts = 0, notifications = 0, blockedShifts = 0, failedOrganizations = 0;
  for (const org of orgs) {
    try {
      const r = await inTx(async (query) => (await query("select ogevia_api.system_cover_notify_org($1) as r", [org])).rows[0]?.r as Record<string, any>);
      shifts += Number(r?.shifts ?? 0); notifications += Number(r?.notified ?? 0);
      // shifts left for a person: no office chosen, incomplete service address, or the office's alerts turned off (counts only)
      blockedShifts += Object.values((r?.blocked ?? {}) as Record<string, number>).reduce((n, v) => n + Number(v), 0);
    } catch (error) {
      failedOrganizations += 1;
      log({ level: "error", task: NOTIFY_SWEEP_TASK, status: "organization_failed", ...sqlState(error) });
    }
  }

  let claimed = 0, sent = 0, retried = 0, failed = 0;
  if (deps.sendEmail && deps.appOrigin) {
    for (let batch = 0; batch < 3; batch++) {
      const due = await inTx(async (query) => (await query("select * from ogevia_api.system_email_claim(20)")).rows);
      if (due.length === 0) break;
      claimed += due.length;
      for (const row of due) {
        let result: EmailResult;
        try { result = await deps.sendEmail(composeEmail(row, deps.appOrigin)); }
        catch { result = { ok: false, error: "send_failed", transient: true }; }
        try {
          const state = await inTx(async (query) => (await query("select ogevia_api.system_email_record($1,$2,$3,$4) as s", [
            row.delivery_id, result.ok ? "sent" : result.transient ? "transient" : "permanent", result.ok ? result.messageId : null, result.ok ? null : result.error])).rows[0]?.s as string);
          if (state === "sent") sent += 1; else if (state === "retry") retried += 1; else if (state === "failed") failed += 1;
        } catch (error) {
          // The mail may have gone out but the result was not recorded: the stale-claim rule re-offers it after 10 minutes (at-least-once, never silently lost).
          log({ level: "error", task: NOTIFY_SWEEP_TASK, status: "record_failed", ...sqlState(error) });
        }
      }
    }
  }
  let escalated = 0, smsSent = 0, smsFailed = 0;
  if (deps.sms) {
    try { escalated = Number((await inTx(async (query) => (await query("select ogevia_api.system_sms_escalate_orgs() as n")).rows[0]?.n)) ?? 0); }
    catch (error) { log({ level: "error", task: NOTIFY_SWEEP_TASK, status: "escalation_failed", ...sqlState(error) }); }
    try { const r = await runSmsSweep({ db: deps.db, dbSetRole: deps.dbSetRole, sender: deps.sms, log }); smsSent = r.sent; smsFailed = r.failed; }
    catch (error) { log({ level: "error", task: NOTIFY_SWEEP_TASK, status: "sms_failed", ...sqlState(error) }); }
  }
  const result: NotifyResult = { organizations: orgs.length, shiftsNotified: shifts, notifications, blockedShifts, claimed, sent, retried, failed, failedOrganizations, escalated, smsSent, smsFailed };
  log({ level: failedOrganizations > 0 ? "error" : "info", task: NOTIFY_SWEEP_TASK, ...result });
  if (failedOrganizations > 0) throw new Error(`The notification run failed for ${failedOrganizations} of ${orgs.length} agencies.`);
  return result;
}
