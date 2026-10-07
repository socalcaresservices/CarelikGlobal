import { CfnOutput, Duration, RemovalPolicy, Stack, Validations, type StackProps } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import type { OgeviaEnvironmentConfig } from "./config.js";

export interface WebHostingStackProps extends StackProps {
  readonly config: OgeviaEnvironmentConfig;
}

/** Rewrites client-side routes (no file extension) to the SPA entry point. */
const SPA_REWRITE = `
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri === "/" || uri.lastIndexOf(".") <= uri.lastIndexOf("/")) {
    request.uri = "/index.html";
  }
  return request;
}`;

export function contentSecurityPolicy(cognitoDomain: string, region: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    // React style attributes and Vite-emitted CSS.
    "style-src 'self' 'unsafe-inline'",
    // data: for signature previews (PNG data URLs); blob: for canvas exports.
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // API (regional execute-api host until a custom API domain exists) + Cognito token endpoint.
    `connect-src 'self' https://*.execute-api.${region}.amazonaws.com ${cognitoDomain}`,
    `form-action 'self' ${cognitoDomain}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/**
 * Phase 6: AWS hosting for the Ogevia web app (prepared so Netlify can be
 * retired later; Netlify production is NOT changed).
 *
 *   Browser -> CloudFront (HTTPS, security headers, SPA rewrite)
 *           -> private S3 bucket via Origin Access Control (no public access)
 *
 * Plus a NEW public Cognito app client in the EXISTING user pool whose only
 * callback/logout URLs are this distribution (code + PKCE, no secret). The
 * existing `ogevia-web` client and the pool settings are not modified.
 *
 * The bucket holds only built static assets (no PHI). NOT DEPLOYED.
 */
export class WebHostingStack extends Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly siteBucket: s3.Bucket;
  public readonly testAppClient: cognito.CfnUserPoolClient;
  public readonly webOrigin: string;

  constructor(scope: Construct, id: string, props: WebHostingStackProps) {
    super(scope, id, { ...props, terminationProtection: props.config.terminationProtection });
    const { config } = props;

    const logBucket = new s3.Bucket(this, "WebLogBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      // CloudFront standard logging writes with ACLs.
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ id: "expire-web-logs", expiration: Duration.days(90), noncurrentVersionExpiration: Duration.days(30) }],
    });

    this.siteBucket = new s3.Bucket(this, "WebSiteBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: true,
      serverAccessLogsBucket: logBucket,
      serverAccessLogsPrefix: "site-bucket/",
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ id: "expire-old-builds", noncurrentVersionExpiration: Duration.days(30) }],
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      comment: "Ogevia web security headers",
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: contentSecurityPolicy(config.testSlice.cognitoDomain, config.region), override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [{ header: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()", override: true }],
      },
    });

    this.distribution = new cloudfront.Distribution(this, "WebDistribution", {
      comment: config.database.purpose === "production" ? `Ogevia ${config.envName} web` : `Ogevia ${config.envName} web (test slice)`,
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableLogging: true,
      logBucket,
      logFilePrefix: "cloudfront/",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: new cloudfront.Function(this, "SpaRewrite", {
              code: cloudfront.FunctionCode.fromInline(SPA_REWRITE),
              runtime: cloudfront.FunctionRuntime.JS_2_0,
              comment: "SPA route rewrite to /index.html",
            }),
          },
        ],
      },
    });
    this.webOrigin = `https://${this.distribution.distributionDomainName}`;

    this.testAppClient = new cognito.CfnUserPoolClient(this, "TestSliceAppClient", {
      userPoolId: config.existing.cognitoUserPoolId,
      // env=prod keeps its deployed name; production is not a test slice.
      clientName: config.database.purpose === "production" ? `ogevia-web-${config.envName}` : `ogevia-web-${config.envName}-test-slice`,
      generateSecret: false,
      allowedOAuthFlowsUserPoolClient: true,
      allowedOAuthFlows: ["code"],
      allowedOAuthScopes: ["openid", "email"],
      supportedIdentityProviders: ["COGNITO"],
      callbackUrLs: [`${this.webOrigin}/auth/callback`, ...config.testSlice.localDevOrigins.map((o) => `${o}/auth/callback`)],
      logoutUrLs: [`${this.webOrigin}/`, ...config.testSlice.localDevOrigins.map((o) => `${o}/`)],
      explicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"],
      preventUserExistenceErrors: "ENABLED",
      enableTokenRevocation: true,
      accessTokenValidity: 60,
      idTokenValidity: 60,
      refreshTokenValidity: 12,
      authSessionValidity: 3,
      tokenValidityUnits: { accessToken: "minutes", idToken: "minutes", refreshToken: "hours" },
    });

    // Managed login (v2) renders a client's sign-in pages from its branding
    // style; Cognito-provided defaults, no custom assets.
    new cognito.CfnManagedLoginBranding(this, "TestSliceManagedLogin", {
      userPoolId: config.existing.cognitoUserPoolId,
      clientId: this.testAppClient.ref,
      useCognitoProvidedValues: true,
    });

    new CfnOutput(this, "WebOrigin", { value: this.webOrigin });
    new CfnOutput(this, "DistributionId", { value: this.distribution.distributionId });
    new CfnOutput(this, "SiteBucketName", { value: this.siteBucket.bucketName });
    new CfnOutput(this, "TestAppClientId", { value: this.testAppClient.ref });

    for (const [node, acks] of [
      [logBucket, [
        { id: "AwsSolutions-S1", reason: "This is the access-log destination bucket itself." },
        { id: "HIPAA.Security-S3BucketLoggingEnabled", reason: "This is the access-log destination bucket itself." },
        { id: "HIPAA.Security-S3DefaultEncryptionKMS", reason: "CloudFront/S3 log delivery requires SSE-S3 on the target bucket." },
        { id: "HIPAA.Security-S3BucketReplicationEnabled", reason: "Static-site logs; replication is a DR/cost decision gate." },
      ]],
      [this.siteBucket, [
        { id: "HIPAA.Security-S3DefaultEncryptionKMS", reason: "Public static build assets (no PHI); SSE-S3 avoids KMS cost and OAC key-policy coupling." },
        { id: "HIPAA.Security-S3BucketReplicationEnabled", reason: "Rebuildable static assets; replication not needed." },
      ]],
      [this.distribution, [
        { id: "AwsSolutions-CFR1", reason: "No geo restriction: caregivers may travel; access is enforced by Cognito + API authorization." },
        { id: "AwsSolutions-CFR2", reason: "WAF is deferred per CLAUDE.md section 4 until the exposure model justifies it (static assets only)." },
        { id: "AwsSolutions-CFR4", reason: "Default *.cloudfront.net certificate for the test slice; TLSv1.2_2021 applies once a custom domain + ACM certificate is approved." },
      ]],
    ] as const) {
      for (const ack of acks) Validations.of(node).acknowledge(ack);
    }
  }
}
