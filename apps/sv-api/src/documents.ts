import { createHash } from "node:crypto";
import { ApiError } from "./errors";

/** Same ceiling as ogevia.document_versions.byte_size (fits the 6 MB Lambda payload as base64). */
export const MAX_DOCUMENT_BYTES = 4_000_000;
export const DOCUMENT_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export type DocumentContentType = (typeof DOCUMENT_TYPES)[number];

const MAGIC: Record<DocumentContentType, (b: Buffer) => boolean> = {
  "application/pdf": (b) => b.length > 5 && b.toString("latin1", 0, 5) === "%PDF-",
  "image/jpeg": (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
};

/** Server-built object key; UUIDs only, never names. */
export function documentObjectKey(organizationId: string, documentId: string, versionId: string): string {
  return `${organizationId}/documents/${documentId}/${versionId}`;
}

export interface ValidatedDocument {
  readonly bytes: Buffer;
  readonly contentType: DocumentContentType;
  readonly sha256: Buffer;
  readonly sha256Hex: string;
}

/**
 * Decodes a base64 document and checks it really is the declared type (by its
 * leading bytes, not the file name) and within the size limit. The bytes are
 * never logged.
 */
export function validateDocumentFile(input: unknown, declaredType: unknown): ValidatedDocument {
  if (typeof declaredType !== "string" || !(DOCUMENT_TYPES as readonly string[]).includes(declaredType)) {
    throw new ApiError(422, "validation_failed", "Upload a PDF, JPEG or PNG file.");
  }
  if (typeof input !== "string" || !input) throw new ApiError(400, "bad_request", "A file is required.");
  const b64 = input.replace(/^data:[a-z/+-]+;base64,/, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new ApiError(400, "bad_request", "The file is not valid.");
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0 || bytes.length > MAX_DOCUMENT_BYTES) {
    throw new ApiError(422, "validation_failed", "The file is empty or larger than 4 MB.");
  }
  const contentType = declaredType as DocumentContentType;
  if (!MAGIC[contentType](bytes)) {
    throw new ApiError(422, "validation_failed", "The file content does not match its type. Upload a PDF, JPEG or PNG file.");
  }
  const sha256 = createHash("sha256").update(bytes).digest();
  return { bytes, contentType, sha256, sha256Hex: sha256.toString("hex") };
}
