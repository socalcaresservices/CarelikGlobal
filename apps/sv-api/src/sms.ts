import type { ConnectionSource } from "./db";

/**
 * Open Shifts text messages (0086). An EventBridge rule invokes the API Lambda with { "ogevia-task": "coverage-sms" }. The run:
 *   1. asks the database to sweep (expire started openings, plan rounds that entered the alert window, escalate unfilled ones),
 *   2. claims due jobs in batches (the database re-checks entitlement, sender, consent, eligibility, round, quiet hours and the monthly
 *      limit at the moment of claiming and renders the text from live facts),
 *   3. sends each claimed message through the transport and records the outcome.
 * No decision about WHO is texted or WHETHER is made here. A job the provider might have accepted (a timeout) is recorded as 'unknown' and is
 * never re-sent automatically.
 *
 * Logging policy: counts and error codes only. Never a phone number, message text, caregiver, shift or agency identifier.
 */
export const COVERAGE_SMS_TASK = "coverage-sms";

export function isCoverageSmsEvent(event: unknown): boolean {
  return typeof event === "object" && event !== null && (event as Record<string, unknown>)["ogevia-task"] === COVERAGE_SMS_TASK
    && !("routeKey" in event) && !("requestContext" in event);
}

export interface SmsMessage {
  readonly to: string;
  readonly from: string;
  readonly body: string;
  /** Stable per claim, so a provider that supports it can deduplicate a repeat of the same attempt. */
  readonly idempotencyToken: string;
}

export interface SmsReceipt {
  readonly messageId: string;
  readonly costMicros?: number;
}

/** transient = definitely not sent, safe to retry later; permanent = definitely not sent, do not retry; unknown = outcome uncertain. */
export class SmsTransportError extends Error {
  constructor(readonly kind: "transient" | "permanent" | "unknown", readonly code: string) {
    super(code);
    this.name = "SmsTransportError";
  }
}

export interface SmsTransport {
  send(message: SmsMessage): Promise<SmsReceipt>;
}

/** Segments of a text: GSM-7 (160 single, 153 per part) or UCS-2 when a character falls outside the basic set (70 / 67). */
export function smsSegments(body: string): number {
  const gsm = /^[\x20-\x7E\n\r£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¡ÄÖÑÜ§¿äöñüà€]*$/.test(body);
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  return body.length <= single ? 1 : Math.ceil(body.length / multi);
}

export interface SmsRunDeps {
  readonly db: ConnectionSource;
  readonly dbSetRole?: string | undefined;
  readonly transport: SmsTransport;
  /** Origin for the signed-in link, e.g. https://app.ogevia.com (the environment's own origin). */
  readonly appOrigin: string;
  /** TEST: when set, only these E.164 numbers are ever texted; anything else is recorded as a permanent failure and nothing is sent. */
  readonly allowlist?: ReadonlySet<string> | undefined;
  readonly batchSize?: number;
  readonly maxBatches?: number;
  readonly log?: (record: Record<string, unknown>) => void;
}

export interface SmsRunResult {
  readonly sweep: Record<string, number>;
  readonly claimed: number;
  readonly accepted: number;
  readonly failed: number;
  readonly retryLater: number;
  readonly unknown: number;
}

const SAFE_ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;

export async function runCoverageSms(deps: SmsRunDeps): Promise<SmsRunResult> {
  const log = deps.log ?? ((record) => console.log(JSON.stringify(record)));
  if (deps.dbSetRole !== undefined && !SAFE_ROLE.test(deps.dbSetRole)) throw new Error("The database role is malformed.");
  const origin = deps.appOrigin.replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin) && !/^http:\/\/localhost(:\d+)?$/i.test(origin)) throw new Error("APP_ORIGIN is malformed.");

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
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    } catch (error) {
      broken = !(error as { code?: unknown })?.code;
      throw error;
    } finally {
      client.release(broken ? true : undefined);
    }
  };

  const sweep = await inTx(async (query) => (await query("select ogevia_api.system_coverage_sweep() as r")).rows[0]?.r as Record<string, number>);
  let claimed = 0, accepted = 0, failed = 0, retryLater = 0, unknown = 0;
  const batch = deps.batchSize ?? 25;
  for (let i = 0; i < (deps.maxBatches ?? 8); i += 1) {
    // Claiming commits before any send: a crash after this point leaves the job 'claimed', which the sweep turns into 'unknown' (never re-sent).
    const jobs = await inTx(async (query) => (await query("select * from ogevia_api.system_sms_claim($1)", [batch])).rows);
    if (jobs.length === 0) break;
    for (const job of jobs) {
      claimed += 1;
      const record = (outcome: string, extra: { messageId?: string; segments?: number; costMicros?: number; code?: string } = {}) =>
        inTx((query) => query("select ogevia_api.system_sms_record($1, $2, $3, $4, $5, $6, $7) as r",
          [job.job_id, job.claim_token, outcome, extra.messageId ?? null, extra.segments ?? null, extra.costMicros ?? null, extra.code ?? null]));
      const body = String(job.body_template).replace("{link}", `${origin}${job.link_path ?? "/"}`);
      if (!E164.test(String(job.to_phone)) || !E164.test(String(job.sender_number))) { await record("failed", { code: "bad_number" }); failed += 1; continue; }
      if (deps.allowlist && !deps.allowlist.has(job.to_phone)) { await record("failed", { code: "not_allowlisted" }); failed += 1; continue; }
      const segments = smsSegments(body);
      try {
        const receipt = await deps.transport.send({ to: job.to_phone, from: job.sender_number, body, idempotencyToken: job.claim_token });
        await record("accepted", { messageId: receipt.messageId, segments, ...(receipt.costMicros !== undefined ? { costMicros: receipt.costMicros } : {}) });
        accepted += 1;
      } catch (error) {
        const kind = error instanceof SmsTransportError ? error.kind : "unknown";
        const code = error instanceof SmsTransportError ? error.code : "transport_error";
        if (kind === "permanent") { await record("failed", { code }); failed += 1; }
        else if (kind === "transient") { await record("transient", { code }); retryLater += 1; }
        else { await record("unknown", { code }); unknown += 1; }
      }
    }
  }
  const result: SmsRunResult = { sweep, claimed, accepted, failed, retryLater, unknown };
  log({ level: "info", task: COVERAGE_SMS_TASK, ...result });
  return result;
}

/** TEST transport: records what would be sent, optionally failing on demand. Never touches the network. */
export class MockSmsTransport implements SmsTransport {
  readonly sent: SmsMessage[] = [];
  failWith: SmsTransportError | null = null;
  private n = 0;
  async send(message: SmsMessage): Promise<SmsReceipt> {
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
    this.n += 1;
    return { messageId: `mock-${this.n}`, costMicros: 0 };
  }
}

/**
 * AWS End User Messaging SMS (pinpoint-sms-voice-v2) through an injected client, so no AWS package is imported here and TEST never needs one.
 * `makeCommand` builds a SendTextMessageCommand from the input (the production wiring supplies it). Not enabled in any environment until the
 * owner approves a verified sender per agency.
 */
export function awsEndUserMessagingTransport(
  client: { send(command: unknown): Promise<{ MessageId?: string }> },
  makeCommand: (input: Record<string, unknown>) => unknown,
  configurationSetName?: string,
): SmsTransport {
  return {
    async send(message) {
      try {
        const out = await client.send(makeCommand({
          DestinationPhoneNumber: message.to,
          OriginationIdentity: message.from,
          MessageBody: message.body,
          MessageType: "TRANSACTIONAL",
          ...(configurationSetName ? { ConfigurationSetName: configurationSetName } : {}),
          Context: { claim: message.idempotencyToken },
        }));
        if (!out?.MessageId) throw new SmsTransportError("unknown", "no_message_id");
        return { messageId: out.MessageId };
      } catch (error) {
        if (error instanceof SmsTransportError) throw error;
        const name = String((error as { name?: unknown })?.name ?? "");
        if (/Throttling|ServiceQuota|InternalServer|ServiceUnavailable/i.test(name)) throw new SmsTransportError("transient", name.slice(0, 40));
        if (/Validation|AccessDenied|ResourceNotFound|Conflict|OptedOut/i.test(name)) throw new SmsTransportError("permanent", name.slice(0, 40));
        throw new SmsTransportError("unknown", name ? name.slice(0, 40) : "transport_error"); // timeouts and anything unrecognised: outcome unknown
      }
    },
  };
}
