import { readFileSync } from "node:fs";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks, HIPAASecurityChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";
import { resolveStage, STAGES } from "../lib/config.js";
import { EvidenceStorageStack } from "../lib/evidence-storage-stack.js";

// Same feature flags the CLI applies, so tests assert the template `cdk synth` emits.
const cdkJsonContext = (
  JSON.parse(readFileSync(new URL("../cdk.json", import.meta.url), "utf8")) as {
    context: Record<string, unknown>;
  }
).context;

function synth(stage: "dev" | "prod") {
  const app = new App({ context: cdkJsonContext });
  const stack = new EvidenceStorageStack(app, `Test-${stage}`, {
    config: STAGES[stage],
    env: { account: "111111111111", region: "us-west-2" },
  });
  return { stack, template: Template.fromStack(stack) };
}

describe("EvidenceStorageStack", () => {
  const { stack, template } = synth("prod");

  it("creates only the expected resource types (no network, compute, or database)", () => {
    const types = new Set(
      Object.values(
        template.toJSON().Resources as Record<string, { Type: string }>,
      ).map((resource) => resource.Type),
    );
    expect([...types].sort()).toEqual([
      "AWS::KMS::Alias",
      "AWS::KMS::Key",
      "AWS::S3::Bucket",
      "AWS::S3::BucketPolicy",
    ]);
  });

  it("uses a rotating customer-managed key that is never deleted by the stack", () => {
    template.hasResource("AWS::KMS::Key", {
      Properties: { EnableKeyRotation: true },
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  it("encrypts signature objects with the KMS key and blocks all public access", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({
            BucketKeyEnabled: true,
            ServerSideEncryptionByDefault: Match.objectLike({
              SSEAlgorithm: "aws:kms",
            }),
          }),
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: "Enabled" },
      OwnershipControls: {
        Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }],
      },
      LoggingConfiguration: Match.objectLike({
        LogFilePrefix: "signature-evidence/",
      }),
    });
  });

  it("does not enable irreversible Object Lock or any expiration without approval", () => {
    const buckets = template.findResources("AWS::S3::Bucket");
    for (const bucket of Object.values(buckets)) {
      const props = bucket.Properties as Record<string, unknown>;
      expect(props.ObjectLockEnabled).toBeUndefined();
      const rules =
        (
          props.LifecycleConfiguration as
            { Rules?: Array<Record<string, unknown>> } | undefined
        )?.Rules ?? [];
      for (const rule of rules) {
        expect(rule.ExpirationInDays).toBeUndefined();
        expect(rule.NoncurrentVersionExpiration).toBeUndefined();
      }
    }
  });

  it("retains every bucket on stack deletion or replacement", () => {
    const buckets = template.findResources("AWS::S3::Bucket");
    expect(Object.keys(buckets)).toHaveLength(2);
    for (const bucket of Object.values(buckets)) {
      expect(bucket.DeletionPolicy).toBe("Retain");
      expect(bucket.UpdateReplacePolicy).toBe("Retain");
    }
  });

  it("denies non-TLS and pre-TLS-1.2 access on every bucket policy", () => {
    const policies = template.findResources("AWS::S3::BucketPolicy");
    expect(Object.keys(policies)).toHaveLength(2);
    for (const policy of Object.values(policies)) {
      const statements = JSON.stringify(policy);
      expect(statements).toContain('"aws:SecureTransport":"false"');
      expect(statements).toContain('"s3:TlsVersion":1.2');
    }
  });

  it("enables termination protection for prod only", () => {
    expect(stack.terminationProtection).toBe(true);
    expect(synth("dev").stack.terminationProtection).toBe(false);
  });

  it.each([
    ["AwsSolutions", () => new AwsSolutionsChecks()],
    ["HIPAA Security", () => new HIPAASecurityChecks()],
  ])("has no unacknowledged %s findings", (_name, makePack) => {
    const report = makePack().validateScope(stack);
    expect(report.violations.map((v) => v.ruleName)).toEqual([]);
    expect(report.success).toBe(true);
  });
});

describe("resolveStage", () => {
  it("defaults to dev and rejects unknown stages", () => {
    expect(resolveStage(undefined).stage).toBe("dev");
    expect(resolveStage("prod").stage).toBe("prod");
    expect(() => resolveStage("production")).toThrow(/Unknown stage/);
  });
});
