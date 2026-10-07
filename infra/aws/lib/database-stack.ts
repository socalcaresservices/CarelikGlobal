import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import type { Construct } from "constructs";
import type { OgeviaConfig } from "./config.js";

export interface DatabaseStackProps extends StackProps {
  key: kms.IKey;
}

/** Private, encrypted RDS PostgreSQL. Never public. Single-AZ/small outside prd (cost). */
export class DatabaseStack extends Stack {
  public readonly vpc: ec2.IVpc;
  public readonly subnets: ec2.ISubnet[];
  public readonly dbSecurityGroup: ec2.SecurityGroup;
  public readonly lambdaSecurityGroup: ec2.SecurityGroup;
  public readonly instance: rds.DatabaseInstance;

  constructor(scope: Construct, id: string, cfg: OgeviaConfig, props: DatabaseStackProps) {
    super(scope, id, props);
    this.vpc = ec2.Vpc.fromVpcAttributes(this, "Vpc", {
      vpcId: cfg.vpcId,
      availabilityZones: cfg.azs,
      privateSubnetIds: cfg.privateSubnetIds,
    });
    this.subnets = cfg.privateSubnetIds.map((sid, i) =>
      ec2.Subnet.fromSubnetId(this, `PrivSubnet${i}`, sid),
    );
    this.dbSecurityGroup = new ec2.SecurityGroup(this, "DbSg", {
      vpc: this.vpc,
      description: "Ogevia RDS PostgreSQL",
      allowAllOutbound: false,
    });
    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, "LambdaSg", {
      vpc: this.vpc,
      description: "Ogevia API Lambda",
      allowAllOutbound: false,
    });
    this.dbSecurityGroup.addIngressRule(this.lambdaSecurityGroup, ec2.Port.tcp(5432), "API Lambda");
    this.dbSecurityGroup.addIngressRule(
      ec2.SecurityGroup.fromSecurityGroupId(this, "AdminSg", cfg.dbAdminSecurityGroupId),
      ec2.Port.tcp(5432),
      "DB admin host (SSM)",
    );
    this.lambdaSecurityGroup.addEgressRule(this.dbSecurityGroup, ec2.Port.tcp(5432), "to RDS");

    this.instance = new rds.DatabaseInstance(this, "Postgres", {
      instanceIdentifier: `ogevia-${cfg.stage}-postgres`,
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: this.vpc,
      vpcSubnets: { subnets: this.subnets },
      securityGroups: [this.dbSecurityGroup],
      publiclyAccessible: false,
      multiAz: cfg.isProd,
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageEncrypted: true,
      storageEncryptionKey: props.key,
      credentials: rds.Credentials.fromGeneratedSecret("ogevia_admin", { encryptionKey: props.key }),
      databaseName: "ogevia",
      backupRetention: Duration.days(cfg.isProd ? 14 : 7),
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      enablePerformanceInsights: false,
      parameterGroup: new rds.ParameterGroup(this, "Params", {
        engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
        parameters: { "rds.force_ssl": "1" },
      }),
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
    });
  }
}
