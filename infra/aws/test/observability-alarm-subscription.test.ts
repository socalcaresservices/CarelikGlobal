import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { ENVIRONMENTS } from "../lib/config.js";
import { normaliseAlarmEmail } from "../lib/observability-stack.js";
import { newApp } from "./helpers.js";

// Live check 2026-10-21: the production alarm topic has NO subscriber, the pilot topic has one email (created outside CDK).
// The address below is a reserved, non-routable example. Real addresses come from OGEVIA_ALARM_EMAIL and are never committed.
const EXAMPLE = "Alarms@Example.INVALID";

// Each synth bundles the Lambda with esbuild (seconds), so every distinct input is built once.
const cache = new Map<string, Template>();
const observabilityTemplate = (env: "prod" | "prd", alarmEmail?: string) => {
  const key = `${env}|${alarmEmail ?? "<none>"}`;
  let template = cache.get(key);
  if (!template) {
    const stacks = buildOgeviaApp(newApp(), ENVIRONMENTS[env], "plan", undefined, { alarmEmail });
    template = Template.fromStack(stacks[2]!.stack);
    cache.set(key, template);
  }
  return template;
};

describe("alarm email subscription (opt-in)", () => {
  it.each(["prod", "prd"] as const)("%s: no subscription unless an address is supplied (existing templates unchanged)", (env) => {
    observabilityTemplate(env).resourceCountIs("AWS::SNS::Subscription", 0);
  });

  it("an empty address behaves as none", () => {
    observabilityTemplate("prd", "").resourceCountIs("AWS::SNS::Subscription", 0);
    expect(JSON.stringify(observabilityTemplate("prd", "").toJSON())).toBe(JSON.stringify(observabilityTemplate("prd").toJSON()));
  });

  it("prd: one confirmed-by-recipient email subscription on the existing alarm topic", () => {
    const t = observabilityTemplate("prd", EXAMPLE);
    t.resourceCountIs("AWS::SNS::Subscription", 1);
    t.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "alarms@example.invalid" });
    t.resourceCountIs("AWS::SNS::Topic", 1);
    t.resourceCountIs("AWS::CloudWatch::Alarm", 6);
  });

  it("supplying an address changes nothing except adding the one subscription", () => {
    const without = observabilityTemplate("prd").toJSON() as { Resources: Record<string, unknown> };
    const withMail = observabilityTemplate("prd", EXAMPLE).toJSON() as { Resources: Record<string, unknown> };
    const added = Object.keys(withMail.Resources).filter((k) => !(k in without.Resources));
    expect(added).toHaveLength(1);
    expect((withMail.Resources[added[0]!] as { Type: string }).Type).toBe("AWS::SNS::Subscription");
    for (const k of Object.keys(without.Resources)) expect(withMail.Resources[k]).toEqual(without.Resources[k]);
  });

  it("rejects an invalid address without echoing it", () => {
    for (const bad of ["not-an-email", "a@b", "x@@y.com", `${"a".repeat(250)}@example.com`]) {
      expect(() => normaliseAlarmEmail(bad)).toThrow(/^OGEVIA_ALARM_EMAIL is not a valid email address\.$/);
    }
    expect(normaliseAlarmEmail(`  ${EXAMPLE}  `)).toBe("alarms@example.invalid");
  });
});
