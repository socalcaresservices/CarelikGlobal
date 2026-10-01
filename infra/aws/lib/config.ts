// Ogevia AWS environment configuration - the ONLY place live AWS identifiers
// may appear. Stack and construct code receives these through typed props and
// must never hard-code an account, VPC, subnet, security group, database, or
// pool identifier.
//
import { RetentionDays } from "aws-cdk-lib/aws-logs";

// Every identifier in `existing` was verified read-only (see
// docs/aws/CURRENT_AWS_INVENTORY.md and docs/aws/PHASE_1_CDK_ARCHITECTURE.md).
// CDK REFERENCES these resources; it does not own them. Referencing never
// creates, imports, or modifies a resource.

export const OGEVIA_ACCOUNT = "300094796789";
export const OGEVIA_REGION = "us-west-2";

export type OgeviaEnvName = "prod";

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
  /** Initial database name on the instance (non-secret). */
  readonly databaseName: string;
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
  readonly auth: {
    /** Cognito app client the API's JWT authorizer accepts (audience). */
    readonly appClientId: string;
    /** Browser origins allowed by API CORS. */
    readonly allowedOrigins: readonly string[];
  };
  readonly existing: ExistingFoundationIds;
}

export const ENVIRONMENTS: Record<OgeviaEnvName, OgeviaEnvironmentConfig> = {
  prod: {
    envName: "prod",
    account: OGEVIA_ACCOUNT,
    region: OGEVIA_REGION,
    terminationProtection: true,
    logRetention: RetentionDays.ONE_YEAR,
    auth: {
      appClientId: "__COGNITO_APP_CLIENT_ID__",
      // VERIFIED in repo: README.md APP_URL and organization-provider.tsx.
      allowedOrigins: ["https://app.ogevia.com"],
    },
    existing: {
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
          endpointAddress: "__RDS_ENDPOINT__",
          port: 5432,
          securityGroupIds: ["sg-00530a1f4f7648e65"],
          owner: {
            kind: "cloudformation",
            stackName: "ogevia-prod-data-layer",
            logicalId: "PostgreSQLDatabase",
          },
          databaseName: "__RDS_DB_NAME__",
          masterSecretArn: "__RDS_MASTER_SECRET_ARN__",
        },
      },
      appDatabaseSecretArn: "__APP_DB_SECRET_ARN__",
      cognitoUserPoolId: "us-west-2_849AYz5J7",
    },
  },
};

/**
 * Resolves the target environment from `-c env=<name>`. There is no default:
 * every synth/diff must name its target explicitly.
 */
export function resolveEnvironment(value: unknown): OgeviaEnvironmentConfig {
  if (value === "prod") return ENVIRONMENTS.prod;
  throw new Error(
    `Missing or unknown environment "${String(value)}". Pass -c env=prod. Valid: ${Object.keys(ENVIRONMENTS).join(", ")}`,
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
