import {
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
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { cognitoIssuer } from "./auth-contract.js";
import { assertVerified, type OgeviaEnvironmentConfig } from "./config.js";
import { ExistingFoundation } from "./existing-foundation.js";

export interface ServiceVerificationApiStackProps extends StackProps {
  readonly config: OgeviaEnvironmentConfig;
  readonly evidenceBucket: s3.IBucket;
  readonly evidenceKey: kms.IKey;
}

/**
 * Service Verification routes from docs/aws/MIGRATION_PLAN.md section 4. Every
 * route requires a Cognito access token; tenant/role checks happen server-side.
 */
export const SERVICE_VERIFICATION_ROUTES: ReadonlyArray<{
  readonly method: apigw.HttpMethod;
  readonly path: string;
}> = [
  { method: apigw.HttpMethod.GET, path: "/v1/visits/active" },
  { method: apigw.HttpMethod.GET, path: "/v1/clients/assigned" },
  { method: apigw.HttpMethod.GET, path: "/v1/clients/{clientId}/services" },
  { method: apigw.HttpMethod.POST, path: "/v1/visits" },
  { method: apigw.HttpMethod.POST, path: "/v1/visits/{visitId}/end" },
  {
    method: apigw.HttpMethod.POST,
    path: "/v1/visits/{visitId}/signature-upload",
  },
  { method: apigw.HttpMethod.POST, path: "/v1/visits/{visitId}/confirm" },
  { method: apigw.HttpMethod.POST, path: "/v1/visits/{visitId}/corrections" },
];

/**
 * Environment-variable contract for the Phase 4 handler. Identifiers only:
 * no secret values, no PHI. The DB password is fetched at runtime from
 * Secrets Manager by ARN (see the egress note in PHASE_1_CDK_ARCHITECTURE.md).
 */
export const LAMBDA_ENVIRONMENT_KEYS = [
  "OGEVIA_ENV",
  "DB_HOST",
  "DB_PORT",
  "DB_NAME",
  "DB_SECRET_ARN",
  "EVIDENCE_BUCKET",
  "EVIDENCE_KEY_ARN",
  "COGNITO_USER_POOL_ID",
  "COGNITO_APP_CLIENT_ID",
  "LOG_LEVEL",
] as const;

// Non-PHI placeholder so CDK can synthesize the function. It answers 501 for
// every route and logs nothing about the request. Replaced in Phase 4.
const PLACEHOLDER_HANDLER = `
exports.handler = async () => ({
  statusCode: 501,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ error: "not_implemented" }),
});
`;

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
    assertVerified(config.auth, "API auth contract");
    const existing = new ExistingFoundation(this, "Existing", config.existing);
    const db = config.existing.databases.prod;

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
        resources: [existing.appDatabaseSecret.secretArn],
      }),
    );
    policy.addStatements(
      new iam.PolicyStatement({
        sid: "SignatureObjects",
        actions: ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"],
        // Only the documented key shape {org_uuid}/{visit_uuid}/client-signature.png.
        resources: [
          props.evidenceBucket.arnForObjects("*/*/client-signature.png"),
        ],
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

    this.handler = new lambda.Function(this, "Handler", {
      description: "Ogevia Service Verification API (Phase 1 placeholder: 501)",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromInline(PLACEHOLDER_HANDLER),
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
        DB_NAME: db.databaseName,
        DB_SECRET_ARN: existing.appDatabaseSecret.secretArn,
        EVIDENCE_BUCKET: props.evidenceBucket.bucketName,
        EVIDENCE_KEY_ARN: props.evidenceKey.keyArn,
        COGNITO_USER_POOL_ID: existing.userPool.userPoolId,
        COGNITO_APP_CLIENT_ID: config.auth.appClientId,
        LOG_LEVEL: "info",
      },
    });

    const authorizer = new HttpJwtAuthorizer(
      "CognitoJwt",
      cognitoIssuer(config.region, existing.userPool.userPoolId),
      { jwtAudience: [config.auth.appClientId] },
    );

    this.api = new apigw.HttpApi(this, "Api", {
      description: "Ogevia Service Verification API",
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: [...config.auth.allowedOrigins],
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

    const integration = new HttpLambdaIntegration("Handler", this.handler);
    for (const route of SERVICE_VERIFICATION_ROUTES) {
      this.api.addRoutes({
        path: route.path,
        methods: [route.method],
        integration,
        authorizer,
      });
    }

    // Acknowledged on this one policy only. lib/template-scan.ts still fails
    // any wildcard action and any Resource "*" outside the ENI action list.
    Validations.of(policy).acknowledge({
      id: "AwsSolutions-IAM5",
      reason:
        "Two scoped wildcards: (1) Resource * for the five ec2 ENI actions Lambda VPC attachment needs (DescribeNetworkInterfaces has no resource-level permissions); (2) signature objects limited to */*/client-signature.png because keys are per-visit UUIDs; tenant ownership is checked server-side before every presign.",
    });
    for (const ack of [
      {
        id: "HIPAA.Security-CloudWatchLogGroupEncrypted",
        reason:
          "CloudWatch Logs encrypts at rest with service-owned keys. Logs carry no PHI by design (access-log format and handler contract). A customer-managed key is an owner cost decision (PHASE_1_COST_MODEL.md).",
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
