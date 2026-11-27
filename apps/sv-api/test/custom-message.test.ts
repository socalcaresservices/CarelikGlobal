// Cognito custom-message trigger and the office look carried by the identity Lambda. SYNTHETIC values only.
import { describe, expect, it } from "vitest";
import { brandingFromEnvironment, createCustomMessageHandler, type CustomMessageEvent } from "../src/custom-message-handler";
import { createIdentityHandler } from "../src/identity-handler";
import { MemoryIdentityAdmin } from "../src/identity";

const COMPANY = { companyName: "SoCal Care Services", signInUrl: "https://app.example.invalid", supportEmail: "help@example.invalid" };
const ev = (source: string, metadata?: Record<string, string>): CustomMessageEvent => ({
  triggerSource: source,
  request: { userAttributes: { email: "person@example.invalid" }, codeParameter: "{####}", usernameParameter: "{username}", ...(metadata ? { clientMetadata: metadata } : {}) },
  response: { smsMessage: null, emailMessage: null, emailSubject: null },
});

describe("custom-message trigger", () => {
  it("brands the invitation with the company look and keeps Cognito's placeholders", async () => {
    const lines: string[] = [];
    const out = await createCustomMessageHandler(COMPANY, (l) => lines.push(l))(ev("CustomMessage_AdminCreateUser"));
    expect(out.response!.emailSubject).toBe("You're invited to SoCal Care Services on Ogevia");
    expect(out.response!.emailMessage).toContain("{####}"); expect(out.response!.emailMessage).toContain("{username}");
    expect(out.response!.emailMessage).not.toContain("Temecula");
    expect(lines.join("")).not.toContain("person@"); expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: "branded", office: false });
  });
  it("applies the office look from ClientMetadata (name, colour, logo, help address) and drops malformed values instead of failing", async () => {
    const h = createCustomMessageHandler(COMPANY, () => {});
    const out = await h(ev("CustomMessage_AdminCreateUser", { officeName: "Temecula Office", officeColor: "#9a3412", officeLogoUrl: "https://cdn.example.invalid/t.png", officeSupportEmail: "temecula@example.invalid" }));
    const html = out.response!.emailMessage!;
    expect(html).toContain("Temecula Office"); expect(html).toContain("#9a3412"); expect(html).toContain("cdn.example.invalid/t.png"); expect(html).toContain("temecula@example.invalid");
    const bad = await h(ev("CustomMessage_AdminCreateUser", { officeName: "Bad {####} name", officeColor: "red", officeLogoUrl: "http://x/y.png", officeSupportEmail: "nope" }));
    expect(bad.response!.emailMessage).toContain("SoCal Care Services"); expect(bad.response!.emailMessage).not.toContain("Bad ");
    expect(bad.response!.emailMessage!.split("{####}").length).toBe(2);
  });
  it("brands the password reset (company look only: office metadata is ignored for it) and requires the code placeholder once", async () => {
    const out = await createCustomMessageHandler(COMPANY, () => {})(ev("CustomMessage_ForgotPassword", { officeName: "Temecula Office" }));
    expect(out.response!.emailSubject).toBe("Reset your SoCal Care Services password");
    expect(out.response!.emailMessage!.split("{####}").length).toBe(2); expect(out.response!.emailMessage).not.toContain("Temecula");
  });
  it("leaves every other trigger, and any unexpected event, exactly as Cognito sent it (fail open)", async () => {
    const h = createCustomMessageHandler(COMPANY, () => {});
    for (const src of ["CustomMessage_SignUp", "CustomMessage_ResendCode", "CustomMessage_UpdateUserAttribute", "CustomMessage_VerifyUserAttribute", "CustomMessage_Authentication"]) {
      const out = await h(ev(src)); expect(out.response).toEqual({ smsMessage: null, emailMessage: null, emailSubject: null });
    }
    const odd = { triggerSource: "CustomMessage_AdminCreateUser", request: { codeParameter: "WRONG" }, response: { emailMessage: null, emailSubject: null } } as CustomMessageEvent;
    expect((await h(odd)).response!.emailMessage).toBeNull();
    expect(await h({} as CustomMessageEvent)).toEqual({});
    expect((await createCustomMessageHandler(null, () => {})(ev("CustomMessage_AdminCreateUser"))).response!.emailMessage).toBeNull();
  });
  it("reads the company look from the environment and refuses a malformed one", () => {
    expect(brandingFromEnvironment({})).toBeNull();
    expect(brandingFromEnvironment({ BRAND_COMPANY: "X Care", SIGN_IN_URL: "https://app.example.invalid", BRAND_ACCENT: "#112233" })).toMatchObject({ companyName: "X Care", accentColor: "#112233" });
    expect(() => brandingFromEnvironment({ BRAND_COMPANY: "X Care", SIGN_IN_URL: "http://insecure" })).toThrow();
  });
});

describe("identity Lambda passes the office look as ClientMetadata", () => {
  const SUB = "0f0e0d0c-1111-4222-8333-444455556666";
  const fake = () => { const sent: any[] = []; return { sent, client: { send: async (c: any) => { sent.push(c.input); return { User: { Attributes: [{ Name: "sub", Value: SUB }] } }; } } }; };
  it("sends only the sanitised keys on invite and resend, and none when there is no look", async () => {
    const f = fake(); const h = createIdentityHandler(f.client as never, "us-west-2_TEST", () => {});
    await h({ action: "invite", email: "p@example.invalid", look: { officeName: "Temecula Office", officeColor: "#9a3412", officeLogoUrl: "http://bad" } as never });
    expect(f.sent[0].ClientMetadata).toEqual({ officeName: "Temecula Office", officeColor: "#9a3412" });
    await h({ action: "resend", email: "p@example.invalid", look: { officeName: "Corona Office" } });
    expect(f.sent[1].ClientMetadata).toEqual({ officeName: "Corona Office" }); expect(f.sent[1].MessageAction).toBe("RESEND");
    await h({ action: "invite", email: "q@example.invalid" });
    expect(f.sent[2]).not.toHaveProperty("ClientMetadata");
  });
  it("the in-memory admin records the look", async () => {
    const m = new MemoryIdentityAdmin(); await m.invite("p@example.invalid", { officeName: "Corona Office" });
    expect(m.calls[0]).toMatchObject({ action: "invite", look: { officeName: "Corona Office" } });
  });
});
