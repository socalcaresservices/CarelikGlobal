import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as rds from "aws-cdk-lib/aws-rds";
import type * as kms from "aws-cdk-lib/aws-kms";
import type * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { API_ROUTES } from "./api-routes.js";
import type { OgeviaConfig } from "./config.js";

export interface ApiStackProps extends StackProps {
  vpc: ec2.IVpc;
  subnets: ec2.ISubnet[];
  lambdaSecurityGroup: ec2.ISecurityGroup;
  db: rds.DatabaseInstance;
  bucket: s3.Bucket;
  key: kms.Key;
  userPool: cognito.IUserPool;
  client: cognito.IUserPoolClient;
  allowedOrigins: string[];
}

export class ApiStack extends Stack {
  public readonly fn: lambda.Function;
  public readonly api: apigw.HttpApi;

  constructor(scope: Construct, id: string, cfg: OgeviaConfig, props: ApiStackProps) {
    super(scope, id, props);
    this.fn = new lambda.Function(this, "ApiFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset("lambda/api"),
      memorySize: 256,
      timeout: Duration.seconds(15),
      vpc: props.vpc,
      vpcSubnets: { subnets: props.subnets },
      securityGroups: [props.lambdaSecurityGroup],
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        STAGE: cfg.stage,
        DB_SECRET_ARN: props.db.secret?.secretArn ?? "",
        SIGNATURE_BUCKET: props.bucket.bucketName,
      },
    });
    // Identity-policy-only grants (the key policy delegates to IAM) so Evidence/Database
    // stacks do not depend on this stack's role (avoids a cross-stack dependency cycle).
    if (props.db.secret) {
      this.fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"], resources: [props.db.secret.secretArn],
      }));
    }
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject", "s3:PutObject"], resources: [props.bucket.arnForObjects("*")],
    }));
    this.fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["kms:Decrypt", "kms:GenerateDataKey"], resources: [props.key.keyArn],
    }));
    // NOTE: a VPC Lambda reaching Secrets Manager/KMS needs interface endpoints or NAT.
    // Neither is created here (cost approval required, CLAUDE.md §11).

    this.api = new apigw.HttpApi(this, "Api", {
      apiName: `ogevia-${cfg.stage}`,
      corsPreflight: {
        allowOrigins: props.allowedOrigins,
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST],
        allowHeaders: ["authorization", "content-type", "idempotency-key"],
        maxAge: Duration.hours(1),
      },
    });
    const authorizer = new HttpJwtAuthorizer(
      "CognitoJwt",
      `https://cognito-idp.${cfg.region}.amazonaws.com/${props.userPool.userPoolId}`,
      { jwtAudience: [props.client.userPoolClientId] },
    );
    const integration = new HttpLambdaIntegration("ApiIntegration", this.fn);
    for (const r of API_ROUTES) {
      this.api.addRoutes({
        path: r.path,
        methods: [r.method === "GET" ? apigw.HttpMethod.GET : apigw.HttpMethod.POST],
        integration,
        authorizer,
      });
    }
  }
}
