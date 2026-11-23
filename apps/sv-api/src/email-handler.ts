import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

/**
 * Email Lambda (0113): outside the VPC (the API Lambda has no internet route and NAT is deferred), invoked only by the API Lambda. Its role allows ses:SendEmail on the
 * one verified identity and nothing else; it has no database, S3, KMS or secret access. It never logs an address, subject or body: one line per call with the outcome code.
 */
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const TRANSIENT = new Set(["ThrottlingException", "TooManyRequestsException", "ServiceUnavailableException", "InternalFailure", "InternalServerError", "TimeoutError", "RequestTimeout", "LimitExceededException", "SendingPausedException"]);
export interface EmailRequest { to?: unknown; subject?: unknown; text?: unknown; html?: unknown }
export type EmailResponse = { ok: true; messageId: string } | { ok: false; error: string; transient: boolean };
type Ses = Pick<SESv2Client, "send">;

export function createEmailHandler(ses: Ses, from: string, configurationSet?: string, log: (line: string) => void = console.log) {
  const outcome = (r: EmailResponse) => { log(JSON.stringify({ action: "send", outcome: r.ok ? "ok" : r.error })); return r; };
  return async function handler(event: EmailRequest): Promise<EmailResponse> {
    const to = typeof event?.to === "string" ? event.to.trim() : "";
    const subject = typeof event?.subject === "string" ? event.subject : "";
    const text = typeof event?.text === "string" ? event.text : "";
    const html = typeof event?.html === "string" ? event.html : "";
    if (to.length > 254 || !EMAIL.test(to) || subject.length < 1 || subject.length > 200 || text.length < 1 || text.length > 5000 || html.length > 20000) {
      return outcome({ ok: false, error: "invalid_request", transient: false });
    }
    try {
      const out = await ses.send(new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject, Charset: "UTF-8" }, Body: { Text: { Data: text, Charset: "UTF-8" }, ...(html ? { Html: { Data: html, Charset: "UTF-8" } } : {}) } } },
        ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
      }));
      return outcome(out.MessageId ? { ok: true, messageId: out.MessageId } : { ok: false, error: "no_message_id", transient: true });
    } catch (error) {
      const name = (error as { name?: string }).name ?? "";
      return outcome({ ok: false, error: /^[A-Za-z]{1,40}$/.test(name) ? name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().slice(0, 40) : "send_failed", transient: TRANSIENT.has(name) || name === "" });
    }
  };
}
