import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Validations,
  type StackProps,
} from "aws-cdk-lib";
import { AccessLogFormat } from "aws-cdk-lib/aws-apigateway";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as kms from "aws-cdk-lib/aws-kms";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cognitoIssuer } from "./auth-contract.js";
import { APPROVED_PUBLIC_ROUTE_KEYS, PUBLIC_ROUTE_ACKNOWLEDGEMENT } from "./public-routes.js";
import { assertDatabaseConfig, assertVerified, type OgeviaEnvironmentConfig } from "./config.js";
import {
  SIGNATURE_OBJECT_KEY_PATTERN,
  signatureBucketName,
  DOCUMENT_OBJECT_KEY_PATTERN,
  LOGO_OBJECT_KEY_PATTERN,
} from "./evidence-storage-stack.js";
import { ExistingFoundation } from "./existing-foundation.js";

export interface ServiceVerificationApiStackProps extends StackProps {
  readonly config: OgeviaEnvironmentConfig;
  readonly evidenceKey: kms.IKey;
  /** Extra browser origins (e.g. the CloudFront test-slice origin). */
  readonly extraAllowedOrigins?: readonly string[];
  /** Extra approved app clients (e.g. the test-slice client) for the JWT audience. */
  readonly extraAppClientIds?: readonly string[];
  /**
   * The application database secret this API reads. Production passes the secret
   * created by DatabaseSecretStack. Omitted ONLY for the pilot/test slice, which
   * keeps using the existing manually created secret; production never falls
   * back to it (enforced below).
   */
  readonly appDatabaseSecret?: secretsmanager.ISecret;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/** The real Service Verification handler (apps/sv-api), bundled by esbuild at synth. */
export const HANDLER_ENTRY = resolve(REPO_ROOT, "apps/sv-api/src/index.ts");
export const IDENTITY_HANDLER_ENTRY = resolve(REPO_ROOT, "apps/sv-api/src/identity-handler.ts");

/**
 * Caregiver invitations (0025). Fixed name so the Lambda VPC endpoint policy
 * (NetworkEgress stack) can name this one function without a cross-stack export.
 */
export function identityFunctionName(config: Pick<OgeviaEnvironmentConfig, "envName">): string {
  return `Ogevia-${config.envName}-IdentityAdmin`;
}

/**
 * Service Verification routes from docs/aws/MIGRATION_PLAN.md section 4. Every
 * route requires a Cognito access token; tenant/role checks happen server-side.
 */
export const SERVICE_VERIFICATION_ROUTES: ReadonlyArray<{
  readonly method: apigw.HttpMethod;
  readonly path: string;
  readonly public?: boolean;
}> = [
  { method: apigw.HttpMethod.GET, path: "/v1/me" },
  { method: apigw.HttpMethod.GET, path: "/v1/visits/active" },
  { method: apigw.HttpMethod.GET, path: "/v1/clients/assigned" },
  { method: apigw.HttpMethod.GET, path: "/v1/clients/{clientId}/services" },
  { method: apigw.HttpMethod.POST, path: "/v1/visits" },
  { method: apigw.HttpMethod.POST, path: "/v1/visits/{visitId}/end" },
  // Signature PNG travels in this request: Lambda validates, hashes and writes
  // it to S3 (SSE-KMS), then registers + confirms in one DB transaction.
  { method: apigw.HttpMethod.POST, path: "/v1/visits/{visitId}/confirm" },
  { method: apigw.HttpMethod.GET, path: "/v1/visits" },
  { method: apigw.HttpMethod.GET, path: "/v1/visits/{visitId}/corrections" },
  { method: apigw.HttpMethod.POST, path: "/v1/visits/{visitId}/corrections" },
  { method: apigw.HttpMethod.POST, path: "/v1/visits/{visitId}/close" },
  { method: apigw.HttpMethod.GET, path: "/v1/visits/{visitId}/signature" },
  { method: apigw.HttpMethod.GET, path: "/v1/reports/monthly-service-summary" },
  { method: apigw.HttpMethod.GET, path: "/v1/reports/monthly-approval-summary" },
  { method: apigw.HttpMethod.GET, path: "/v1/reports/correction-history" },
  { method: apigw.HttpMethod.GET, path: "/v1/billing-review" },
  { method: apigw.HttpMethod.POST, path: "/v1/me/display-name" },
  { method: apigw.HttpMethod.GET, path: "/v1/branding" },
  { method: apigw.HttpMethod.POST, path: "/v1/branding" },
  { method: apigw.HttpMethod.GET, path: "/v1/attention" },
  { method: apigw.HttpMethod.GET, path: "/v1/reports/utilisation" },
  { method: apigw.HttpMethod.POST, path: "/v1/branding/letterhead" },
  { method: apigw.HttpMethod.POST, path: "/v1/branding/logo" },
  { method: apigw.HttpMethod.POST, path: "/v1/branding/logo/clear" },
  { method: apigw.HttpMethod.GET, path: "/v1/branding/logo" },
  { method: apigw.HttpMethod.GET, path: "/v1/clients/directory" },
  { method: apigw.HttpMethod.POST, path: "/v1/clients/{clientId}/legal-name" },
  // Client and authorization administration (0022).
  { method: apigw.HttpMethod.GET, path: "/v1/client-types" },
  { method: apigw.HttpMethod.POST, path: "/v1/client-types" },
  { method: apigw.HttpMethod.GET, path: "/v1/services" },
  { method: apigw.HttpMethod.GET, path: "/v1/clients" },
  { method: apigw.HttpMethod.GET, path: "/v1/clients/{clientId}" },
  { method: apigw.HttpMethod.POST, path: "/v1/clients" },
  { method: apigw.HttpMethod.POST, path: "/v1/clients/{clientId}/details" },
  { method: apigw.HttpMethod.POST, path: "/v1/clients/{clientId}/status" },
  { method: apigw.HttpMethod.GET, path: "/v1/clients/{clientId}/authorizations" },
  { method: apigw.HttpMethod.POST, path: "/v1/clients/{clientId}/authorizations" },
  { method: apigw.HttpMethod.POST, path: "/v1/authorizations/{authorizationId}/amend" },
  // Care Team and services (0023).
  { method: apigw.HttpMethod.GET, path: "/v1/caregivers" },
  { method: apigw.HttpMethod.POST, path: "/v1/caregivers" },
  { method: apigw.HttpMethod.POST, path: "/v1/caregivers/{caregiverRecordId}/details" },
  { method: apigw.HttpMethod.POST, path: "/v1/caregivers/{caregiverRecordId}/status" },
  { method: apigw.HttpMethod.POST, path: "/v1/caregivers/{caregiverRecordId}/invitation" },
  { method: apigw.HttpMethod.POST, path: "/v1/caregivers/{caregiverRecordId}/invitation/resend" },
  { method: apigw.HttpMethod.GET, path: "/v1/accounts" },
  { method: apigw.HttpMethod.POST, path: "/v1/accounts/{userId}/disable" },
  { method: apigw.HttpMethod.POST, path: "/v1/accounts/{userId}/enable" },
  { method: apigw.HttpMethod.GET, path: "/v1/shifts" },
  { method: apigw.HttpMethod.POST, path: "/v1/shifts" },
  { method: apigw.HttpMethod.GET, path: "/v1/shift-series/preview" },
  { method: apigw.HttpMethod.GET, path: "/v1/shift-series" },
  { method: apigw.HttpMethod.POST, path: "/v1/shift-series" },
  { method: apigw.HttpMethod.POST, path: "/v1/shift-series/{seriesId}/change" },
  { method: apigw.HttpMethod.POST, path: "/v1/shift-series/{seriesId}/end" },
  { method: apigw.HttpMethod.POST, path: "/v1/shift-series/{seriesId}/extend" },
  { method: apigw.HttpMethod.GET, path: "/v1/hour-limits" },
  { method: apigw.HttpMethod.POST, path: "/v1/hour-limits" },
  { method: apigw.HttpMethod.GET, path: "/v1/caregiver-load" },
  { method: apigw.HttpMethod.POST, path: "/v1/shifts/{shiftId}/makeup" },
  { method: apigw.HttpMethod.POST, path: "/v1/shifts/{shiftId}/reschedule" },
  { method: apigw.HttpMethod.POST, path: "/v1/shifts/{shiftId}/callout" },
  { method: apigw.HttpMethod.POST, path: "/v1/shifts/{shiftId}/caregiver" },
  { method: apigw.HttpMethod.POST, path: "/v1/shifts/{shiftId}/cancel" },
  { method: apigw.HttpMethod.GET, path: "/v1/shifts/{shiftId}/coverage" },
  { method: apigw.HttpMethod.GET, path: "/v1/my-shifts" },
  { method: apigw.HttpMethod.POST, path: "/v1/my-shifts/{shiftId}/callout" },
  // Wave 1 (0050, 0051): open-shift pick-up and the agency's versioned schedule-variance rule. JWT like every staff route.
  { method: apigw.HttpMethod.GET, path: "/v1/open-shifts" },
  { method: apigw.HttpMethod.POST, path: "/v1/shifts/{shiftId}/pickup" },
  { method: apigw.HttpMethod.GET, path: "/v1/visit-rules" },
  { method: apigw.HttpMethod.POST, path: "/v1/visit-rules" },
  // Hire type / scheduling (caregivers.manage) and family relationship (assignments.manage), 0030.
  { method: apigw.HttpMethod.POST, path: "/v1/caregivers/{caregiverRecordId}/employment" },
  { method: apigw.HttpMethod.POST, path: "/v1/assignments/{assignmentId}/family-relationship" },
  // Continuity pack (0027): continuity.export only; JWT like every staff route.
  { method: apigw.HttpMethod.POST, path: "/v1/continuity/pack" },
  { method: apigw.HttpMethod.GET, path: "/v1/continuity/status" },
  // Outage visit records (0028): visits.manage only.
  { method: apigw.HttpMethod.POST, path: "/v1/outage-visits" },
  { method: apigw.HttpMethod.POST, path: "/v1/outage-visits/not-used" },
  { method: apigw.HttpMethod.GET, path: "/v1/outage-visits/reconciliation" },
  // Billing rounding (0029): policies (Administrator), preview and adjustments (billing approvers).
  { method: apigw.HttpMethod.GET, path: "/v1/billing-rounding/policies" },
  { method: apigw.HttpMethod.POST, path: "/v1/billing-rounding/policies" },
  { method: apigw.HttpMethod.GET, path: "/v1/billing-rounding/preview" },
  { method: apigw.HttpMethod.POST, path: "/v1/billing-rounding/adjustments" },
  { method: apigw.HttpMethod.POST, path: "/v1/billing-rounding/adjustments/{adjustmentId}/void" },
  { method: apigw.HttpMethod.POST, path: "/v1/services" },
  { method: apigw.HttpMethod.POST, path: "/v1/services/{serviceId}/name" },
  { method: apigw.HttpMethod.POST, path: "/v1/services/{serviceId}/status" },
  // Assignments (0024).
  { method: apigw.HttpMethod.GET, path: "/v1/assignments" },
  { method: apigw.HttpMethod.POST, path: "/v1/assignments" },
  { method: apigw.HttpMethod.POST, path: "/v1/assignments/{assignmentId}/end" },
  { method: apigw.HttpMethod.GET, path: "/v1/document-types" },
  { method: apigw.HttpMethod.POST, path: "/v1/document-types" },
  { method: apigw.HttpMethod.POST, path: "/v1/document-reminder-days" },
  { method: apigw.HttpMethod.GET, path: "/v1/documents/people" },
  { method: apigw.HttpMethod.GET, path: "/v1/documents" },
  { method: apigw.HttpMethod.GET, path: "/v1/documents/alerts" },
  { method: apigw.HttpMethod.POST, path: "/v1/documents/requests" },
  { method: apigw.HttpMethod.POST, path: "/v1/documents/{documentId}/versions" },
  { method: apigw.HttpMethod.POST, path: "/v1/document-versions/{versionId}/review" },
  { method: apigw.HttpMethod.GET, path: "/v1/document-versions/{versionId}/file" },
  { method: apigw.HttpMethod.GET, path: "/v1/billing-approvals" },
  { method: apigw.HttpMethod.POST, path: "/v1/visits/{visitId}/billing-approval" },
  { method: apigw.HttpMethod.GET, path: "/v1/visits/{visitId}/review" },
  { method: apigw.HttpMethod.POST, path: "/v1/visits/{visitId}/review-decision" },
  { method: apigw.HttpMethod.POST, path: "/v1/visit-review-decisions/{decisionId}/revoke" },
  { method: apigw.HttpMethod.POST, path: "/v1/visits/{visitId}/confirmation-requests" },
  { method: apigw.HttpMethod.GET, path: "/v1/visits/{visitId}/confirmation-requests" },
  { method: apigw.HttpMethod.POST, path: "/v1/visit-confirmation-requests/{requestId}/revoke" },
  { method: apigw.HttpMethod.POST, path: "/v1/visit-confirmation-requests/{requestId}/paper" },
  { method: apigw.HttpMethod.POST, path: "/v1/late-confirmations/{lateConfirmationId}/review" },
  { method: apigw.HttpMethod.GET, path: "/v1/late-confirmations/{lateConfirmationId}/evidence" },
  { method: apigw.HttpMethod.POST, path: "/v1/billing-approvals/{approvalId}/void" },
  { method: apigw.HttpMethod.GET, path: "/v1/public/care-portals/{token}", public: true },
  { method: apigw.HttpMethod.GET, path: "/v1/public/care-portals/{token}/requests", public: true },
  { method: apigw.HttpMethod.POST, path: "/v1/public/care-portals/{token}/requests", public: true },
  { method: apigw.HttpMethod.GET, path: "/v1/public/care-portals/{token}/requests/{requestId}", public: true },
  { method: apigw.HttpMethod.POST, path: "/v1/public/care-portals/{token}/requests/{requestId}/cancel", public: true },
  { method: apigw.HttpMethod.GET, path: "/v1/public/care-offers/{token}", public: true },
  { method: apigw.HttpMethod.POST, path: "/v1/public/care-offers/{token}/respond", public: true },
  { method: apigw.HttpMethod.POST, path: "/v1/public/care-offers/{token}/cancel-assignment", public: true },
  { method: apigw.HttpMethod.POST, path: "/v1/public/visit-confirmations/{token}/open", public: true },
  { method: apigw.HttpMethod.POST, path: "/v1/public/visit-confirmations/{token}/respond", public: true },
  { method: apigw.HttpMethod.GET, path: "/v1/care-requests" },
  { method: apigw.HttpMethod.GET, path: "/v1/care-requests/{requestId}/candidates" },
  { method: apigw.HttpMethod.GET, path: "/v1/care-requests/{requestId}/offers" },
  { method: apigw.HttpMethod.POST, path: "/v1/care-requests/{requestId}/offers" },
  { method: apigw.HttpMethod.POST, path: "/v1/care-requests/{requestId}/assign" },
  { method: apigw.HttpMethod.GET, path: "/v1/care-portals/clients" },
  { method: apigw.HttpMethod.POST, path: "/v1/care-portals" },
  { method: apigw.HttpMethod.POST, path: "/v1/care-portals/revoke" },
  { method: apigw.HttpMethod.GET, path: "/v1/care-alert-staff" },
  { method: apigw.HttpMethod.POST, path: "/v1/care-alert-staff" },
  { method: apigw.HttpMethod.GET, path: "/v1/care-notifications" },
  { method: apigw.HttpMethod.GET, path: "/v1/availability/me" },
  { method: apigw.HttpMethod.POST, path: "/v1/availability/me" },
  { method: apigw.HttpMethod.GET, path: "/v1/care-opportunities" },
  { method: apigw.HttpMethod.POST, path: "/v1/care-opportunities/{offerId}/respond" },
  // Caregiver-readiness release (0039-0043)
  { method: apigw.HttpMethod.GET, path: "/v1/availability" },
  { method: apigw.HttpMethod.POST, path: "/v1/availability/requests" },
  { method: apigw.HttpMethod.GET, path: "/v1/availability/requests" },
  { method: apigw.HttpMethod.GET, path: "/v1/availability/requests/{requestId}" },
  { method: apigw.HttpMethod.POST, path: "/v1/availability/requests/{requestId}/withdraw" },
  { method: apigw.HttpMethod.POST, path: "/v1/availability/requests/{requestId}/review" },
  { method: apigw.HttpMethod.POST, path: "/v1/caregivers/{caregiverRecordId}/availability" },
  { method: apigw.HttpMethod.POST, path: "/v1/availability/overrides" },
  { method: apigw.HttpMethod.GET, path: "/v1/caregiver-services" },
  { method: apigw.HttpMethod.POST, path: "/v1/caregiver-services" },
  { method: apigw.HttpMethod.POST, path: "/v1/caregiver-services/{approvalId}/revoke" },
  { method: apigw.HttpMethod.GET, path: "/v1/caregiver-services/review" },
  { method: apigw.HttpMethod.POST, path: "/v1/caregiver-services/bulk-approve" },
  { method: apigw.HttpMethod.GET, path: "/v1/readiness/flags" },
  { method: apigw.HttpMethod.GET, path: "/v1/document-requirements" },
  { method: apigw.HttpMethod.POST, path: "/v1/document-requirements/type" },
  { method: apigw.HttpMethod.POST, path: "/v1/document-requirements/policy" },
  { method: apigw.HttpMethod.GET, path: "/v1/document-readiness" },
  { method: apigw.HttpMethod.GET, path: "/v1/document-readiness/all" },
  { method: apigw.HttpMethod.GET, path: "/v1/readiness" },
  { method: apigw.HttpMethod.POST, path: "/v1/readiness/activate" },
  { method: apigw.HttpMethod.POST, path: "/v1/readiness/service-checks" },
  { method: apigw.HttpMethod.POST, path: "/v1/readiness/evaluate" },
  { method: apigw.HttpMethod.POST, path: "/v1/matching/candidates" },
  { method: apigw.HttpMethod.GET, path: "/v1/care-requests/{requestId}/matches" },
  { method: apigw.HttpMethod.GET, path: "/v1/experience-tags" },
  { method: apigw.HttpMethod.POST, path: "/v1/experience-tags" },
  { method: apigw.HttpMethod.GET, path: "/v1/experience/me" },
  { method: apigw.HttpMethod.POST, path: "/v1/experience/me" },
  { method: apigw.HttpMethod.GET, path: "/v1/caregivers/{caregiverRecordId}/experience" },
  { method: apigw.HttpMethod.POST, path: "/v1/caregivers/{caregiverRecordId}/experience/review" },
  { method: apigw.HttpMethod.GET, path: "/v1/clients/{clientId}/experience-requirements" },
  { method: apigw.HttpMethod.POST, path: "/v1/clients/{clientId}/experience-requirements" },
  { method: apigw.HttpMethod.POST, path: "/v1/caregivers/{caregiverRecordId}/zip" },
  { method: apigw.HttpMethod.POST, path: "/v1/clients/{clientId}/zip" },
  { method: apigw.HttpMethod.GET, path: "/v1/location-data" },
  { method: apigw.HttpMethod.GET, path: "/v1/caregivers/{caregiverRecordId}/zip" },
  { method: apigw.HttpMethod.GET, path: "/v1/clients/{clientId}/zip" },
];

/** Fails synthesis if a route is public without being on the exact approved list. */
export function assertPublicRoutesApproved(routes: ReadonlyArray<{ method: string; path: string; public?: boolean }>): void {
  const declared = routes.filter((r) => r.public).map((r) => `${r.method} ${r.path}`).sort();
  const approved = [...APPROVED_PUBLIC_ROUTE_KEYS].sort();
  if (JSON.stringify(declared) !== JSON.stringify(approved)) {
    throw new Error(`Public API routes must exactly match lib/public-routes.ts. Declared: ${declared.join(", ")}`);
  }
}

/**
 * Environment-variable contract for the Phase 4 handler. Identifiers only:
 * no secret values, no PHI. Credentials AND the database name are read at
 * runtime from the app secret (JSON keys username/password/dbname) by ARN:
 * RDS metadata has no application database name (DBName is null). See the
 * egress note in docs/aws/PHASE_1_CDK_ARCHITECTURE.md.
 */
export const LAMBDA_ENVIRONMENT_KEYS = [
  "OGEVIA_ENV",
  "DB_HOST",
  "DB_PORT",
  "DB_SECRET_ARN",
  "EVIDENCE_BUCKET",
  "EVIDENCE_KEY_ARN",
  "COGNITO_USER_POOL_ID",
  "COGNITO_APP_CLIENT_ID",
  "LOG_LEVEL",
  "DB_NAME",
  "DB_SET_ROLE",
  "NODE_EXTRA_CA_CERTS",
  "IDENTITY_FUNCTION_NAME",
] as const;


/**
 * B. NEW FUTURE INFRASTRUCTURE - FUTURE/PLANNED (Phase 4).
 *
 *   Cognito (existing pool, referenced) -> HTTP API (JWT authorizer)
 *     -> Lambda (existing private subnets, existing AppSecurityGroup)
 *       -> RDS PostgreSQL (existing, CloudFormation-owned, referenced)
 *       -> S3/KMS evidence storage (EvidenceStorageStack)
 *       -> Secrets Manager (existing app DB secret, referenced)
 *
 * The Lambda reuses the existing `ogevia-prod-data-layer` AppSecurityGroup,
 * which the RDS security group already admits on 5432, so no security-group
 * rule is created or changed. NOT DEPLOYED.
 */
export class ServiceVerificationApiStack extends Stack {
  public readonly handler: lambda.Function;
  public readonly identityHandler: lambda.Function;
  public readonly identityLogGroup: logs.LogGroup;
  public readonly api: apigw.HttpApi;
  public readonly handlerLogGroup: logs.LogGroup;
  public readonly accessLogGroup: logs.LogGroup;

  constructor(
    scope: Construct,
    id: string,
    props: ServiceVerificationApiStackProps,
  ) {
    super(scope, id, {
      ...props,
      terminationProtection: props.config.terminationProtection,
    });
    const { config } = props;
    const evidenceBucketName = signatureBucketName(config);
    const signatureObjectsArn = `arn:aws:s3:::${evidenceBucketName}/${SIGNATURE_OBJECT_KEY_PATTERN}`;
    const documentObjectsArn = `arn:aws:s3:::${evidenceBucketName}/${DOCUMENT_OBJECT_KEY_PATTERN}`;
    const logoObjectsArn = `arn:aws:s3:::${evidenceBucketName}/${LOGO_OBJECT_KEY_PATTERN}`;
    assertVerified(config.auth, "API auth contract");
    assertDatabaseConfig(config);
    const existing = new ExistingFoundation(this, "Existing", config.existing);
    if (config.database.purpose === "production" && !props.appDatabaseSecret) {
      throw new Error("Production API requires its dedicated database secret; it never falls back to the test slice's");
    }
    const appDatabaseSecret = props.appDatabaseSecret ?? existing.appDatabaseSecret;

    this.handlerLogGroup = new logs.LogGroup(this, "HandlerLogGroup", {
      retention: config.logRetention,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.accessLogGroup = new logs.LogGroup(this, "ApiAccessLogGroup", {
      retention: config.logRetention,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Explicit role instead of the AWS managed Lambda policies, which grant
    // logs:* and ENI actions on "*". Only the ENI actions below must stay on
    // "*": EC2 does not support resource-level permissions for the describe
    // call Lambda's VPC attachment depends on.
    const role = new iam.Role(this, "HandlerRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Ogevia Service Verification API handler (least privilege)",
    });
    // Customer-managed (not inline) policy: reviewable and attachable on its own.
    const policy = new iam.ManagedPolicy(this, "HandlerPolicy", {
      description: "Ogevia Service Verification API handler permissions",
      roles: [role],
    });
    policy.addStatements(
      new iam.PolicyStatement({
        sid: "WriteOwnLogGroup",
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [this.handlerLogGroup.logGroupArn],
      }),
    );
    policy.addStatements(
      new iam.PolicyStatement({
        sid: "VpcNetworkInterfaces",
        actions: [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface",
          "ec2:AssignPrivateIpAddresses",
          "ec2:UnassignPrivateIpAddresses",
        ],
        resources: ["*"],
      }),
    );
    policy.addStatements(
      new iam.PolicyStatement({
        sid: "ReadAppDatabaseSecret",
        actions: ["secretsmanager:GetSecretValue"],
        resources: [appDatabaseSecret.secretArn],
      }),
    );
    policy.addStatements(
      new iam.PolicyStatement({
        sid: "SignatureObjects",
        actions: ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"],
        // Only the documented key shape {org_uuid}/{visit_uuid}/client-signature.png.
        resources: [signatureObjectsArn],
      }),
    );
    policy.addStatements(
      new iam.PolicyStatement({
        sid: "StaffDocumentObjects",
        actions: ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"],
        // Only {org_uuid}/documents/{document_uuid}/{version_uuid} (0021).
        resources: [documentObjectsArn],
      }),
    );
    policy.addStatements(
      new iam.PolicyStatement({
        sid: "AgencyLogoObjects",
        actions: ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"],
        // Only {org_uuid}/branding/logo/{logo_uuid} (0020).
        resources: [logoObjectsArn],
      }),
    );
    policy.addStatements(
      new iam.PolicyStatement({
        sid: "EvidenceKeyForSignatureObjects",
        actions: ["kms:Decrypt", "kms:GenerateDataKey"],
        resources: [props.evidenceKey.keyArn],
        conditions: {
          StringEquals: {
            "kms:ViaService": `s3.${config.region}.amazonaws.com`,
          },
        },
      }),
    );

    // Caregiver invitations (0025). OUTSIDE the VPC: the pool has a managed-login
    // domain, so Cognito PrivateLink cannot be used and the private API Lambda has
    // no route to Cognito. This function can only create a user and resend the
    // invitation email on the one pool; it has no database, S3 or KMS access and
    // never handles a password (Cognito generates and emails it).
    this.identityLogGroup = new logs.LogGroup(this, "IdentityLogGroup", {
      retention: config.logRetention,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const identityRole = new iam.Role(this, "IdentityRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Ogevia identity function (Cognito create/resend, and switch a sign-in off or on)",
    });
    const identityPolicy = new iam.ManagedPolicy(this, "IdentityPolicy", {
      // Description is immutable in CloudFormation (changing it would REPLACE the policy), so it keeps its original wording.
      description: "Ogevia identity function: own logs + AdminCreateUser/AdminGetUser on the one user pool",
      roles: [identityRole],
    });
    identityPolicy.addStatements(
      new iam.PolicyStatement({
        sid: "WriteOwnLogGroup",
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [this.identityLogGroup.logGroupArn],
      }),
      new iam.PolicyStatement({
        sid: "CreateCaregiverSignIns",
        actions: ["cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser"],
        resources: [`arn:aws:cognito-idp:${config.region}:${config.account}:userpool/${existing.userPool.userPoolId}`],
      }),
      // 0048: an Admin can switch a person's sign-in off and on. These two actions cannot read or set a password, change an email,
      // assign a group, or delete anyone. The same one pool ARN; the database decides who may ask and for whom.
      new iam.PolicyStatement({
        sid: "SwitchSignInsOnOff",
        actions: ["cognito-idp:AdminDisableUser", "cognito-idp:AdminEnableUser"],
        resources: [`arn:aws:cognito-idp:${config.region}:${config.account}:userpool/${existing.userPool.userPoolId}`],
      }),
    );
    this.identityHandler = new nodejs.NodejsFunction(this, "IdentityHandler", {
      functionName: identityFunctionName(config),
      description: "Ogevia identity: Cognito create/get/disable/enable of sign-ins on one pool",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      entry: IDENTITY_HANDLER_ENTRY,
      handler: "handler",
      projectRoot: REPO_ROOT,
      depsLockFilePath: resolve(REPO_ROOT, "pnpm-lock.yaml"),
      bundling: { format: nodejs.OutputFormat.CJS, target: "node22", minify: true, sourceMap: false, forceDockerBundling: false },
      memorySize: 256,
      timeout: Duration.seconds(8),
      role: identityRole,
      logGroup: this.identityLogGroup,
      environment: { COGNITO_USER_POOL_ID: existing.userPool.userPoolId },
    });
    this.identityHandler.node.addDependency(identityPolicy);
    // Scoped to this one function; the API handler is still checked by the rule.
    Validations.of(this.identityHandler).acknowledge({
      id: "HIPAA.Security-LambdaInsideVPC",
      reason:
        "Deliberately outside the VPC: Cognito PrivateLink cannot serve a pool with a managed-login domain and NAT is deferred. The function has no database, S3, KMS or secret access; it only calls AdminCreateUser/AdminGetUser on the one pool and never handles a password.",
    });
    policy.addStatements(
      new iam.PolicyStatement({
        sid: "InvokeIdentityAdmin",
        actions: ["lambda:InvokeFunction"],
        resources: [this.identityHandler.functionArn],
      }),
    );

    this.handler = new nodejs.NodejsFunction(this, "Handler", {
      description: "Ogevia Service Verification API",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      entry: HANDLER_ENTRY,
      handler: "handler",
      projectRoot: REPO_ROOT,
      depsLockFilePath: resolve(REPO_ROOT, "pnpm-lock.yaml"),
      bundling: {
        format: nodejs.OutputFormat.CJS,
        target: "node22",
        minify: true,
        sourceMap: false,
        // Bundle the AWS SDK too (pinned, reproducible); pg-native is optional and unused.
        externalModules: ["pg-native"],
        forceDockerBundling: false,
      },
      memorySize: 512,
      timeout: Duration.seconds(10),
      role,
      logGroup: this.handlerLogGroup,
      vpc: existing.vpc,
      vpcSubnets: { subnets: existing.vpc.privateSubnets },
      securityGroups: [existing.prodAppSecurityGroup],
      allowPublicSubnet: false,
      environment: {
        OGEVIA_ENV: config.envName,
        DB_HOST: existing.prodDatabase.dbInstanceEndpointAddress,
        DB_PORT: existing.prodDatabase.dbInstanceEndpointPort,
        DB_SECRET_ARN: appDatabaseSecret.secretArn,
        EVIDENCE_BUCKET: evidenceBucketName,
        EVIDENCE_KEY_ARN: props.evidenceKey.keyArn,
        COGNITO_USER_POOL_ID: existing.userPool.userPoolId,
        COGNITO_APP_CLIENT_ID: [config.auth.appClientId, ...(props.extraAppClientIds ?? [])].join(","),
        LOG_LEVEL: "info",
        // The ONLY source of the database name (config.database.name): ogevia_sv_test
        // for env=prod, ogevia_prd for env=prd. Never set by hand outside CDK.
        DB_NAME: config.database.name,
        // The secret's login user is granted ogevia_app; every request also
        // SET LOCAL ROLEs to it (no table privileges, EXECUTE on ogevia_api only).
        DB_SET_ROLE: "ogevia_app",
        // Lambda Node.js 20+: adds the Amazon RDS CA bundle for verified TLS.
        NODE_EXTRA_CA_CERTS: "/var/runtime/ca-cert.pem",
        IDENTITY_FUNCTION_NAME: identityFunctionName(config),
      },
    });

    // Lambda validates at CREATE time that its execution role can manage VPC
    // ENIs. Those actions live in HandlerPolicy (a separate managed policy
    // attached to the role), so the function must not be created until the
    // policy exists and is attached. Without this, CloudFormation creates them
    // in parallel and the create fails ("...does not have permissions to call
    // CreateNetworkInterface on EC2"), as seen on the first test-slice deploy.
    this.handler.node.addDependency(policy);

    const authorizer = new HttpJwtAuthorizer(
      "CognitoJwt",
      cognitoIssuer(config.region, existing.userPool.userPoolId),
      { jwtAudience: [config.auth.appClientId, ...(props.extraAppClientIds ?? [])] },
    );

    this.api = new apigw.HttpApi(this, "Api", {
      description: "Ogevia Service Verification API",
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: [...config.auth.allowedOrigins, ...(props.extraAllowedOrigins ?? [])],
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["authorization", "content-type", "idempotency-key"],
        maxAge: Duration.hours(1),
      },
    });

    // Access log fields exclude path, query string, body, headers, and source
    // IP so no identifier beyond the route template ever reaches the logs.
    new apigw.HttpStage(this, "DefaultStage", {
      httpApi: this.api,
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 20, burstLimit: 50 },
      accessLogSettings: {
        destination: new apigw.LogGroupLogDestination(this.accessLogGroup),
        format: AccessLogFormat.custom(
          JSON.stringify({
            requestId: "$context.requestId",
            requestTime: "$context.requestTime",
            routeKey: "$context.routeKey",
            status: "$context.status",
            responseLatency: "$context.responseLatency",
            integrationStatus: "$context.integrationStatus",
            authorizerError: "$context.authorizer.error",
          }),
        ),
      },
    });

    new CfnOutput(this, "ApiUrl", { value: this.api.apiEndpoint });

    // ONE invoke permission for the whole API instead of one per route. A Lambda
    // resource policy is capped at 20 KB; per-route statements (about 340 bytes
    // each) passed it at 60 routes (deploy of 2026-10-04). The source ARN still
    // names only this API (arn:aws:execute-api:<region>:<account>:<apiId>/*/*/*);
    // who may call each route is unchanged: the JWT authorizer on every
    // non-public route decides that, not this permission.
    const integration = new HttpLambdaIntegration("Handler", this.handler, { scopePermissionToRoute: false });
    assertPublicRoutesApproved(SERVICE_VERIFICATION_ROUTES);
    for (const route of SERVICE_VERIFICATION_ROUTES) {
      const created = this.api.addRoutes({
        path: route.path,
        methods: [route.method],
        integration,
        ...(route.public ? {} : { authorizer }),
      });
      if (route.public) {
        for (const r of created) Validations.of(r).acknowledge({ id: "AwsSolutions-APIG4", reason: PUBLIC_ROUTE_ACKNOWLEDGEMENT });
      }
    }

    // Exact finding IDs. lib/template-scan.ts independently fails any wildcard
    // action and any Resource "*" outside the ENI action list.
    Validations.of(policy).acknowledge({
      id: "AwsSolutions-IAM5[Resource::*]",
      reason:
        "Only the five ec2 ENI actions Lambda VPC attachment needs; DescribeNetworkInterfaces has no resource-level permissions.",
    });
    Validations.of(policy).acknowledge({
      id: `AwsSolutions-IAM5[Resource::${signatureObjectsArn}]`,
      reason:
        "Object keys are per-visit UUIDs unknown at deploy time; restricted to the documented */*/client-signature.png shape. Tenant ownership is checked in PostgreSQL before every write and read.",
    });
    Validations.of(policy).acknowledge({
      id: `AwsSolutions-IAM5[Resource::${logoObjectsArn}]`,
      reason:
        "Agency logo keys are per-upload UUIDs unknown at deploy time; restricted to the documented */branding/logo/* shape. Only the owner can write (checked in PostgreSQL) and only agency members can read.",
    });
    Validations.of(policy).acknowledge({
      id: `AwsSolutions-IAM5[Resource::${documentObjectsArn}]`,
      reason:
        "Staff document keys are per-document/per-version UUIDs unknown at deploy time; restricted to the documented */documents/*/* shape. Tenant and person access is checked in PostgreSQL before every write and read.",
    });
    for (const ack of [
      {
        id: "HIPAA.Security-CloudWatchLogGroupEncrypted",
        reason:
          "CloudWatch Logs encrypts at rest with service-owned keys. Logs carry no PHI by design (access-log format and handler contract). A customer-managed key is an owner cost decision (PHASE_1_COST_MODEL.md).",
      },
      {
        id: "HIPAA.Security-LambdaConcurrency",
        reason:
          "VERIFIED account Lambda concurrency limit is 10 with 10 unreserved; AWS requires >= 10 unreserved, so no reserved concurrency can be set. API stage throttling (20 rps / 50 burst) caps load. A quota increase is a Phase 4 prerequisite.",
      },
      {
        id: "HIPAA.Security-LambdaDLQ",
        reason:
          "Invoked synchronously by API Gateway; DLQs apply only to asynchronous invocations. Failures surface to the caller and the LambdaErrors alarm.",
      },
    ]) {
      Validations.of(this).acknowledge(ack);
    }
  }
}
