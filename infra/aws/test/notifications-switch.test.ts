// Release Train 2 (0113): the notification routes, the schedule and the email function exist only when the environment turns them on. Everything is OFF today.
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { ENVIRONMENTS, type OgeviaEnvironmentConfig } from "../lib/config.js";
import { SERVICE_VERIFICATION_ROUTES } from "../lib/service-verification-api-stack.js";
import { newApp } from "./helpers.js";

const ARN = "arn:aws:ses:us-west-2:123456789012:identity/ogevia.com";
const stacks = (cfg: OgeviaEnvironmentConfig) => buildOgeviaApp(newApp(), cfg, "plan");
const api = (cfg: OgeviaEnvironmentConfig) => Template.fromStack(stacks(cfg).find((p) => p.stack.stackName.endsWith("-ServiceVerificationApi"))!.stack);
const withCfg = (base: OgeviaEnvironmentConfig, notifications: boolean, email = false): OgeviaEnvironmentConfig =>
  ({ ...base, features: { ...base.features, notifications }, ...(email ? { notificationEmail: { from: "SoCal Care <no-reply@ogevia.com>", sesIdentityArn: ARN } } : {}) }) as OgeviaEnvironmentConfig;
const NOTIF = SERVICE_VERIFICATION_ROUTES.filter((r) => r.feature === "notifications").map((r) => `${r.method} ${r.path}`).sort();
const routeKeys = (t: Template) => Object.values(t.findResources("AWS::ApiGatewayV2::Route")).map((r) => (r.Properties as { RouteKey: string; AuthorizationType?: string }));

describe("notifications release switch", () => {
  it("marks exactly the eight notification routes", () => {
    expect(NOTIF).toEqual(["GET /v1/cover-notification-history", "GET /v1/cover-notification-settings", "GET /v1/notification-center", "GET /v1/notification-preferences",
      "POST /v1/cover-notification-settings", "POST /v1/notification-center/mark", "POST /v1/notification-preferences", "POST /v1/shifts/{shiftId}/notify-cover"].sort());
  });
  it("is OFF in TEST and production: no routes, no schedule, no email function", () => {
    for (const base of [ENVIRONMENTS.prod, ENVIRONMENTS.prd]) {
      expect(base.features.notifications ?? false).toBe(false);
      expect(base.notificationEmail).toBeUndefined();
      const t = api(base);
      for (const k of NOTIF) expect(routeKeys(t).map((r) => r.RouteKey), k).not.toContain(k);
      t.resourceCountIs("AWS::Events::Rule", 1);   // only the compliance sweep
      expect(Object.values(t.findResources("AWS::Lambda::Function")).some((f) => (f.Properties as any).FunctionName?.endsWith?.("NotificationEmail"))).toBe(false);
    }
  });
  it("with the switch on: exactly those eight routes (all require a JWT), plus one schedule; nothing else differs", () => {
    for (const base of [ENVIRONMENTS.prod, ENVIRONMENTS.prd]) {
      const off = routeKeys(api(withCfg(base, false))); const t = api(withCfg(base, true)); const on = routeKeys(t);
      expect(on.length).toBe(off.length + 8);
      for (const k of NOTIF) expect(on.find((r) => r.RouteKey === k), k).toMatchObject({ AuthorizationType: "JWT" });
      expect(on.filter((r) => !NOTIF.includes(r.RouteKey)).map((r) => r.RouteKey).sort()).toEqual(off.map((r) => r.RouteKey).sort());
      t.resourceCountIs("AWS::Events::Rule", 2);
      t.hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: "rate(5 minutes)" });
    }
  });
  it("with a sender: one email function outside the VPC, SES send on the one identity only, the API may invoke it, and the endpoint policy names it", () => {
    const cfg = withCfg(ENVIRONMENTS.prd, true, true);
    const t = api(cfg);
    const fn = Object.values(t.findResources("AWS::Lambda::Function")).find((f) => (f.Properties as any).FunctionName === `Ogevia-prd-NotificationEmail`)!;
    expect(fn).toBeDefined();
    expect((fn.Properties as any).VpcConfig).toBeUndefined();
    expect((fn.Properties as any).Environment.Variables).toEqual({ SES_FROM: "SoCal Care <no-reply@ogevia.com>" });
    const stmts = Object.values(t.findResources("AWS::IAM::ManagedPolicy")).flatMap((p) => (p.Properties as any).PolicyDocument.Statement as any[]);
    const ses = stmts.filter((s) => ([] as string[]).concat(s.Action).includes("ses:SendEmail"));
    expect(ses).toHaveLength(1); expect(ses[0].Resource).toEqual(ARN);
    expect(stmts.some((s) => s.Sid === "InvokeNotificationEmail")).toBe(true);
    const handler = Object.values(t.findResources("AWS::Lambda::Function")).find((f) => (f.Properties as any).Description === "Ogevia Service Verification API")!;
    expect((handler.Properties as any).Environment.Variables).toMatchObject({ EMAIL_FUNCTION_NAME: "Ogevia-prd-NotificationEmail", APP_ORIGIN: expect.stringMatching(/^https:\/\//) });
    // The Lambda endpoint is owned by the TEST-named network stack, which also serves production; check it with an environment that owns the stack.
    const own = withCfg(ENVIRONMENTS.prod, true, true);
    const egress = Template.fromStack(stacks(own).find((p) => p.stack.stackName.endsWith("-NetworkEgress"))!.stack);
    expect(JSON.stringify(egress.toJSON())).toContain("Ogevia-prod-NotificationEmail");
    const base = Template.fromStack(stacks(ENVIRONMENTS.prod).find((p) => p.stack.stackName.endsWith("-NetworkEgress"))!.stack);
    expect(JSON.stringify(base.toJSON())).not.toContain("NotificationEmail");
  });
  it("refuses a malformed sender or identity", () => {
    expect(() => api({ ...withCfg(ENVIRONMENTS.prd, true), notificationEmail: { from: "not an address", sesIdentityArn: ARN } } as OgeviaEnvironmentConfig)).toThrow(/notificationEmail.from/);
    expect(() => api({ ...withCfg(ENVIRONMENTS.prd, true), notificationEmail: { from: "a@b.co", sesIdentityArn: "arn:aws:s3:::x" } } as OgeviaEnvironmentConfig)).toThrow(/SES identity ARN/);
  });
});

describe("invitation branding release switch (0114)", () => {
  const BR = SERVICE_VERIFICATION_ROUTES.filter((r) => r.feature === "invitationBranding").map((r) => `${r.method} ${r.path}`).sort();
  it("marks exactly the two office-branding routes, OFF today, and with the switch on they require a JWT and nothing else changes", () => {
    expect(BR).toEqual(["GET /v1/office-branding", "POST /v1/offices/{officeId}/branding"]);
    for (const base of [ENVIRONMENTS.prod, ENVIRONMENTS.prd]) {
      expect(base.features.invitationBranding ?? false).toBe(false);
      const off = routeKeys(api(base)); const on = routeKeys(api({ ...base, features: { ...base.features, invitationBranding: true } } as OgeviaEnvironmentConfig));
      for (const k of BR) { expect(off.map((r) => r.RouteKey)).not.toContain(k); expect(on.find((r) => r.RouteKey === k)).toMatchObject({ AuthorizationType: "JWT" }); }
      expect(on.length).toBe(off.length + 2);
    }
  });
});
