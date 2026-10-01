import { readdirSync, readFileSync } from "node:fs";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildOgeviaApp } from "../lib/app.js";
import {
  assertAccount,
  ENVIRONMENTS,
  OGEVIA_ACCOUNT,
  resolveEnvironment,
} from "../lib/config.js";
import {
  ALLOWED_PHASE1_RESOURCE_TYPES,
  DEFERRED_RESOURCE_TYPES,
} from "../lib/ownership.js";
import { newApp, type CfnResource } from "./helpers.js";

const STATEFUL_TYPES = new Set(["AWS::KMS::Key", "AWS::S3::Bucket"]);

function synthAll() {
  const app = newApp();
  const stacks = buildOgeviaApp(app, ENVIRONMENTS.prod);
  return stacks.map((stack) => {
    const json = Template.fromStack(stack).toJSON() as {
      Resources?: Record<string, CfnResource>;
    };
    return { stack, resources: Object.entries(json.Resources ?? {}) };
  });
}

describe("Phase 1 CDK app (every synthesized stack)", () => {
  const stacks = synthAll();

  it("targets the verified account and region from config", () => {
    for (const { stack } of stacks) {
      expect(stack.account).toBe(OGEVIA_ACCOUNT);
      expect(stack.region).toBe("us-west-2");
    }
  });

  it("contains no deferred resource type (no NAT, VPC, subnet, SG, EC2, RDS, Aurora, ECS, EKS, OpenSearch, ElastiCache, Cognito pool, budget)", () => {
    for (const { stack, resources } of stacks) {
      const found = resources
        .map(([, r]) => r.Type)
        .filter((type) => type in DEFERRED_RESOURCE_TYPES);
      expect(found, stack.stackName).toEqual([]);
    }
  });

  it("contains only allowed Phase 1 resource classes", () => {
    for (const { stack, resources } of stacks) {
      const unexpected = resources
        .map(([, r]) => r.Type)
        .filter((type) => !ALLOWED_PHASE1_RESOURCE_TYPES.includes(type));
      expect(unexpected, stack.stackName).toEqual([]);
    }
  });

  it("retains every stateful resource on delete and on replacement", () => {
    for (const { resources } of stacks) {
      for (const [logicalId, r] of resources) {
        if (!STATEFUL_TYPES.has(r.Type)) continue;
        expect(r.DeletionPolicy, logicalId).toBe("Retain");
        expect(r.UpdateReplacePolicy, logicalId).toBe("Retain");
      }
    }
  });

  it("enables termination protection on every prod stack", () => {
    for (const { stack } of stacks) {
      expect(stack.terminationProtection).toBe(true);
    }
  });

  it("emits no public PostgreSQL ingress anywhere", () => {
    for (const { resources } of stacks) {
      const text = JSON.stringify(resources);
      expect(text).not.toMatch(/"CidrIp":"0\.0\.0\.0\/0"/);
      expect(text).not.toMatch(/"CidrIpv6":"::\/0"/);
      expect(text).not.toContain('"FromPort":5432');
    }
  });
});

describe("configuration-driven identifiers", () => {
  const ID_PATTERN =
    /\b(vpc|subnet|sg|vpce|rtb|igw|nat)-[0-9a-f]{8,17}\b|\b\d{12}\b|us-west-2_[A-Za-z0-9]+/;

  it("keeps every live AWS identifier out of stack and construct code", () => {
    const dir = new URL("../lib/", import.meta.url);
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith(".ts") && file !== "config.ts")
      .filter((file) => ID_PATTERN.test(readFileSync(new URL(file, dir), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("requires an explicit environment", () => {
    expect(resolveEnvironment("prod").envName).toBe("prod");
    expect(() => resolveEnvironment(undefined)).toThrow(/Pass -c env=prod/);
    expect(() => resolveEnvironment("dev")).toThrow(/unknown environment/);
  });

  it("refuses to synthesize against credentials for another account", () => {
    expect(() => assertAccount(ENVIRONMENTS.prod, undefined)).not.toThrow();
    expect(() =>
      assertAccount(ENVIRONMENTS.prod, OGEVIA_ACCOUNT),
    ).not.toThrow();
    expect(() => assertAccount(ENVIRONMENTS.prod, "111111111111")).toThrow(
      /Refusing to synthesize/,
    );
  });
});
