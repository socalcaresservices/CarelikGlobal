import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import type { ExistingFoundationIds } from "./config.js";

/**
 * A. EXISTING RESOURCE REFERENCES.
 *
 * Typed handles to AWS resources that already exist and that CDK does NOT own.
 * Every handle comes from a static `from*Attributes` / `from*Id` factory, which:
 * - adds no CloudFormation resources to the template,
 * - makes no AWS API call at synth time (no `fromLookup`, so no
 *   cdk.context.json and no dependency on read credentials),
 * - never imports the resource into a CDK stack.
 *
 * Security groups are referenced with `mutable: false`. That makes CDK silently
 * skip any ingress/egress rule a future construct tries to add to them, so a
 * CDK change can never alter the CloudFormation-owned `ogevia-prod-data-layer`
 * security groups. Rules those groups need must be changed in their owning
 * stack, not here.
 *
 * This is a Construct, not a Stack: it is instantiated inside the future stacks
 * that need these handles, so no empty "reference stack" is ever deployable.
 */
export class ExistingFoundation extends Construct {
  public readonly vpc: ec2.IVpc;
  public readonly prodAppSecurityGroup: ec2.ISecurityGroup;
  public readonly prodRdsSecurityGroup: ec2.ISecurityGroup;
  public readonly dbAdminSecurityGroup: ec2.ISecurityGroup;
  public readonly ssmEndpoint: ec2.IInterfaceVpcEndpoint;
  public readonly ssmMessagesEndpoint: ec2.IInterfaceVpcEndpoint;
  public readonly prodDatabase: rds.IDatabaseInstance;
  public readonly prodDatabaseMasterSecret: secretsmanager.ISecret;
  public readonly appDatabaseSecret: secretsmanager.ISecret;
  public readonly userPool: cognito.IUserPool;

  constructor(scope: Construct, id: string, ids: ExistingFoundationIds) {
    super(scope, id);
    assertConfigured(ids);

    const { vpc } = ids;
    this.vpc = ec2.Vpc.fromVpcAttributes(this, "Vpc", {
      vpcId: vpc.vpcId,
      vpcCidrBlock: vpc.cidr,
      availabilityZones: [...vpc.availabilityZones],
      publicSubnetIds: vpc.publicSubnets.map((s) => s.subnetId),
      publicSubnetRouteTableIds: vpc.publicSubnets.map((s) => s.routeTableId),
      privateSubnetIds: vpc.privateSubnets.map((s) => s.subnetId),
      privateSubnetRouteTableIds: vpc.privateSubnets.map((s) => s.routeTableId),
    });

    const immutable = (logicalId: string, securityGroupId: string) =>
      ec2.SecurityGroup.fromSecurityGroupId(this, logicalId, securityGroupId, {
        mutable: false,
        allowAllOutbound: false,
      });
    this.prodAppSecurityGroup = immutable(
      "ProdAppSecurityGroup",
      ids.securityGroups.prodApp,
    );
    this.prodRdsSecurityGroup = immutable(
      "ProdRdsSecurityGroup",
      ids.securityGroups.prodRds,
    );
    this.dbAdminSecurityGroup = immutable(
      "DbAdminSecurityGroup",
      ids.securityGroups.dbAdmin,
    );

    const endpoint = (logicalId: string, vpcEndpointId: string) =>
      ec2.InterfaceVpcEndpoint.fromInterfaceVpcEndpointAttributes(
        this,
        logicalId,
        { vpcEndpointId, port: 443 },
      );
    this.ssmEndpoint = endpoint("SsmEndpoint", ids.ssmEndpoints.ssm);
    this.ssmMessagesEndpoint = endpoint(
      "SsmMessagesEndpoint",
      ids.ssmEndpoints.ssmMessages,
    );

    const db = ids.databases.prod;
    this.prodDatabase = rds.DatabaseInstance.fromDatabaseInstanceAttributes(
      this,
      "ProdDatabase",
      {
        instanceIdentifier: db.instanceIdentifier,
        instanceEndpointAddress: db.endpointAddress,
        port: db.port,
        securityGroups: db.securityGroupIds.map((sgId, index) =>
          index === 0 && sgId === ids.securityGroups.prodRds
            ? this.prodRdsSecurityGroup
            : immutable(`ProdDatabaseSecurityGroup${index}`, sgId),
        ),
        engine: rds.DatabaseInstanceEngine.POSTGRES,
      },
    );
    this.prodDatabaseMasterSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "ProdDatabaseMasterSecret",
      db.masterSecretName,
    );
    this.appDatabaseSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "AppDatabaseSecret",
      ids.appDatabaseSecretName,
    );

    this.userPool = cognito.UserPool.fromUserPoolId(
      this,
      "UserPool",
      ids.cognitoUserPoolId,
    );
  }
}

/** Fails synthesis if any identifier was left as an unverified placeholder. */
function assertConfigured(ids: ExistingFoundationIds): void {
  const placeholders: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (typeof value === "string" && /^__.+__$/.test(value)) {
      placeholders.push(path);
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        walk(child, path ? `${path}.${key}` : key);
      }
    }
  };
  walk(ids, "");
  if (placeholders.length > 0) {
    throw new Error(
      `Existing-resource identifiers not verified yet: ${placeholders.join(", ")}`,
    );
  }
  const { vpc } = ids;
  for (const tier of [vpc.publicSubnets, vpc.privateSubnets]) {
    tier.forEach((subnet, index) => {
      if (subnet.availabilityZone !== vpc.availabilityZones[index]) {
        throw new Error(
          `Subnet ${subnet.subnetId} must be listed in availabilityZones order`,
        );
      }
    });
  }
}
