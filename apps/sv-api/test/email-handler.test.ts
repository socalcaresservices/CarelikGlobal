import { describe, expect, it } from "vitest";
import { createEmailHandler } from "../src/email-handler";

const ok = { to: "person@example.invalid", subject: "A shift needs cover", text: "Body", html: "<p>Body</p>" };
const ses = (impl: (cmd: any) => Promise<any>) => ({ send: impl }) as any;

describe("email Lambda", () => {
  it("sends one message to the one address from the configured sender and returns the provider id; nothing identifying is logged", async () => {
    const sent: any[] = []; const logs: string[] = [];
    const h = createEmailHandler(ses(async (c) => { sent.push(c.input); return { MessageId: "m-1" }; }), "Agency <no-reply@example.invalid>", "cfg", (l) => logs.push(l));
    expect(await h(ok)).toEqual({ ok: true, messageId: "m-1" });
    expect(sent[0].FromEmailAddress).toBe("Agency <no-reply@example.invalid>");
    expect(sent[0].Destination.ToAddresses).toEqual(["person@example.invalid"]);
    expect(sent[0].ConfigurationSetName).toBe("cfg");
    expect(logs.join("")).not.toContain("person@"); expect(logs.join("")).not.toContain("Body");
  });
  it("refuses a malformed request without calling SES", async () => {
    let calls = 0; const h = createEmailHandler(ses(async () => { calls++; return { MessageId: "x" }; }), "a@b.co", undefined, () => {});
    for (const bad of [{}, { ...ok, to: "not-an-address" }, { ...ok, subject: "" }, { ...ok, text: "x".repeat(5001) }, { ...ok, to: 5 }]) expect(await h(bad as any)).toEqual({ ok: false, error: "invalid_request", transient: false });
    expect(calls).toBe(0);
  });
  it("classifies SES failures: throttling and outages retry; rejections do not", async () => {
    const mk = (name: string) => createEmailHandler(ses(async () => { throw Object.assign(new Error("secret detail person@example.invalid"), { name }); }), "a@b.co", undefined, () => {});
    expect(await mk("ThrottlingException")(ok)).toMatchObject({ ok: false, transient: true, error: "throttling_exception" });
    expect(await mk("ServiceUnavailableException")(ok)).toMatchObject({ transient: true });
    expect(await mk("MessageRejected")(ok)).toMatchObject({ ok: false, transient: false, error: "message_rejected" });
    expect(await mk("MailFromDomainNotVerifiedException")(ok)).toMatchObject({ transient: false });
    expect(JSON.stringify(await mk("MessageRejected")(ok))).not.toContain("person@");
  });
  it("adds the configured Reply-To to the message and omits it when none is configured", async () => {
    const sent: any[] = [];
    const mk = (replyTo?: string) => createEmailHandler(ses(async (c) => { sent.push(c.input); return { MessageId: "m" }; }), "Ogevia <scheduling@example.invalid>", undefined, () => {}, replyTo);
    await mk("admin@example.invalid")(ok); await mk()(ok);
    expect(sent[0].ReplyToAddresses).toEqual(["admin@example.invalid"]); expect(sent[1]).not.toHaveProperty("ReplyToAddresses");
  });
});

