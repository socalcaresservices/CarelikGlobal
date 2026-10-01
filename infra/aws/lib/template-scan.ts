// Static scanner for synthesized CloudFormation templates. Used by the unit
// tests (on in-memory synth) and by scripts/synth-inventory.ts (on cdk.out),
// so the same rules gate both. It reads JSON only; it never calls AWS.

import {
  ALLOWED_PHASE1_RESOURCE_TYPES,
  DEFERRED_RESOURCE_TYPES,
  RETAINED_RESOURCE_TYPES,
  WILDCARD_RESOURCE_ALLOWED_ACTIONS,
} from "./ownership.js";

export interface CfnTemplate {
  Resources?: Record<string, CfnResource>;
  Outputs?: Record<
    string,
    { Value?: unknown; Export?: unknown; Description?: string }
  >;
}

export interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
}

export interface Violation {
  readonly stack: string;
  readonly logicalId: string;
  readonly rule: string;
  readonly detail: string;
}

type Statement = {
  Effect?: string;
  Action?: string | string[];
  Resource?: unknown;
  Principal?: unknown;
  Condition?: unknown;
};

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

function policyStatements(resource: CfnResource): Statement[] {
  const props = resource.Properties ?? {};
  const docs = [props.PolicyDocument, props.AssumeRolePolicyDocument].concat(
    asArray(
      props.Policies as Array<{ PolicyDocument?: unknown }> | undefined,
    ).map((p) => p.PolicyDocument),
  );
  return docs.flatMap((doc) =>
    asArray((doc as { Statement?: Statement[] } | undefined)?.Statement),
  );
}

/** Returns every violation in one template. An empty array means it passes. */
export function scanTemplate(
  stack: string,
  template: CfnTemplate,
): Violation[] {
  const out: Violation[] = [];
  const flag = (logicalId: string, rule: string, detail: string) =>
    out.push({ stack, logicalId, rule, detail });

  for (const [logicalId, r] of Object.entries(template.Resources ?? {})) {
    const props = r.Properties ?? {};

    if (r.Type in DEFERRED_RESOURCE_TYPES) {
      flag(
        logicalId,
        "deferred-or-existing-resource-type",
        `${r.Type}: ${DEFERRED_RESOURCE_TYPES[r.Type]}`,
      );
    } else if (!ALLOWED_PHASE1_RESOURCE_TYPES.includes(r.Type)) {
      flag(logicalId, "unexpected-resource-type", r.Type);
    }

    if (
      RETAINED_RESOURCE_TYPES.includes(r.Type) &&
      (r.DeletionPolicy !== "Retain" || r.UpdateReplacePolicy !== "Retain")
    ) {
      flag(
        logicalId,
        "missing-retention",
        `${r.Type} must be Retain on delete and replace`,
      );
    }

    if (r.Type === "AWS::S3::Bucket") {
      const pab = props.PublicAccessBlockConfiguration as
        Record<string, unknown> | undefined;
      const allBlocked =
        pab !== undefined &&
        [
          "BlockPublicAcls",
          "BlockPublicPolicy",
          "IgnorePublicAcls",
          "RestrictPublicBuckets",
        ].every((k) => pab[k] === true);
      if (!allBlocked)
        flag(
          logicalId,
          "public-s3",
          "Block Public Access must be fully enabled",
        );
      if (!props.BucketEncryption)
        flag(logicalId, "unencrypted-s3", "BucketEncryption missing");
      if (props.ObjectLockEnabled !== undefined)
        flag(
          logicalId,
          "object-lock",
          "Object Lock requires explicit owner approval",
        );
      if (
        props.AccessControl !== undefined &&
        props.AccessControl !== "Private"
      ) {
        flag(
          logicalId,
          "public-s3",
          `AccessControl ${String(props.AccessControl)}`,
        );
      }
    }

    if (r.Type === "AWS::S3::BucketPolicy") {
      const statements = policyStatements(r);
      const deniesInsecure = statements.some(
        (s) =>
          s.Effect === "Deny" &&
          JSON.stringify(s.Condition ?? {}).includes(
            '"aws:SecureTransport":"false"',
          ),
      );
      if (!deniesInsecure)
        flag(
          logicalId,
          "s3-tls",
          "Bucket policy must deny aws:SecureTransport=false",
        );
      for (const s of statements) {
        if (
          s.Effect === "Allow" &&
          (s.Principal === "*" || JSON.stringify(s.Principal) === '{"AWS":"*"}')
        ) {
          flag(logicalId, "public-s3", "Bucket policy allows Principal *");
        }
      }
    }

    if (
      r.Type === "AWS::IAM::Policy" ||
      r.Type === "AWS::IAM::ManagedPolicy" ||
      r.Type === "AWS::IAM::Role"
    ) {
      for (const s of policyStatements(r)) {
        if (s.Effect !== "Allow") continue;
        const actions = asArray(s.Action);
        for (const action of actions) {
          if (action === "*" || /^[a-z0-9-]+:\*$/i.test(action)) {
            flag(logicalId, "wildcard-iam-action", action);
          }
        }
        if (
          asArray(s.Resource).includes("*") &&
          !actions.every((a) => WILDCARD_RESOURCE_ALLOWED_ACTIONS.includes(a))
        ) {
          flag(logicalId, "wildcard-iam-resource", actions.join(","));
        }
      }
    }

    if (r.Type === "AWS::Lambda::Function") {
      const vpc = props.VpcConfig as
        { SubnetIds?: unknown[]; SecurityGroupIds?: unknown[] } | undefined;
      if (!vpc?.SubnetIds?.length || !vpc.SecurityGroupIds?.length) {
        flag(
          logicalId,
          "lambda-outside-vpc",
          "Lambda must run in the existing private subnets",
        );
      }
      const env = JSON.stringify(
        (props.Environment as { Variables?: unknown } | undefined)?.Variables ??
          {},
      );
      if (/resolve:secretsmanager|resolve:ssm-secure/i.test(env)) {
        flag(
          logicalId,
          "secret-in-environment",
          "Secret values must be fetched at runtime, not injected",
        );
      }
    }

    const text = JSON.stringify(props);
    if (
      /"CidrIp":"0\.0\.0\.0\/0"|"CidrIpv6":"::\/0"/.test(text) ||
      /"(FromPort|ToPort)":5432\b/.test(text)
    ) {
      flag(
        logicalId,
        "public-or-database-ingress",
        "No CIDR-open or PostgreSQL ingress may be defined by CDK",
      );
    }
  }

  for (const [outputId, output] of Object.entries(template.Outputs ?? {})) {
    const text = JSON.stringify(output);
    if (/secret|password|resolve:secretsmanager|SecretString/i.test(text)) {
      flag(
        outputId,
        "secret-in-output",
        "CloudFormation Outputs must not reference secrets",
      );
    }
  }

  return out;
}
