import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { ENVIRONMENTS, type OgeviaEnvironmentConfig } from "../lib/config.js";
import { assertCognitoTemplate, COGNITO_PASSWORD, COGNITO_USERNAME, renderInvitationEmail, validateBranding } from "../lib/invitation-email.js";
import { newApp } from "./helpers.js";

const BRAND = { companyName: "SoCal Care Services", signInUrl: "https://app.ogevia.com" };

describe("branded invitation email renderer", () => {
  it("keeps Cognito's two placeholders exactly once and fits Cognito's limits", () => {
    const r = renderInvitationEmail(BRAND);
    expect(r.html.split(COGNITO_USERNAME).length).toBe(2);
    expect(r.html.split(COGNITO_PASSWORD).length).toBe(2);
    expect(() => assertCognitoTemplate(r)).not.toThrow();
    expect(r.subject).toBe("You're invited to SoCal Care Services on Ogevia");
    expect(r.text).toContain(COGNITO_PASSWORD);
  });
  it("is responsive and email-safe: viewport, a narrow-screen rule, 600px max width, no scripts, no remote CSS", () => {
    const { html } = renderInvitationEmail(BRAND);
    expect(html).toContain('name="viewport"');
    expect(html).toContain("max-width:480px");
    expect(html).toContain("max-width:100%");
    expect(html).not.toMatch(/<script|<link |@import|url\(/i);
  });
  it("shows the logo only when given, an office line only when given, and escapes every brand value", () => {
    expect(renderInvitationEmail(BRAND).html).not.toContain("<img");
    const r = renderInvitationEmail({ ...BRAND, companyName: 'A & B "Care"', logoUrl: "https://cdn.example.com/l.png", office: { name: "Temecula <Office>", color: "#aa3300" }, supportEmail: "help@example.com", accentColor: "#112233" });
    expect(r.html).toContain("A &amp; B &quot;Care&quot;");
    expect(r.html).toContain("Temecula &lt;Office&gt;");
    expect(r.html).toContain("<img");
    expect(r.html).toContain("#aa3300");
    expect(r.html).toContain("help@example.com");
    expect(r.html).not.toContain("<Office>");
  });
  it("refuses values that could break Cognito's placeholders or the page", () => {
    for (const bad of [{ companyName: "" }, { companyName: "x".repeat(61) }, { companyName: "Care {####}" }, { signInUrl: "http://app.ogevia.com" }, { logoUrl: "http://x/y.png" }, { accentColor: "teal" }, { supportEmail: "nope" }]) {
      expect(() => validateBranding({ ...BRAND, ...bad })).toThrow(/invitation email/);
    }
  });
});

describe("the dedicated pool and the invitation settings", () => {
  const prdWith = (invitationEmail?: NonNullable<OgeviaEnvironmentConfig["auth"]["invitationEmail"]>): Record<string, any> => {
    const cfg: OgeviaEnvironmentConfig = { ...ENVIRONMENTS.prd, auth: { ...ENVIRONMENTS.prd.auth, ...(invitationEmail ? { invitationEmail } : {}) } };
    const stacks = buildOgeviaApp(newApp(), cfg, "plan");
    const auth = Template.fromStack(stacks.find((p) => p.stack.stackName.endsWith("-Auth"))!.stack);
    return Object.values(auth.findResources("AWS::Cognito::UserPool"))[0]!.Properties as Record<string, any>;
  };
  it("with no invitationEmail setting (today's production config) the pool keeps Cognito's default message and sender", () => {
    expect(ENVIRONMENTS.prd.auth.invitationEmail).toBeUndefined();
    const pool = prdWith();
    expect(pool.AdminCreateUserConfig).toEqual({ AllowAdminCreateUserOnly: true });
    expect(pool.EmailConfiguration).toEqual({ EmailSendingAccount: "COGNITO_DEFAULT" });
  });
  it("with the setting on, the pool carries the rendered message; the sender stays Cognito's unless an SES sender is given", () => {
    const pool = prdWith({ companyName: "SoCal Care Services" });
    expect(pool.AdminCreateUserConfig.InviteMessageTemplate.EmailSubject).toContain("SoCal Care Services");
    expect(pool.AdminCreateUserConfig.InviteMessageTemplate.EmailMessage).toContain(COGNITO_PASSWORD);
    expect(pool.EmailConfiguration).toEqual({ EmailSendingAccount: "COGNITO_DEFAULT" });
  });
  it("with the setting on, a custom-message trigger Lambda is attached to the pool: logs-only role, no VPC, Cognito may invoke it; with it off there is none", () => {
    const cfg: OgeviaEnvironmentConfig = { ...ENVIRONMENTS.prd, auth: { ...ENVIRONMENTS.prd.auth, invitationEmail: { companyName: "SoCal Care Services", supportEmail: "help@example.org" } } };
    const auth = Template.fromStack(buildOgeviaApp(newApp(), cfg, "plan").find((p) => p.stack.stackName.endsWith("-Auth"))!.stack);
    const fns = Object.values(auth.findResources("AWS::Lambda::Function"));
    expect(fns).toHaveLength(1);
    const f = fns[0]!.Properties as any;
    expect(f.VpcConfig).toBeUndefined(); expect(f.Timeout).toBe(3);
    expect(f.Environment.Variables).toMatchObject({ BRAND_COMPANY: "SoCal Care Services", BRAND_SUPPORT_EMAIL: "help@example.org" });
    const pool = Object.values(auth.findResources("AWS::Cognito::UserPool"))[0]!.Properties as any;
    expect(pool.LambdaConfig.CustomMessage).toBeDefined();
    auth.hasResourceProperties("AWS::Lambda::Permission", { Action: "lambda:InvokeFunction", Principal: "cognito-idp.amazonaws.com" });
    const stmts = Object.values(auth.findResources("AWS::IAM::ManagedPolicy")).flatMap((p) => (p.Properties as any).PolicyDocument.Statement as any[]);
    expect(stmts.every((x) => ([] as string[]).concat(x.Action).every((a) => a.startsWith("logs:")))).toBe(true);
    const off = Template.fromStack(buildOgeviaApp(newApp(), ENVIRONMENTS.prd, "plan").find((p) => p.stack.stackName.endsWith("-Auth"))!.stack);
    off.resourceCountIs("AWS::Lambda::Function", 0);
    expect((Object.values(off.findResources("AWS::Cognito::UserPool"))[0]!.Properties as any).LambdaConfig).toBeUndefined();
  });
  it("an SES sender switches the pool to the developer account with the verified identity", () => {
    const arn = "arn:aws:ses:us-west-2:123456789012:identity/ogevia.com";
    const pool = prdWith({ companyName: "SoCal Care Services", sender: { from: "SoCal Care Services <no-reply@ogevia.com>", sesIdentityArn: arn } });
    expect(pool.EmailConfiguration).toEqual({ EmailSendingAccount: "DEVELOPER", From: "SoCal Care Services <no-reply@ogevia.com>", SourceArn: arn });
    expect(() => prdWith({ companyName: "X", sender: { from: "a@b.com", sesIdentityArn: "not-an-arn" } })).toThrow(/SES identity ARN/);
  });
});
