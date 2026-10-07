// Static scanner for synthesized CloudFormation templates. Used by the unit
// tests (on in-memory synth) and by scripts/synth-inventory.ts (on cdk.out),
// so the same rules gate both. It reads JSON only; it never calls AWS.

import {
  ALLOWED_PHASE1_RESOURCE_TYPES,
  DEFERRED_RESOURCE_TYPES,
  RETAINED_RESOURCE_TYPES,
  stackException,
  WILDCARD_RESOURCE_ALLOWED_ACTIONS,
} from "./ownership.js";
import { APPROVED_PUBLIC_ROUTE_KEYS } from "./public-routes.js";

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

    if (stackException(stack, r.Type)) {
      // Allowed only in its documented stack; the rules below still apply.
    } else if (r.Type in DEFERRED_RESOURCE_TYPES) {
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
      // The one exception (0025): the caregiver-invitation identity function, which
      // must reach Cognito and carries nothing but the pool id in its environment.
      const envKeys = Object.keys((props.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables ?? {});
      const identityException = typeof props.FunctionName === "string" && /^Ogevia-[a-z0-9-]+-IdentityAdmin$/.test(props.FunctionName)
        && envKeys.length === 1 && envKeys[0] === "COGNITO_USER_POOL_ID";
      if (!identityException && (!vpc?.SubnetIds?.length || !vpc.SecurityGroupIds?.length)) {
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

    if (r.Type === "AWS::EC2::SecurityGroupIngress" || r.Type === "AWS::EC2::SecurityGroupEgress") {
      // A rule may only target a security group CREATED in this template
      // (Ref/Fn::GetAtt). A literal sg-... id is an existing group.
      const groupId = props.GroupId;
      if (typeof groupId === "string") {
        flag(logicalId, "rule-on-existing-sg", `${r.Type} targets existing group ${groupId}`);
      }
    }

    if (r.Type === "AWS::ApiGatewayV2::Route") {
      // Phase 3 gate: no API route may ever lose the Cognito JWT authorizer.
      const routeKey = String(props.RouteKey ?? "");
      const jwt = props.AuthorizationType === "JWT" && props.AuthorizerId !== undefined;
      // Exact-match allowlist (lib/public-routes.ts): token-link routes only,
      // and they must be truly anonymous (no half-configured authorizer).
      const approvedPublic =
        APPROVED_PUBLIC_ROUTE_KEYS.includes(routeKey) &&
        routeKey.includes("{token}") &&
        (props.AuthorizationType === undefined || props.AuthorizationType === "NONE") &&
        props.AuthorizerId === undefined;
      if (!jwt && !approvedPublic) {
        flag(logicalId, "unauthenticated-route", `${routeKey} must use the Cognito JWT authorizer`);
      }
      if (routeKey === "$default" || routeKey.startsWith("ANY ")) {
        flag(logicalId, "catch-all-route", `${routeKey}: only explicit method + path routes are allowed`);
      }
    }

    if (r.Type === "AWS::ApiGatewayV2::Authorizer") {
      const jwt = props.JwtConfiguration as { Audience?: unknown[] } | undefined;
      if (props.AuthorizerType !== "JWT" || !jwt?.Audience?.length) {
        flag(logicalId, "weak-authorizer", "Authorizer must be JWT with an explicit audience (app client) list");
      }
    }

    if (r.Type === "AWS::EC2::VPCEndpoint") {
      if (props.VpcEndpointType === "Interface" && props.PrivateDnsEnabled !== true) {
        flag(logicalId, "endpoint-private-dns", "Interface endpoints must enable private DNS");
      }
      if (props.VpcEndpointType === "Gateway") {
        const statements = asArray(
          (props.PolicyDocument as { Statement?: Statement[] } | undefined)?.Statement,
        );
        if (statements.length === 0 || statements.some((st) => asArray(st.Resource).includes("*"))) {
          flag(logicalId, "endpoint-policy", "Gateway endpoints need a policy scoped to Ogevia resources");
        }
      }
    }

    if (r.Type === "AWS::Cognito::UserPoolClient") {
      const flows = asArray(props.AllowedOAuthFlows as string[] | undefined);
      if (props.GenerateSecret === true) flag(logicalId, "client-secret", "Browser app clients must not have a secret");
      if (flows.some((f) => f !== "code")) flag(logicalId, "oauth-flow", "Only the authorization code flow is allowed");
      const urls = [
        ...asArray(props.CallbackURLs as unknown[] | undefined),
        ...asArray(props.LogoutURLs as unknown[] | undefined),
      ];
      if (urls.some((u) => typeof u === "string" && !u.startsWith("https://"))) {
        flag(logicalId, "insecure-redirect", "Callback and logout URLs must be https");
      }
      const authFlows = asArray(props.ExplicitAuthFlows as string[] | undefined);
      if (authFlows.some((f) => /USER_PASSWORD_AUTH|ADMIN_USER_PASSWORD_AUTH|CUSTOM_AUTH/.test(f))) {
        flag(logicalId, "password-flow", "Plaintext password auth flows are not allowed for browser clients");
      }
    }

    if (r.Type === "AWS::CloudFront::Distribution") {
      const config = props.DistributionConfig as
        { DefaultCacheBehavior?: { ViewerProtocolPolicy?: string }; CacheBehaviors?: Array<{ ViewerProtocolPolicy?: string }> } | undefined;
      const behaviors = [config?.DefaultCacheBehavior, ...(config?.CacheBehaviors ?? [])];
      if (behaviors.some((b) => !b || !["redirect-to-https", "https-only"].includes(String(b.ViewerProtocolPolicy)))) {
        flag(logicalId, "cloudfront-http", "Every behavior must redirect to or require HTTPS");
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

  // A VPC Lambda is validated at create time for ENI permissions; the policy
  // granting them must exist and be attached first (explicit DependsOn).
  for (const [logicalId, r] of Object.entries(template.Resources ?? {})) {
    if (r.Type !== "AWS::Lambda::Function" || !(r.Properties ?? {}).VpcConfig) continue;
    const role = ((r.Properties ?? {}).Role as { "Fn::GetAtt"?: [string, string] } | undefined)?.["Fn::GetAtt"]?.[0];
    const dependsOn = asArray((r as { DependsOn?: string | string[] }).DependsOn);
    const grants = Object.entries(template.Resources ?? {}).filter(
      ([, p]) =>
        (p.Type === "AWS::IAM::Policy" || p.Type === "AWS::IAM::ManagedPolicy") &&
        role !== undefined &&
        JSON.stringify(p.Properties?.Roles ?? []).includes(role) &&
        policyStatements(p).some((st) => asArray(st.Action).includes("ec2:CreateNetworkInterface")),
    );
    if (grants.length === 0) {
      flag(logicalId, "vpc-lambda-eni-policy", "VPC Lambda role has no attached policy granting ec2:CreateNetworkInterface");
    } else if (!grants.some(([id]) => dependsOn.includes(id))) {
      flag(logicalId, "vpc-lambda-eni-ordering", `Lambda must DependsOn ${grants.map(([id]) => id).join(", ")} (ENI permissions)`);
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
