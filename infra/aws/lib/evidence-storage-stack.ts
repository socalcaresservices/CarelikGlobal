import {
  Duration,
  RemovalPolicy,
  Stack,
  Validations,
  type StackProps,
} from "aws-cdk-lib";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import type { OgeviaEnvironmentConfig } from "./config.js";

/**
 * Deterministic, config-derived bucket name. Other stacks reference the bucket
 * by this name instead of a CloudFormation export, so the evidence stack is
 * never locked by a cross-stack import. Contains no client data.
 */
export function signatureBucketName(config: OgeviaEnvironmentConfig): string {
  return `ogevia-${config.envName}-signature-evidence-${config.account}-${config.region}`;
}

/** Only object-key shape the application may read or write. */
export const SIGNATURE_OBJECT_KEY_PATTERN = "*/*/client-signature.png";
/** Staff documents (0021): {org}/documents/{document}/{version}. */
export const DOCUMENT_OBJECT_KEY_PATTERN = "*/documents/*/*";
/** Client documents (0074): {org}/client-documents/{document}/{version}. */
export const CLIENT_DOCUMENT_OBJECT_KEY_PATTERN = "*/client-documents/*/*";
/** Agency logo (0020): {org}/branding/logo/{logo}. */
export const LOGO_OBJECT_KEY_PATTERN = "*/branding/logo/*";

export interface EvidenceStorageStackProps extends StackProps {
  readonly config: OgeviaEnvironmentConfig;
}

/**
 * B. NEW FUTURE INFRASTRUCTURE - FUTURE/PROVISIONAL (Phase 5).
 *
 * Target for visit signature/evidence storage (replaces the Supabase
 * `visit-signatures` bucket). It has no dependency on existing network or
 * database resources, so it cannot duplicate or replace any of them.
 *
 * Object keys must follow the existing Supabase convention
 * `{organization_id}/{visit_id}/client-signature.png` - UUIDs only, never a
 * client name, code, or other identifier.
 *
 * NOT DEPLOYED. `cdk deploy` is a YELLOW action (CLAUDE.md section 13).
 */
export class EvidenceStorageStack extends Stack {
  public readonly dataKey: kms.Key;
  public readonly signatureBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: EvidenceStorageStackProps) {
    super(scope, id, {
      ...props,
      terminationProtection: props.config.terminationProtection,
    });

    const stage = props.config.envName;

    this.dataKey = new kms.Key(this, "EvidenceDataKey", {
      alias: `alias/ogevia/${stage}/evidence`,
      description: `Ogevia ${stage} - encrypts visit signature/evidence objects`,
      enableKeyRotation: true,
      // A deleted key makes every object it encrypted unreadable. Never let a
      // stack operation schedule key deletion.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Server access logs for the evidence bucket. The S3 log delivery service
    // only supports SSE-S3 on the target bucket, not SSE-KMS.
    const accessLogBucket = new s3.Bucket(this, "EvidenceAccessLogBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.signatureBucket = new s3.Bucket(this, "SignatureEvidenceBucket", {
      bucketName: signatureBucketName(props.config),
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.dataKey,
      // S3 Bucket Keys cut KMS request charges for per-object encryption.
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // Versioning keeps an overwritten or deleted signature recoverable.
      // Object Lock is deliberately NOT enabled: it is irreversible and needs
      // explicit owner approval (CLAUDE.md Phase 5, step 6).
      versioned: true,
      serverAccessLogsBucket: accessLogBucket,
      serverAccessLogsPrefix: "signature-evidence/",
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: "abort-incomplete-multipart-uploads",
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
        // No current/noncurrent expiration: record-retention periods are a
        // legal/business decision gate (docs/aws/SECURITY_DECISIONS.md).
      ],
    });

    const replicationDeferred =
      "Cross-region replication is a cost/DR decision gate, not yet approved.";
    for (const ack of [
      {
        id: "HIPAA.Security-S3DefaultEncryptionKMS",
        reason:
          "S3 server access log delivery only supports SSE-S3 on the target bucket.",
      },
      {
        id: "HIPAA.Security-S3BucketReplicationEnabled",
        reason: replicationDeferred,
      },
    ]) {
      Validations.of(accessLogBucket).acknowledge(ack);
    }
    Validations.of(this.signatureBucket).acknowledge({
      id: "HIPAA.Security-S3BucketReplicationEnabled",
      reason: replicationDeferred,
    });
  }
}
