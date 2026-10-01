import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { ApiError } from "./errors";

/** Same ceiling as ogevia.visit_evidence.byte_size and the Supabase bucket. */
export const MAX_SIGNATURE_BYTES = 1_048_576;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_DIMENSION = 4096;

export interface StoredObject {
  readonly bytes: Buffer;
  readonly versionId: string | null;
  readonly contentType: string | null;
}

/** Private evidence store. Keys are UUID-only: {org}/{visit}/client-signature.png. */
export interface EvidenceStore {
  put(key: string, bytes: Buffer, sha256: Buffer): Promise<{ versionId: string | null }>;
  get(key: string, versionId: string | null): Promise<StoredObject>;
}

export function signatureObjectKey(organizationId: string, visitId: string): string {
  return `${organizationId}/${visitId}/client-signature.png`;
}

export interface ValidatedSignature {
  readonly bytes: Buffer;
  readonly sha256: Buffer;
  readonly sha256Hex: string;
}

/**
 * Decodes and validates a client-drawn signature: base64 PNG (an optional
 * data:image/png;base64, prefix is accepted), 1 byte..1 MiB, PNG signature,
 * IHDR first, sane dimensions. The bytes are never logged.
 */
export function validateSignaturePng(input: unknown): ValidatedSignature {
  if (typeof input !== "string" || !input) throw new ApiError(400, "bad_request", "A signature image is required.");
  const b64 = input.startsWith("data:image/png;base64,") ? input.slice("data:image/png;base64,".length) : input;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new ApiError(400, "bad_request", "The signature image is not valid.");
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0 || bytes.length > MAX_SIGNATURE_BYTES) {
    throw new ApiError(422, "validation_failed", "The signature image is empty or larger than 1 MB.");
  }
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_MAGIC) || bytes.toString("latin1", 12, 16) !== "IHDR") {
    throw new ApiError(422, "validation_failed", "The signature must be a PNG image.");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new ApiError(422, "validation_failed", "The signature image has invalid dimensions.");
  }
  const sha256 = createHash("sha256").update(bytes).digest();
  return { bytes, sha256, sha256Hex: sha256.toString("hex") };
}

/** S3 implementation: SSE-KMS with the evidence key, SHA-256 checksum enforced by S3. */
export function s3EvidenceStore(s3: S3Client, bucket: string, kmsKeyArn: string): EvidenceStore {
  // The bucket must belong to the same account as the key (defends against a
  // misconfigured or squatted bucket name).
  const account = kmsKeyArn.split(":")[4];
  const expectedOwner = account && /^\d{12}$/.test(account) ? account : undefined;
  return {
    async put(key, bytes, sha256) {
      const result = await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: "image/png",
          ContentLength: bytes.length,
          ChecksumSHA256: sha256.toString("base64"),
          ServerSideEncryption: "aws:kms",
          SSEKMSKeyId: kmsKeyArn,
          BucketKeyEnabled: true,
          ...(expectedOwner ? { ExpectedBucketOwner: expectedOwner } : {}),
        }),
      );
      return { versionId: result.VersionId ?? null };
    },
    async get(key, versionId) {
      const result = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(versionId ? { VersionId: versionId } : {}),
          ...(expectedOwner ? { ExpectedBucketOwner: expectedOwner } : {}),
        }),
      );
      if (!result.Body) throw new Error("empty object");
      const bytes = Buffer.from(await result.Body.transformToByteArray());
      if (bytes.length > MAX_SIGNATURE_BYTES) throw new Error("object too large");
      return { bytes, versionId: result.VersionId ?? null, contentType: result.ContentType ?? null };
    },
  };
}

/** In-memory store for tests and local development. Versioned like the real bucket. */
export class MemoryEvidenceStore implements EvidenceStore {
  readonly objects = new Map<string, Array<{ versionId: string; bytes: Buffer }>>();
  private counter = 0;
  failNextPut = false;

  async put(key: string, bytes: Buffer, sha256: Buffer) {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("simulated S3 failure");
    }
    if (!createHash("sha256").update(bytes).digest().equals(sha256)) throw new Error("checksum mismatch");
    const versionId = `v${++this.counter}`;
    const versions = this.objects.get(key) ?? [];
    versions.push({ versionId, bytes: Buffer.from(bytes) });
    this.objects.set(key, versions);
    return { versionId };
  }

  async get(key: string, versionId: string | null) {
    const versions = this.objects.get(key) ?? [];
    const found = versionId ? versions.find((v) => v.versionId === versionId) : versions.at(-1);
    if (!found) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
    return { bytes: Buffer.from(found.bytes), versionId: found.versionId, contentType: "image/png" };
  }
}
