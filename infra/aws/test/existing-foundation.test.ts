import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { describe, expect, it } from "vitest";
import { ENVIRONMENTS, type ExistingFoundationIds } from "../lib/config.js";
import { ExistingFoundation } from "../lib/existing-foundation.js";
import { newApp, type CfnResource } from "./helpers.js";

const prod = ENVIRONMENTS.prod;

function build(ids: ExistingFoundationIds = prod.existing) {
  const app = newApp();
  const stack = new Stack(app, "ReferenceConsumer", {
    env: { account: prod.account, region: prod.region },
  });
  const foundation = new ExistingFoundation(stack, "Existing", ids);
  return { stack, foundation };
}

function resources(stack: Stack): CfnResource[] {
  const json = Template.fromStack(stack).toJSON() as {
    Resources?: Record<string, CfnResource>;
  };
  return Object.values(json.Resources ?? {});
}

describe("ExistingFoundation (reference only)", () => {
  it("references the existing VPC and subnets by configured ID", () => {
    const { foundation } = build();
    expect(foundation.vpc.vpcId).toBe(prod.existing.vpc.vpcId);
    expect(foundation.vpc.vpcCidrBlock).toBe(prod.existing.vpc.cidr);
    expect(foundation.vpc.privateSubnets.map((s) => s.subnetId)).toEqual(
      prod.existing.vpc.privateSubnets.map((s) => s.subnetId),
    );
    expect(foundation.vpc.publicSubnets.map((s) => s.subnetId)).toEqual(
      prod.existing.vpc.publicSubnets.map((s) => s.subnetId),
    );
  });

  it("references the CloudFormation-owned prod RDS and its security groups by configured ID", () => {
    const { foundation } = build();
    const db = prod.existing.databases.prod;
    expect(foundation.prodDatabase.instanceIdentifier).toBe(
      db.instanceIdentifier,
    );
    expect(foundation.prodDatabase.dbInstanceEndpointAddress).toBe(
      db.endpointAddress,
    );
    expect(foundation.prodRdsSecurityGroup.securityGroupId).toBe(
      prod.existing.securityGroups.prodRds,
    );
    expect(foundation.prodAppSecurityGroup.securityGroupId).toBe(
      prod.existing.securityGroups.prodApp,
    );
    expect(foundation.userPool.userPoolId).toBe(
      prod.existing.cognitoUserPoolId,
    );
  });

  it("adds no CloudFormation resources: nothing is created, imported, or claimed", () => {
    const { stack } = build();
    expect(
      resources(stack).filter((r) => r.Type !== "AWS::CDK::Metadata"),
    ).toEqual([]);
  });

  it("cannot add rules to CloudFormation-owned security groups, even when a construct asks", () => {
    const { stack, foundation } = build();
    // What a future Lambda/admin construct might naively do:
    foundation.prodDatabase.connections.allowDefaultPortFrom(
      foundation.prodAppSecurityGroup,
    );
    foundation.prodRdsSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(5432),
      "must never be emitted",
    );
    foundation.prodAppSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.allTraffic(),
    );
    expect(
      resources(stack).filter((r) => r.Type !== "AWS::CDK::Metadata"),
    ).toEqual([]);
  });

  it("rejects unverified placeholder identifiers", () => {
    const ids: ExistingFoundationIds = {
      ...prod.existing,
      cognitoUserPoolId: "__UNVERIFIED__",
    };
    expect(() => build(ids)).toThrow(/not verified yet: cognitoUserPoolId/);
  });

  it("rejects subnets listed out of availability-zone order", () => {
    const [a, b] = prod.existing.vpc.privateSubnets;
    const ids: ExistingFoundationIds = {
      ...prod.existing,
      vpc: { ...prod.existing.vpc, privateSubnets: [b!, a!] },
    };
    expect(() => build(ids)).toThrow(/availabilityZones order/);
  });
});
