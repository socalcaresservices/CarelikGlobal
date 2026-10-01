import { readdirSync, readFileSync } from "node:fs";
import { Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks, HIPAASecurityChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";
import { buildOgeviaApp, resolveMode } from "../lib/app.js";
import {
  assertAccount,
  ENVIRONMENTS,
  findPlaceholders,
  OGEVIA_ACCOUNT,
  resolveEnvironment,
} from "../lib/config.js";
import { scanTemplate, type CfnTemplate } from "../lib/template-scan.js";
import { newApp } from "./helpers.js";

function synthAll() {
  const planned = buildOgeviaApp(newApp(), ENVIRONMENTS.prod, "plan");
  return planned.map(({ stack, plannedPhase }) => ({
    stack,
    plannedPhase,
    template: Template.fromStack(stack).toJSON() as CfnTemplate,
  }));
}

describe("plan mode: every synthesized stack", () => {
  const stacks = synthAll();

  it("synthesizes the complete future architecture", () => {
    expect(stacks.map((s) => s.stack.stackName)).toEqual([
      "Ogevia-prod-EvidenceStorage",
      "Ogevia-prod-ServiceVerificationApi",
      "Ogevia-prod-Observability",
    ]);
  });

  it("passes the template security scanner with zero violations", () => {
    const violations = stacks.flatMap(({ stack, template }) =>
      scanTemplate(stack.stackName, template),
    );
    expect(violations).toEqual([]);
  });

  it("creates no VPC, subnet, NAT gateway, RDS instance, or DB subnet group", () => {
    const forbidden = [
      "AWS::EC2::VPC",
      "AWS::EC2::Subnet",
      "AWS::EC2::NatGateway",
      "AWS::RDS::DBInstance",
      "AWS::RDS::DBSubnetGroup",
      "AWS::EC2::SecurityGroup",
      "AWS::EC2::SecurityGroupIngress",
      "AWS::EC2::SecurityGroupEgress",
      "AWS::EC2::VPCEndpoint",
    ];
    for (const { stack, template } of stacks) {
      const found = Object.values(template.Resources ?? {})
        .map((r) => r.Type)
        .filter((t) => forbidden.includes(t));
      expect(found, stack.stackName).toEqual([]);
    }
  });

  it("targets the verified account and region, with termination protection", () => {
    for (const { stack } of stacks) {
      expect(stack.account).toBe(OGEVIA_ACCOUNT);
      expect(stack.region).toBe("us-west-2");
      expect(stack.terminationProtection).toBe(true);
    }
  });

  it("tags every stack as CDK-owned FUTURE infrastructure that is not approved for deployment", () => {
    for (const { stack, plannedPhase } of stacks) {
      const tags = stack.tags.tagValues();
      expect(tags["ogevia:ownership"]).toBe("cdk-future");
      expect(tags["ogevia:deployment-status"]).toBe("not-approved");
      expect(tags["ogevia:planned-phase"]).toBe(String(plannedPhase));
    }
  });

  it.each([
    ["AwsSolutions", () => new AwsSolutionsChecks()],
    ["HIPAA Security", () => new HIPAASecurityChecks()],
  ])("has no unacknowledged %s findings in any stack", (_name, makePack) => {
    for (const { stack } of stacks) {
      const report = makePack().validateScope(stack);
      expect(
        report.violations.map((v) => v.ruleName),
        stack.stackName,
      ).toEqual([]);
    }
  });
});

describe("template scanner catches each prohibited pattern", () => {
  const scan = (template: CfnTemplate) =>
    scanTemplate("Fixture", template).map((v) => v.rule);
  const retained = { DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain" };
  const privateBucket = {
    Type: "AWS::S3::Bucket",
    ...retained,
    Properties: {
      BucketEncryption: { ServerSideEncryptionConfiguration: [] },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    },
  };

  it.each([
    ["AWS::EC2::VPC"],
    ["AWS::EC2::Subnet"],
    ["AWS::EC2::NatGateway"],
    ["AWS::RDS::DBInstance"],
    ["AWS::RDS::DBSubnetGroup"],
  ])("rejects a duplicate %s", (type) => {
    expect(scan({ Resources: { X: { Type: type } } })).toContain(
      "deferred-or-existing-resource-type",
    );
  });

  it("rejects an unknown resource class", () => {
    expect(
      scan({ Resources: { X: { Type: "AWS::EC2::Instance" } } }),
    ).toContain("deferred-or-existing-resource-type");
    expect(
      scan({ Resources: { X: { Type: "AWS::DynamoDB::Table" } } }),
    ).toContain("unexpected-resource-type");
  });

  it("rejects public or unencrypted S3", () => {
    const pub = structuredClone(privateBucket);
    (
      pub.Properties.PublicAccessBlockConfiguration as Record<string, boolean>
    ).BlockPublicPolicy = false;
    expect(scan({ Resources: { B: pub } })).toContain("public-s3");
    const plain = structuredClone(privateBucket) as {
      Properties: Record<string, unknown>;
    };
    delete plain.Properties.BucketEncryption;
    expect(scan({ Resources: { B: plain as never } })).toContain(
      "unencrypted-s3",
    );
  });

  it("rejects a bucket policy that allows everyone or lacks the TLS deny", () => {
    expect(
      scan({
        Resources: {
          P: {
            Type: "AWS::S3::BucketPolicy",
            Properties: {
              PolicyDocument: {
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: "*",
                    Action: "s3:GetObject",
                    Resource: "x",
                  },
                ],
              },
            },
          },
        },
      }),
    ).toEqual(expect.arrayContaining(["s3-tls", "public-s3"]));
  });

  it("rejects public or PostgreSQL ingress", () => {
    expect(
      scan({
        Resources: {
          G: {
            Type: "AWS::Lambda::Permission",
            Properties: { CidrIp: "0.0.0.0/0", FromPort: 5432, ToPort: 5432 },
          },
        },
      }),
    ).toContain("public-or-database-ingress");
  });

  it("rejects secrets in outputs", () => {
    expect(
      scan({ Outputs: { O: { Value: { Ref: "DbMasterSecret" } } } }),
    ).toContain("secret-in-output");
  });

  it("rejects missing retention on stateful resources", () => {
    expect(
      scan({ Resources: { K: { Type: "AWS::KMS::Key", Properties: {} } } }),
    ).toContain("missing-retention");
  });

  it("rejects wildcard IAM actions and wildcard resources outside the ENI allowlist", () => {
    const policy = (Action: string | string[], Resource: unknown) => ({
      Resources: {
        P: {
          Type: "AWS::IAM::ManagedPolicy",
          Properties: {
            PolicyDocument: {
              Statement: [{ Effect: "Allow", Action, Resource }],
            },
          },
        },
      },
    });
    expect(scan(policy("s3:*", "arn:aws:s3:::b/*"))).toContain(
      "wildcard-iam-action",
    );
    expect(scan(policy("*", "arn:aws:s3:::b/*"))).toContain(
      "wildcard-iam-action",
    );
    expect(scan(policy("secretsmanager:GetSecretValue", "*"))).toContain(
      "wildcard-iam-resource",
    );
    expect(
      scan(
        policy(
          ["ec2:CreateNetworkInterface", "ec2:DescribeNetworkInterfaces"],
          "*",
        ),
      ),
    ).toEqual([]);
  });

  it("rejects a Lambda outside the VPC or with an injected secret", () => {
    expect(
      scan({
        Resources: {
          F: {
            Type: "AWS::Lambda::Function",
            Properties: {
              Environment: {
                Variables: { DB_PASSWORD: "{{resolve:secretsmanager:x}}" },
              },
            },
          },
        },
      }),
    ).toEqual(
      expect.arrayContaining(["lambda-outside-vpc", "secret-in-environment"]),
    );
  });
});

describe("configuration-driven identifiers", () => {
  const ID_PATTERN =
    /\b(vpc|subnet|sg|vpce|rtb|igw|nat)-[0-9a-f]{8,17}\b|\b\d{12}\b|us-west-2_[A-Za-z0-9]+|\.rds\.amazonaws\.com|arn:aws:secretsmanager/;

  it("keeps every live AWS identifier out of stack and construct code", () => {
    const dir = new URL("../lib/", import.meta.url);
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith(".ts") && file !== "config.ts")
      .filter((file) =>
        ID_PATTERN.test(readFileSync(new URL(file, dir), "utf8")),
      );
    expect(offenders).toEqual([]);
  });

  it("has no unverified placeholder left in the prod environment", () => {
    expect(findPlaceholders(ENVIRONMENTS.prod)).toEqual([]);
  });

  it("requires an explicit environment and mode", () => {
    expect(resolveEnvironment("prod").envName).toBe("prod");
    expect(() => resolveEnvironment(undefined)).toThrow(/Pass -c env=prod/);
    expect(() => resolveEnvironment("dev")).toThrow(/unknown environment/);
    expect(resolveMode("plan")).toBe("plan");
    expect(() => resolveMode(undefined)).toThrow(/mode=plan/);
    expect(() => resolveMode("deploy")).toThrow(/mode=plan/);
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
