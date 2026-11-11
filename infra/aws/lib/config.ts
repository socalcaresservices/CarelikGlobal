// Ogevia AWS environment configuration - the ONLY place live AWS identifiers
// may appear. Stack and construct code receives these through typed props and
// must never hard-code an account, VPC, subnet, security group, database, or
// pool identifier.
//
import { RetentionDays } from "aws-cdk-lib/aws-logs";

// Every identifier below was VERIFIED on 2026-10-01 with read-only AWS APIs
// (ogevia-readonly / AWSReservedSSO_ReadOnlyAccess): describe-db-instances,
// describe-stacks (ogevia-prod-data-layer outputs), describe-subnets,
// describe-route-tables, describe-security-groups, describe-vpc-endpoints,
// list-secrets (metadata only), describe-user-pool, list-user-pool-clients.
// See docs/aws/PHASE_1_RESOURCE_OWNERSHIP.md.
// CDK REFERENCES these resources; it does not own them. Referencing never
// creates, imports, or modifies a resource.

export const OGEVIA_ACCOUNT = "300094796789";
export const OGEVIA_REGION = "us-west-2";

/**
 * "prod"  - the AWS production ACCOUNT's existing pilot/test-slice deployment
 *           (stacks Ogevia-prod-*, database ogevia_sv_test, synthetic data).
 *           Unchanged; kept so the running pilot is never repointed.
 * "prd"   - the PRODUCTION deployment (stacks Ogevia-prd-*, database
 *           ogevia_prd, its own app login + secret). Real data only here.
 */
export type OgeviaEnvName = "prod" | "prd";

/** The one database name production may ever use. */
export const PRODUCTION_DATABASE_NAME = "ogevia_prd";

export interface ExistingSubnetRef {
  readonly subnetId: string;
  readonly availabilityZone: string;
  readonly routeTableId: string;
}

export interface ExistingDatabaseRef {
  /** RDS DBInstanceIdentifier. */
  readonly instanceIdentifier: string;
  readonly endpointAddress: string;
  readonly port: number;
  /** Security groups attached to the instance (owned by `owner`). */
  readonly securityGroupIds: readonly string[];
  /** Who owns the instance's lifecycle. CDK never does in Phase 1. */
  readonly owner:
    | {
        readonly kind: "cloudformation";
        readonly stackName: string;
        readonly logicalId: string;
      }
    | { readonly kind: "unmanaged" };
  /** Complete ARN (with suffix) of the RDS-managed master secret. Metadata only. */
  readonly masterSecretArn: string;
}

export interface ExistingFoundationIds {
  readonly vpc: {
    readonly vpcId: string;
    readonly cidr: string;
    readonly availabilityZones: readonly string[];
    /** Same order as `availabilityZones`. */
    readonly publicSubnets: readonly ExistingSubnetRef[];
    /** Same order as `availabilityZones`. */
    readonly privateSubnets: readonly ExistingSubnetRef[];
  };
  /** CloudFormation stack that owns the production data layer. */
  readonly dataLayerStackName: string;
  readonly securityGroups: {
    /** ogevia-prod-data-layer AppSecurityGroup - future Lambda ENIs. */
    readonly prodApp: string;
    /** ogevia-prod-data-layer RDSSecurityGroup - 5432 from prodApp only. */
    readonly prodRds: string;
    /** ogevia-db-admin-sg - temporary admin host. */
    readonly dbAdmin: string;
  };
  readonly ssmEndpoints: {
    readonly ssm: string;
    readonly ssmMessages: string;
  };
  readonly databases: {
    /** CloudFormation-managed production database. REFERENCE only. */
    readonly prod: ExistingDatabaseRef;
  };
  /** Complete ARN of the manually created application DB secret. REFERENCE only. */
  readonly appDatabaseSecretArn: string;
  readonly cognitoUserPoolId: string;
}

export interface OgeviaEnvironmentConfig {
  readonly envName: OgeviaEnvName;
  readonly account: string;
  readonly region: string;
  /** CloudFormation termination protection for stacks CDK may later own. */
  readonly terminationProtection: boolean;
  /** Finite retention for every log group CDK creates (CLAUDE.md section 11). */
  readonly logRetention: RetentionDays;
  /**
   * Release switches: a feature whose API routes are added to this environment's API Gateway only when the owner has approved its release there.
   * staffDuplicates (pending migration 0093, infra/aws/db/pending): R6 duplicate-staff report and merge-review. OFF everywhere until the owner approves its release; adds
   * GET /v1/staff/duplicates and POST /v1/staff/{profileId}/merge only.
   * bulkImport (pending migration 0092, infra/aws/db/pending): R11 import of people and clients from a CSV file. OFF everywhere until the owner approves its release; turning it on
   * without applying 0092 would make the route fail. Adds POST /v1/imports/{kind} only.
   * signInOverride (pending migration 0090, infra/aws/db/pending): the administrator override for a caregiver who has not signed in yet. OFF everywhere until the owner approves its release in
   * that environment (demo first); with it off the two routes are not in the API at all.
   * staffManagement (pending migration 0086, infra/aws/db/pending): on for the pilot/test slice and, since the owner's approval of 2026-10-26, on for production (PRD below). An environment that has not applied 0086 must keep it false.
   */
  readonly features: { readonly staffManagement: boolean; readonly signInOverride: boolean; readonly bulkImport: boolean; readonly staffDuplicates: boolean };
  readonly auth: {
    /**
     * Existing Cognito app client the API's JWT authorizer accepts (audience).
     * VERIFIED 2026-10-01: "ogevia-web", public (no secret), code flow.
     */
    readonly appClientId: string;
    /** Browser origins allowed by API CORS. */
    readonly allowedOrigins: readonly string[];
    /**
     * Production only: this environment gets its OWN Cognito user pool, created by CDK (lib/auth-stack.ts), and its API accepts ONLY
     * that pool's app client. The legacy shared pool (`existing.cognitoUserPoolId`) and the legacy `appClientId` above are then never
     * accepted by this environment's API. Absent = the environment uses the shared pool (the pilot/test slice).
     */
    readonly dedicatedUserPool?: {
      /** Managed-login domain prefix, globally unique in the region: https://<prefix>.auth.<region>.amazoncognito.com */
      readonly domainPrefix: string;
    };
  };
  /**
   * Permanent hostnames (applied live 2026-10-23, Netlify DNS CNAMEs to the distribution). The CloudFront URL keeps working as a fallback.
   * Hostnames become CloudFront alternate domain names, Cognito callback/logout URLs and API CORS origins.
   */
  readonly customDomains?: {
    readonly hostnames: readonly string[];
    /** us-east-1 ACM certificate covering every hostname (DNS-validated). An identifier, not a secret. */
    readonly certificateArn: string;
  };
  readonly existing: ExistingFoundationIds;
  /**
   * The application database this environment's Lambda connects to. The ONLY
   * source of the Lambda's DB_NAME. Production must never resolve to the test
   * database (assertDatabaseConfig).
   */
  readonly database: {
    readonly purpose: "test-slice" | "production";
    /** Database inside the existing RDS instance. */
    readonly name: string;
    /** Production only: the dedicated application login role. */
    readonly appLogin?: string;
    /**
     * Production only: Secrets Manager NAME of the dedicated application
     * secret. CDK creates it (generated password; never in Git or output).
     */
    readonly appSecretName?: string;
  };
  /** D-P1-1 network egress for the private Lambda (no NAT). */
  readonly egress: {
    /** AZs hosting the Secrets Manager interface endpoint (FIXED cost per AZ). */
    readonly secretsEndpointAzCount: number;
    /**
     * Use the NetworkEgress endpoints owned by this other environment instead
     * of creating new ones. Private-DNS interface endpoints are unique per VPC
     * and service, so a second environment in the same VPC must share them;
     * the owning environment's endpoint policies then also admit this one.
     */
    readonly sharedWith?: OgeviaEnvName;
  };
  /**
   * Phase 6 testable vertical slice: CloudFront-hosted frontend and a NEW
   * public Cognito app client (code + PKCE) bound to that distribution.
   */
  readonly testSlice: {
    /** Application database inside the existing RDS instance (synthetic data only). */
    readonly databaseName: string;
    /** Extra local-dev callback, e.g. http://localhost:5173/auth/callback. Empty = none. */
    readonly localDevOrigins: readonly string[];
    /** Managed-login domain (existing, VERIFIED): https://<prefix>.auth.<region>.amazoncognito.com */
    readonly cognitoDomain: string;
  };
}

/** ACM certificate (us-east-1) for app/admin/demo.ogevia.com, issued 2026-10-23. */
const WEB_CERTIFICATE_ARN = "arn:aws:acm:us-east-1:300094796789:certificate/bfc4e928-f387-4804-a8d6-6eb351cfb526";

// Keep the verified production foundation independent of future TEST overrides.
// Cloning copies nested database/security-group/subnet references too. No AWS target changes here.
const PRODUCTION_FOUNDATION: ExistingFoundationIds = {
  vpc: {
    vpcId: "vpc-0ee9df0c38297cbc1",
    cidr: "10.20.0.0/16",
    availabilityZones: ["us-west-2a", "us-west-2b"],
    publicSubnets: [
      {
        subnetId: "subnet-04eadfc8b60aa82a0",
        availabilityZone: "us-west-2a",
        routeTableId: "rtb-01743eaf415a10e5a",
      },
      {
        subnetId: "subnet-0877a622ff17a7eda",
        availabilityZone: "us-west-2b",
        routeTableId: "rtb-01743eaf415a10e5a",
      },
    ],
    privateSubnets: [
      {
        subnetId: "subnet-08d40e6ac210b09e5",
        availabilityZone: "us-west-2a",
        routeTableId: "rtb-0bb8bac7d607a3737",
      },
      {
        subnetId: "subnet-02b96c15c06ac5010",
        availabilityZone: "us-west-2b",
        routeTableId: "rtb-049d4448ab6a01e48",
      },
    ],
  },
  dataLayerStackName: "ogevia-prod-data-layer",
  securityGroups: {
    prodApp: "sg-064ffce3bcbe8eb3b",
    prodRds: "sg-00530a1f4f7648e65",
    dbAdmin: "sg-00e01e2ca80442c1f",
  },
  ssmEndpoints: {
    ssm: "vpce-09dff848221f90105",
    ssmMessages: "vpce-0cfe984c8b634eb0d",
  },
  databases: {
    prod: {
      instanceIdentifier: "ogevia-prod-postgres",
      endpointAddress:
        "ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com",
      port: 5432,
      securityGroupIds: ["sg-00530a1f4f7648e65"],
      owner: {
        kind: "cloudformation",
        stackName: "ogevia-prod-data-layer",
        logicalId: "PostgreSQLDatabase",
      },
      masterSecretArn:
        "arn:aws:secretsmanager:us-west-2:300094796789:secret:rds!db-ceb5276c-c146-4b3d-9ce6-dab7b70e0cfa-PRte3a",
    },
  },
  appDatabaseSecretArn:
    "arn:aws:secretsmanager:us-west-2:300094796789:secret:ogevia/database/app-JsOTVQ",
  cognitoUserPoolId: "us-west-2_849AYz5J7",
};
const TEST_FOUNDATION: ExistingFoundationIds = structuredClone(PRODUCTION_FOUNDATION);

const PROD: OgeviaEnvironmentConfig = {
    envName: "prod",
    customDomains: { hostnames: ["demo.ogevia.com"], certificateArn: WEB_CERTIFICATE_ARN },
    account: OGEVIA_ACCOUNT,
    region: OGEVIA_REGION,
    terminationProtection: true,
    logRetention: RetentionDays.ONE_YEAR,
    features: { staffManagement: true, signInOverride: true, bulkImport: true, staffDuplicates: false },
    auth: {
      appClientId: "1i27abbina08fvg1i9u8vprgo9",
      // VERIFIED in repo: README.md APP_URL and organization-provider.tsx.
      allowedOrigins: ["https://app.ogevia.com"],
    },
    existing: TEST_FOUNDATION,
    database: {
      purpose: "test-slice",
      // Single source: the Lambda's DB_NAME for env=prod is the test slice.
      name: "ogevia_sv_test",
    },
    egress: {
      // Recommended 1 AZ for the pilot (~$7.30/month). Lambda reads the secret
      // once per container, so the endpoint is only on the cold-start path.
      // 2 = AZ redundancy (~$14.60/month).
      secretsEndpointAzCount: 1,
    },
    testSlice: {
      // A separate database in the existing instance keeps synthetic test data
      // apart from the future production database.
      databaseName: "ogevia_sv_test",
      localDevOrigins: [],
      // VERIFIED 2026-10-01 (describe-user-pool-domain): prefix us-west-2849ayz5j7, ACTIVE, managed login v2.
      cognitoDomain: "https://us-west-2849ayz5j7.auth.us-west-2.amazoncognito.com",
    },
};

/**
 * PRODUCTION. Same AWS account, VPC, RDS instance, Cognito pool and Lambda
 * subnets/security group as the pilot (all REFERENCED, none owned), but:
 * separate CloudFormation stacks (Ogevia-prd-*), a separate evidence bucket and
 * KMS key, a separate database (ogevia_prd) inside the existing instance, and a
 * separate application login + secret that cannot connect to the test database.
 * Nothing here falls back to the test slice: assertDatabaseConfig refuses it.
 */
const PRD: OgeviaEnvironmentConfig = {
  ...PROD,
  existing: PRODUCTION_FOUNDATION,
  envName: "prd",
  features: { staffManagement: true, signInOverride: false, bulkImport: false, staffDuplicates: false },   // production: the owner approved the staff-management release on 2026-10-25 (Pacific) together with migration 0086 (db/pending, applied outside the ledger like TEST); see docs/releases/2026-10-26-redesign/PRODUCTION_RELEASE_PREPARATION.md
  customDomains: { hostnames: ["app.ogevia.com", "admin.ogevia.com"], certificateArn: WEB_CERTIFICATE_ARN },
  // Separate sign-in from the pilot: a dedicated user pool and client (lib/auth-stack.ts). `existing.cognitoUserPoolId` and
  // `auth.appClientId` are inherited from PROD only so they can be NAMED as forbidden for production; its API never accepts them.
  auth: { ...PROD.auth, dedicatedUserPool: { domainPrefix: `ogevia-prd-${OGEVIA_ACCOUNT}` } },
  database: {
    purpose: "production",
    name: PRODUCTION_DATABASE_NAME,
    appLogin: "ogevia_prd_app",
    appSecretName: "ogevia/prd/database/app",
  },
  egress: { ...PROD.egress, sharedWith: "prod" },
};

export const ENVIRONMENTS: Record<OgeviaEnvName, OgeviaEnvironmentConfig> = {
  prod: PROD,
  prd: PRD,
};

/** Secret ARN pattern (Secrets Manager appends "-" + 6 random characters). */
export function secretArnPattern(config: OgeviaEnvironmentConfig): string {
  return `arn:aws:secretsmanager:${config.region}:${config.account}:secret:${config.database.appSecretName}-??????`;
}

/**
 * Fails closed on any production database misconfiguration. Production must
 * name ogevia_prd, a dedicated login and a dedicated secret, and must never
 * resolve to the test-slice database, the shared test secret, or the shared
 * `ogevia_app` role. The test slice must keep naming its own database.
 */
export function assertDatabaseConfig(config: OgeviaEnvironmentConfig): void {
  const { database: db } = config;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(db.name ?? "")) {
    throw new Error(`env "${config.envName}": database.name is missing or malformed`);
  }
  if (db.purpose === "test-slice") {
    if (config.envName === "prd" || db.name !== config.testSlice.databaseName) {
      throw new Error(`env "${config.envName}": test-slice database must be testSlice.databaseName`);
    }
    return;
  }
  if (config.envName !== "prd") {
    throw new Error(`Only env "prd" may use a production database (got "${config.envName}")`);
  }
  if (db.name !== PRODUCTION_DATABASE_NAME) {
    throw new Error(`Production database must be ${PRODUCTION_DATABASE_NAME}`);
  }
  if (db.name === config.testSlice.databaseName || /test/.test(db.name)) {
    throw new Error("Production database must not be the test-slice database");
  }
  if (!db.appLogin || !/^[a-z_][a-z0-9_]{0,62}$/.test(db.appLogin) || db.appLogin === "ogevia_app" || /test/.test(db.appLogin)) {
    throw new Error("Production needs its own application login (not ogevia_app, not a test role)");
  }
  if (
    !db.appSecretName ||
    !/^ogevia\/[A-Za-z0-9/_+=.@-]{1,200}$/.test(db.appSecretName) ||
    db.appSecretName === "ogevia/database/app" ||
    config.existing.appDatabaseSecretArn.includes(`:secret:${db.appSecretName}-`)
  ) {
    throw new Error("Production needs its own Secrets Manager secret, distinct from the test slice's");
  }
}

/**
 * Fails closed on authentication misconfiguration: production owns a dedicated pool whose domain differs from the shared one;
 * the pilot/test slice must keep using the shared pool and never acquire a dedicated one by accident.
 */
export function assertAuthConfig(config: OgeviaEnvironmentConfig): void {
  const dedicated = config.auth.dedicatedUserPool;
  if (config.envName !== "prd") {
    if (dedicated) throw new Error(`env "${config.envName}": only production (prd) may have a dedicated user pool`);
    return;
  }
  if (!dedicated) throw new Error("Production (prd) must have its own dedicated Cognito user pool (config.auth.dedicatedUserPool)");
  const prefix = dedicated.domainPrefix;
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(prefix) || /aws|amazon|cognito/.test(prefix)) {
    throw new Error("Production's user pool domain prefix is malformed (lowercase letters, digits, hyphens; must not contain aws, amazon or cognito)");
  }
  if (config.testSlice.cognitoDomain.includes(`//${prefix}.auth.`)) {
    throw new Error("Production's user pool domain must differ from the shared pool's domain");
  }
}

/**
 * The managed-login (token endpoint) origin this environment's website talks to: its own dedicated pool's domain, else the shared pilot pool's.
 * The website's Content-Security-Policy `connect-src` must allow exactly this origin, or the browser blocks the sign-in code exchange.
 */
export function webAuthDomain(config: OgeviaEnvironmentConfig): string {
  const dedicated = config.auth.dedicatedUserPool;
  return dedicated ? `https://${dedicated.domainPrefix}.auth.${config.region}.amazoncognito.com` : config.testSlice.cognitoDomain;
}

/** The shared (pilot/test) pool id: production's API and Lambda must refuse it. */
export function forbiddenUserPoolIdsFor(config: OgeviaEnvironmentConfig): readonly string[] {
  return config.auth.dedicatedUserPool ? [PROD.existing.cognitoUserPoolId] : [];
}

/**
 * Resolves the target environment from `-c env=<name>`. There is no default:
 * every synth/diff must name its target explicitly.
 */
export function resolveEnvironment(value: unknown): OgeviaEnvironmentConfig {
  // "prod" = the existing pilot/test slice (ogevia_sv_test). "prd" (alias
  // "production") = the production database path (ogevia_prd). Both are
  // explicit; there is no default and no fallback between them.
  const name = value === "production" ? "prd" : value;
  if (name === "prod" || name === "prd") {
    const config = ENVIRONMENTS[name];
    assertDatabaseConfig(config);
    assertAuthConfig(config);
    return config;
  }
  throw new Error(
    `Missing or unknown environment "${String(value)}". Pass -c env=prod (pilot/test slice) or -c env=prd (production). Valid: ${Object.keys(ENVIRONMENTS).join(", ")}`,
  );
}

/**
 * Refuses to synthesize against credentials for a different account. The CDK
 * CLI sets CDK_DEFAULT_ACCOUNT from the active profile; when it is absent
 * (offline synth/tests) the configured account is used unchanged.
 */
export function assertAccount(
  config: OgeviaEnvironmentConfig,
  resolvedAccount: string | undefined,
): void {
  if (resolvedAccount !== undefined && resolvedAccount !== config.account) {
    throw new Error(
      `Active AWS credentials are for account ${resolvedAccount}, but env "${config.envName}" targets ${config.account}. Refusing to synthesize.`,
    );
  }
}

/** Paths of any `__PLACEHOLDER__` values left in a config object. */
export function findPlaceholders(value: unknown, path = ""): string[] {
  if (typeof value === "string") return /^__.+__$/.test(value) ? [path] : [];
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      findPlaceholders(child, path ? `${path}.${key}` : key),
    );
  }
  return [];
}

/** Synthesis fails safely instead of falling back to creating a resource. */
export function assertVerified(value: unknown, label: string): void {
  const placeholders = findPlaceholders(value);
  if (placeholders.length > 0) {
    throw new Error(`${label} not verified yet: ${placeholders.join(", ")}`);
  }
}

/** https origins of the environment's permanent hostnames. */
export function customOriginsFor(config: OgeviaEnvironmentConfig): readonly string[] {
  return (config.customDomains?.hostnames ?? []).map((h) => `https://${h}`);
}

/** Fails closed on a malformed hostname or a certificate that CloudFront cannot use (it must be in us-east-1). */
export function assertCustomDomains(config: OgeviaEnvironmentConfig): void {
  const domains = config.customDomains;
  if (!domains) return;
  if (domains.hostnames.length === 0) throw new Error(`env "${config.envName}": customDomains needs at least one hostname`);
  for (const h of domains.hostnames) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) throw new Error(`env "${config.envName}": invalid hostname "${h}"`);
  }
  if (!/^arn:aws:acm:us-east-1:\d{12}:certificate\/[0-9a-f-]{36}$/.test(domains.certificateArn)) {
    throw new Error(`env "${config.envName}": the certificate must be an ACM certificate ARN in us-east-1`);
  }
}
