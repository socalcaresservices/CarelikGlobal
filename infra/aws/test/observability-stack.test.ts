import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import { ENVIRONMENTS } from "../lib/config.js";
import { newApp } from "./helpers.js";

const prod = ENVIRONMENTS.prod;

describe("ObservabilityStack (FUTURE, Phase 4/7)", () => {
  const [, , observability] = buildOgeviaApp(newApp(), prod, "plan");
  const template = Template.fromStack(observability!.stack);
  const alarms = Object.values(
    template.findResources("AWS::CloudWatch::Alarm"),
  ).map((a) => a.Properties as Record<string, unknown>);
  const byMetric = (name: string) => alarms.find((a) => a.MetricName === name);

  it("models a small fixed set of standard-resolution alarms", () => {
    expect(alarms.map((a) => a.MetricName).sort()).toEqual([
      "5xx",
      "CPUCreditBalance",
      "CPUUtilization",
      "Errors",
      "FreeStorageSpace",
      "Throttles",
    ]);
    for (const alarm of alarms) {
      expect(alarm.Period).toBe(300);
      expect(alarm.TreatMissingData).toBe("notBreaching");
      expect((alarm.AlarmActions as unknown[]).length).toBe(1);
    }
  });

  it("covers Lambda errors, Lambda throttles, and API 5xx", () => {
    expect(byMetric("Errors")?.Namespace).toBe("AWS/Lambda");
    expect(byMetric("Throttles")?.Namespace).toBe("AWS/Lambda");
    expect(byMetric("5xx")?.Namespace).toBe("AWS/ApiGateway");
  });

  it("monitors the EXISTING production RDS instance by reference only", () => {
    const id = prod.existing.databases.prod.instanceIdentifier;
    for (const metric of [
      "CPUUtilization",
      "FreeStorageSpace",
      "CPUCreditBalance",
    ]) {
      const alarm = byMetric(metric);
      expect(alarm?.Namespace).toBe("AWS/RDS");
      expect(alarm?.Dimensions).toEqual([
        { Name: "DBInstanceIdentifier", Value: id },
      ]);
    }
    template.resourceCountIs("AWS::RDS::DBInstance", 0);
  });

  it("uses a TLS-only alarm topic with no subscriptions yet (owner decision)", () => {
    template.resourceCountIs("AWS::SNS::Topic", 1);
    template.resourceCountIs("AWS::SNS::Subscription", 0);
    const policy = JSON.stringify(
      template.findResources("AWS::SNS::TopicPolicy"),
    );
    expect(policy).toContain('"aws:SecureTransport":"false"');
  });

  it("creates no dashboards, synthetics canaries, or other paid monitoring", () => {
    for (const type of [
      "AWS::CloudWatch::Dashboard",
      "AWS::Synthetics::Canary",
      "AWS::CloudWatch::InsightRule",
      "AWS::XRay::Group",
    ]) {
      template.resourceCountIs(type, 0);
    }
  });
});
