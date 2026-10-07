import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import type { OgeviaConfig } from "./config.js";

/** KMS key + private signature/evidence bucket. Object keys must be random (no PHI). */
export class EvidenceStack extends Stack {
  public readonly key: kms.Key;
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, cfg: OgeviaConfig, props?: StackProps) {
    super(scope, id, props);
    this.key = new kms.Key(this, "DataKey", {
      alias: `alias/ogevia-${cfg.stage}-data`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
      description: "Ogevia data encryption (signatures, RDS)",
    });
    this.bucket = new s3.Bucket(this, "SignatureBucket", {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.key,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { noncurrentVersionExpiration: Duration.days(365), abortIncompleteMultipartUploadAfter: Duration.days(7) },
      ],
    });
    // Object Lock is irreversible and needs explicit owner approval; intentionally not enabled.
  }
}
