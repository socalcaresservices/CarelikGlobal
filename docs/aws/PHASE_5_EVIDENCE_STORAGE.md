# Phase 5: Private S3/KMS Signature Evidence

**Code:** `apps/sv-api/src/evidence.ts`, `routes.ts` (confirm, signature); `infra/aws/lib/evidence-storage-stack.ts` (Phase 1, unchanged). **Not deployed.**

## Design decision: signatures travel through the API (not browser → S3)

| Option | Bucket exposure | Integrity | Authorization before write | Chosen |
| --- | --- | --- | --- | --- |
| Presigned PUT from the browser | Needs bucket CORS and a browser-reachable S3 URL | Client-declared | Separate request; harder to bind | No |
| **PNG in the confirm request; Lambda validates, hashes and writes** | None: no CORS, no presigned URLs, Block Public Access on | Server-computed SHA-256; S3 verifies `ChecksumSHA256` | Checked in PostgreSQL **before** the write | **Yes** |

The signature is ≤ 1 MiB. API Gateway HTTP API and Lambda payload limits (10 MB / 6 MB) are not a constraint.

## Write path (`POST /v1/visits/{id}/confirm`, method `draw` or `assisted_mark`)

1. Validate the PNG: base64 (an optional data-URL prefix is accepted), 1 B–1 MiB, PNG signature + IHDR, 1–4096 px. The bytes are never logged.
2. **Replay check**: `get_confirmation_replay(visit, key)`. If this key already committed, return the stored result; no upload.
3. **Authority check**: the visit must be the caller's own active visit in that organization, `awaiting_signature`. Otherwise 409 with a single generic message, so nothing reveals other tenants' visits.
4. `PutObject` to `{org_uuid}/{visit_uuid}/client-signature.png` (UUIDs only, no PHI in keys):
   - `ServerSideEncryption=aws:kms` with the Ogevia evidence key, Bucket Key on;
   - `ChecksumSHA256`;
   - `ExpectedBucketOwner` = the account in the key ARN.
5. One DB transaction: `register_visit_evidence(key, VersionId, size, sha256)` → `confirm_service_visit(evidence_id)`. The visit is locked; the registered **version** is pinned.
6. If S3 fails: 503, the visit stays `awaiting_signature`, and a retry is safe. If the DB fails after the upload, an unregistered object version remains (versioned bucket) and is never referenced.

## Read path (`GET /v1/visits/{id}/signature`)

`get_visit_signature_evidence` requires `visits.read` in the visit's organization. It follows a corrected row back to the original confirmation and writes an audit event **before** any bytes are read. Lambda fetches the pinned `VersionId`, recomputes SHA-256 and refuses to serve mismatching bytes (`evidence_integrity_failure`, tested). The response is a base64 PNG with `no-store`.

## Storage controls (Phase 1 stack)

| Control | Value |
| --- | --- |
| Block Public Access | all four on |
| TLS | bucket policy denies `aws:SecureTransport=false`; min TLS 1.2 |
| Encryption | SSE-KMS (customer-managed key, rotation on, RETAIN) |
| Versioning | on (an overwritten or deleted object is recoverable) |
| Object Lock | **off** (irreversible; needs explicit approval) |
| Access logs | separate SSE-S3 bucket |
| Lifecycle | abort incomplete multipart uploads after 7 days; no expiration (retention period is a legal decision gate) |
| IAM | Lambda: `s3:PutObject`, `s3:GetObject`, `s3:GetObjectVersion` on `*/*/client-signature.png` only; KMS via S3 only (`kms:ViaService`) |
| Network | S3 gateway endpoint, policy limited to the same object pattern |

## Tests

- Unit (PNG validation, versioned store, checksum): 10.
- Integration via the handler:
  - signed upload + pinned version;
  - another caregiver blocked before upload;
  - no second upload on retry;
  - 4 parallel duplicates → 1 confirmation;
  - S3 failure → retryable;
  - integrity failure refused;
  - caregiver cannot read signatures;
  - manager read audited;
  - correction follows the original evidence.
- Not verified until deployment: real S3 SSE-KMS write and checksum through the gateway endpoint (deployment smoke covers it).
