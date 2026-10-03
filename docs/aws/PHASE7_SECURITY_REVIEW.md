# Phase 7 security review: AWS Service Verification (SCS pilot)

**Status:** PREPARED FOR SIGN-OFF. **Not signed.** Live evidence collected 2026-10-03 21:03 UTC: **PASS 36, GAP 5, MANUAL 1, ERROR 0** (§3.1). The remaining fixes are in `phase7-remediate.sh` and need your approval (§5).
**Prepared:** 2026-10-03, from the repository at the pilot build and the owner-reported pilot results.
**Environment:** account `300094796789`, `us-west-2`, RDS `ogevia-prod-postgres` (database `ogevia_sv_test`), Cognito pool `us-west-2_849AYz5J7`, stacks `Ogevia-prod-*`.

## 1. What signing authorizes

| Signing this review **authorizes** | It does **not** authorize |
| --- | --- |
| Real SCS client data in the AWS Service Verification path, once every **Required** item in §4 is closed and the BAA is confirmed | A production cutover: merging the PR chain into `main`, changing Netlify, or moving Supabase data. That is a separate approval. |
| The accepted risks in §6, on the record | Automatic billing or payer submission, EVV/Sandata claims, or GPS |
| | Any control change in §4. Each is a YELLOW action needing its own approval. |

HIPAA is a design constraint (CLAUDE.md §8). Using AWS does not by itself make Ogevia compliant: AWS secures the infrastructure under the shared-responsibility model, and Ogevia must configure and operate everything above it.

## 2. Evidence classes

| Class | Meaning |
| --- | --- |
| **VERIFIED (code/tests)** | Shown by repository code, CDK synthesis checks or automated tests at the pilot build |
| **OWNER-REPORTED** | Reported by the owner from CloudShell or real phones on 2026-10-03; Claude did not see the output |
| **LIVE: `ID`** | To be read from AWS by `phase7_evidence.py` (check ID in §3). Status is unknown until it runs. |
| **MANUAL** | Cannot be read by API; the owner confirms it |

## 3. Collect the live evidence (read-only)

Run `infra/aws/slice/phase7_evidence.py` in CloudShell (us-west-2, AdministratorAccess). It makes describe, get and list calls only, plus one CloudWatch Logs Insights query over the API's own log groups (about $0.005 per GB scanned). It never prints secrets, tokens or email addresses.

The terminal ends with a short summary of under 10 lines: counts, then the IDs of every GAP, MANUAL and ERROR item. The full result is saved to `~/ogevia-phase7/evidence-<UTC>.txt`.

Rehearsed against simulated AWS responses in a clean and a failing scenario, with no crashes, and with every unreadable item reported as ERROR.

### 3.1 Live result, 2026-10-03 21:03 UTC (owner-reported summary)

`SUMMARY PASS 36 GAP 5 MANUAL 1 ERROR 0 INFO 8`, saved in CloudShell as `~/ogevia-phase7/evidence-20261003T210313Z.txt`. Claude received the summary line; the per-check detail lines stay in that file.

| Result | Checks | Meaning |
| --- | --- | --- |
| **PASS** (not listed below) | A1 A2 A3 A4, B1 B2 B3, C1 C2 C3 C4 C7, D1 D3, E1 E2, F1 F2 F3 F4 F5, G2 | Includes: **AWS BAA ACTIVE in Artifact (A2)**; root MFA, no root keys, no IAM-user keys; CloudTrail multi-region with log-file validation; **no personal data in 14 days of API logs (B3)**; RDS private, encrypted, `rds.force_ssl=1`, deletion protection on; admin host IMDSv2 required, app group detached; evidence bucket controls; Cognito MFA ON, deletion protection, admin-only sign-up; least-privilege Lambda role; 8 public routes only; budget alerts with subscribers |
| **GAP** | **C6** VPC flow logs · **D2** account-wide S3 public access block · **D4** app DB secret rotation off · **G1** alarm topic has no subscriber · **G3** GuardDuty off | Fixes R1, R8, R9 and R10, plus decision R11 (§5) |
| **MANUAL** | **E3** restore drill | R7 (§5) |
| **INFO** (8) | B4, C5, C7 (admin host running), E1 (single-AZ), F1 (tier and users), F5 (TLS minimum, no WAF), G3 (Security Hub) | Covered by §6 accepted risks, or recorded only |

Interpretation note: A2 passes only when the Artifact API returns an agreement named as a Business Associate Addendum in state ACTIVE. The effective date is in the evidence file's A2 line.

## 4. Control review

Status key: ✅ meets the requirement · ⚠️ gap with a fix · ❓ unknown until live evidence · 🟦 accepted risk (§6).

### 4.1 Administrative and account controls (HIPAA §164.308)

| # | Control | Evidence | Status | Required before real data? |
| --- | --- | --- | --- | --- |
| A2 | **AWS BAA accepted** in AWS Artifact | LIVE `A2` (Artifact API; MANUAL if it cannot be read) | ❓ No document records it as accepted | **Required** |
| — | Services in use are on AWS's HIPAA-eligible list: Lambda, API Gateway, RDS, S3, KMS, Secrets Manager, Cognito, CloudFront, CloudWatch/Logs, CloudTrail, SNS, VPC, EC2, Systems Manager | MANUAL. The AWS page could not be fetched from Claude's environment. All are expected to be eligible, but confirm on the current *HIPAA Eligible Services Reference* page. | ❓ | **Required** |
| A3 | Root user has MFA and no access keys | LIVE `A3` | ❓ | **Required** |
| A4 | People sign in through IAM Identity Center; no IAM users with active keys | LIVE `A4`; SECURITY_DECISIONS.md (2026-10-01) found none | ❓ | **Required** |
| — | Documented **risk analysis** (§164.308(a)(1)) | MANUAL. This review covers the technical part only. | ❓ | **Required** |
| — | **Caregiver offboarding:** disable the Cognito user the same day someone leaves (high turnover) | MANUAL. Users are only ever disabled, never deleted, so the audit history stays attributable. | ❓ Procedure not written | **Required** |
| — | Incident response and breach-notification procedure | MANUAL | ❓ | **Required** |
| — | Workforce training and sanction policy | MANUAL | ❓ | Required by HIPAA; owner timing |

### 4.2 Access control and authentication (§164.312(a), (d))

| # | Control | Evidence | Status |
| --- | --- | --- | --- |
| F1 | Individual accounts with MFA (TOTP) required for everyone, and no self sign-up | VERIFIED (config); OWNER-REPORTED phone test A1–A5; LIVE `F1` | ✅ (live re-check `F1`) |
| F1 | Cognito user pool deletion protection | LIVE `F1` | ❓ |
| F2 | Web client uses authorization code + PKCE with no client secret; 12-hour refresh tokens kept in session storage; user-existence errors hidden | VERIFIED (`web-hosting-stack.ts`, `cognito-target.ts`); LIVE `F2` | ✅ |
| F4 | Every API route requires a Cognito access token, except 8 approved public links using 256-bit tokens that are hashed before storage | VERIFIED (synthesis fails on any unapproved public route; strict deployment gate); OWNER-REPORTED live check: 401 on `close` without sign-in; LIVE `F4` | ✅ |
| — | Tenant, role and assignment decided **server-side** in PostgreSQL. The browser never supplies the organization, role, amounts or times. | VERIFIED: 140 DB tests incl. `tenant-assignment-visit`, `authorization`, `care-token-security`; OWNER-REPORTED G5 (test-slice manager sees no pilot data) | ✅ |
| F3 | Lambda role is least privilege: own log group; 5 network-interface actions on `*` (EC2 offers nothing narrower); one secret; signature objects only; KMS only through S3 | VERIFIED (`service-verification-api-stack.ts` plus `template-scan.ts`, which fails any wildcard action); LIVE `F3` | ✅ |
| — | Database role `ogevia_app` has no table privileges; it can only run the `ogevia_api` functions | VERIFIED (migrations, `01_app_login_role.sql`, DB tests) | ✅ |
| — | Manager vs owner separation: managers can approve operationally; billing submission and rates are owner-only | VERIFIED (AWS 0002/0006/0011, matching production #46) | ✅ |

### 4.3 Audit controls and integrity (§164.312(b), (c))

| # | Control | Evidence | Status |
| --- | --- | --- | --- |
| B1 | CloudTrail logging management events in all regions | LIVE `B1`. The 2026-10-01 inventory found trail `ogevia-audit-trail` (home us-east-2), but multi-region was **not verified**. | ❓ |
| B1 | CloudTrail log-file validation (tamper evidence) | LIVE `B1`; unknown | ❓ |
| — | Visit records: start/end use server time; signed visits locked; corrections append-only (original, corrected, who, when, why); an unchanged time is kept to the microsecond | VERIFIED (DB tests, `correction-unchanged-times`); OWNER-REPORTED C4, E1–E4, F1–F3 | ✅ |
| D1 | Signature evidence: versioned S3 (overwrite/delete recoverable) and a SHA-256 hash stored in the database | VERIFIED (code); LIVE `D1` | ✅ |
| B2 | API log retention is finite (365 days) | VERIFIED (config); LIVE `B2` | ✅ |
| — | Object Lock (WORM) on evidence | Not enabled: it is irreversible and needs explicit approval (CLAUDE.md Phase 5) | 🟦 §6 |

### 4.4 Transmission and storage security (§164.312(e), (a)(2)(iv))

| # | Control | Evidence | Status |
| --- | --- | --- | --- |
| C1 | RDS private and encrypted (KMS) | 2026-10-01 inventory; workflow pre-checks (OWNER-REPORTED); LIVE `C1` | ✅ |
| C3 | Database connections require TLS | Lambda verifies the RDS certificate authority (`NODE_EXTRA_CA_CERTS`); the server side, `rds.force_ssl`, is LIVE `C3` | ❓ server side |
| D1 | Evidence bucket: SSE-KMS, public access blocked, TLS-only policy, TLS ≥ 1.2, access logging, versioning | VERIFIED (`evidence-storage-stack.ts`); LIVE `D1` | ✅ |
| D3 | KMS evidence key rotation; key retained (never deleted by a stack) | VERIFIED; LIVE `D3` | ✅ |
| F5 | Web: HTTPS redirect, HSTS, CSP, `frame-ancestors 'none'`, no-referrer, camera/microphone/location blocked | VERIFIED (`web-hosting-stack.ts`); LIVE `F5` | ✅ |
| F5 | Minimum TLS on the default `*.cloudfront.net` certificate is TLSv1 and cannot be raised without a custom domain | LIVE `F5` | 🟦 §6 until the custom domain at production cutover |
| D2 | Account-wide S3 public access block | LIVE `D2` | ❓ |
| E2 | Snapshots encrypted | LIVE `E2` | ✅ expected |

### 4.5 Network isolation

| # | Control | Evidence | Status |
| --- | --- | --- | --- |
| C2 | RDS security group admits port 5432 only from the app security group | Inventory 2026-10-01; workflow checks; LIVE `C2` | ✅ |
| C4 | Lambda in private subnets with no NAT or internet route; AWS services reached through VPC endpoints whose policies allow only the one app secret and the signature object path | VERIFIED (`network-egress-stack.ts`); LIVE `C4` | ✅ |
| C5 | App security group allows outbound to `0.0.0.0/0`, but with no route out (C4) it reaches only VPC endpoints and RDS | LIVE `C5` | 🟦 optional hardening |
| C6 | VPC flow logs | LIVE `C6`; none on 2026-10-01 | ⚠️ |
| C7 | Temporary admin host `ogevia-db-admin-temp`: no public IP; app security group attached only during DB windows (trap-restored, verified each run); **IMDSv2 not verified** | LIVE `C7` | ⚠️ IMDSv2 + stop when idle |

### 4.6 Privacy and data minimization

| # | Control | Evidence | Status |
| --- | --- | --- | --- |
| B3 | No personal data in logs. The handler logs one line per request (route template, status, latency, IDs, error codes) and never bodies, paths, headers, tokens, names, notes, signatures or database messages. The API access log has no path, IP or body. | VERIFIED (`handler.ts` policy, unit test, smoke log-hygiene checks); LIVE `B3` scans 14 days of API logs | ✅ (live `B3`) |
| — | Signature object keys contain only UUIDs: `{org}/{visit}/client-signature.png` | VERIFIED (code, smoke check) | ✅ |
| — | Caregiver screens show the random client code, not DOB, UCI, Medicaid or payer IDs | VERIFIED (UI, pilot seed); OWNER-REPORTED G4 | ✅ |
| — | Alarm notifications carry metric names and thresholds only | VERIFIED | ✅ |
| — | **Record-retention period** for visits and signatures | Not set: S3 has no expiration and the database keeps everything | ❓ Legal/business decision, §5 |

### 4.7 Availability, backup and recovery (§164.308(a)(7))

| # | Control | Evidence | Status | Required? |
| --- | --- | --- | --- | --- |
| E1 | Automated backups for 7 days, point-in-time recovery | Workflow pre-check (OWNER-REPORTED); LIVE `E1` | ✅ | — |
| E1 | RDS deletion protection | LIVE `E1` | ❓ | **Required** |
| E3 | **Restore drill** (contingency plan test) | Never performed | ⚠️ | **Required** |
| E1 | Multi-AZ | Single-AZ | 🟦 §6 | Owner decision |
| — | Lambda concurrency: account limit of 10, with stage throttling at 20 req/s (burst 50) | VERIFIED | 🟦 §6 (enough for the pilot) | — |

### 4.8 Monitoring, threat detection and cost

| # | Control | Evidence | Status | Required? |
| --- | --- | --- | --- | --- |
| G1 | 6 alarms: Lambda errors and throttles, API 5xx, RDS CPU, free storage, CPU credits | VERIFIED (`observability-stack.ts`); LIVE `G1` | ✅ | — |
| G1 | **Alarms reach a person.** The SNS topic was created with no subscriptions, so today the alarms notify nobody. | VERIFIED (code comment); LIVE `G1` | ⚠️ | **Required** |
| G2 | Budget alerts: "ogevia phase 1 Budget" $50 existed on 2026-10-01; its notifications are unknown | LIVE `G2` | ❓ | **Required** |
| G3 | GuardDuty threat detection | LIVE `G3` | ⚠️ if off | Recommended |
| — | AWS WAF on the public links | Not attached; links are token-protected and throttled | 🟦 §6 | Owner decision |

## 5. Remediation and decisions

Nothing below has been run. Every item is a YELLOW action, so Claude prepares it and runs nothing until you approve each item. Costs are estimates (INFERRED) unless marked; check the AWS pricing pages before approving anything recurring.

**After the live run (§3.1):** R2, R3, R4, R5 and IMDSv2 (R6) **already pass**, so no action is needed. R1, R7, R8 and R9 are in one script, `infra/aws/slice/phase7-remediate.sh`. It asks for **APPLY** (R1, R8, R9) and separately for **DRILL** (R7), because the drill creates and then deletes a temporary database. It was rehearsed against simulated AWS: full path, a public bucket present (R8 refused), everything declined, and an invalid email. **R8 was hardened before use:** it reads every bucket's policy status **and ACL** in the bucket's own region, and any unreadable result blocks R8 rather than counting as not public. It saves the existing account-level setting to `~/ogevia-phase7/account-public-access-block-before-<UTC>.json` and writes an exact rollback script. After applying, it reads the setting back and re-checks the website, and rolls back automatically if either check fails. Rehearsed cases: clean, an existing partial setting saved exactly, a public ACL, an unreadable ACL, and a forced failure rolled back (with and without a prior setting). Limit: individual object ACLs are not scanned on buckets where ACLs are still enabled; the script lists those buckets. R10 (flow logs, a CDK change) and R11 (rotation decision) remain.

| # | Action | How | New recurring cost | Recommendation |
| --- | --- | --- | --- | --- |
| R1 | **Subscribe a person to alarms** (G1) | `aws sns subscribe --topic-arn <AlarmTopic ARN from the Observability stack> --protocol email --notification-endpoint <owner inbox>`, then confirm the email. The topic is a CDK resource, but a subscription does not drift the stack. | $0 | **Do before real data** |
| R2 | **Budget alert to the owner** (G2) | Add an 80% actual + 100% forecast email notification to the existing budget (console: Billing → Budgets) | $0 | **Do** |
| R3 | **CloudTrail:** confirm multi-region; enable log-file validation (B1) | `aws cloudtrail update-trail --name ogevia-audit-trail --is-multi-region-trail --enable-log-file-validation --region us-east-2` | ≈ $0 (digest files) | **Do** |
| R4 | **RDS deletion protection** (E1) | The instance is owned by CloudFormation stack `ogevia-prod-data-layer`. Change it through that stack's template so the stack does not drift. A direct `modify-db-instance --deletion-protection` works but leaves drift to record. | $0 | **Do; template change preferred** |
| R5 | **Cognito deletion protection** (F1) | Set it in the console (User pool → Settings → Deletion protection). **Do not use `aws cognito-idp update-user-pool`:** it resets every setting you don't pass back to its default, which could switch MFA off. | $0 | **Do (console)** |
| R6 | **Admin host:** require IMDSv2 and stop it between DB windows (C7) | `aws ec2 modify-instance-metadata-options --instance-id i-0ce8db2d7e5839dd5 --http-tokens required --http-endpoint enabled`; `aws ec2 stop-instances --instance-ids i-0ce8db2d7e5839dd5`. The deploy and rollback workflows already stop with a clear message if the host isn't running. | saves ≈ $7.50/mo | **Do** |
| R7 | **Restore drill** (E3) | Restore the latest automated backup or snapshot to a **new** instance `ogevia-restore-drill` in the same private subnet group and security group, with no public access. Run `db:verify` against it through the DB window. Record the time to available and the result, then delete **only** `ogevia-restore-drill`. Claude prepares the exact script on approval. | ≈ $0.02–0.10 one-off (db.t4g.micro for about 1–2 h) | **Do before real data** |
| R8 | **Account-wide S3 public access block** (D2) | `aws s3control put-public-access-block --account-id 300094796789 --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true`. The site is served through CloudFront with no public bucket, and log delivery ACLs aren't public. Re-run smoke afterwards. | $0 | **Do** |
| R9 | **GuardDuty** (G3) | `aws guardduty create-detector --enable` (us-west-2) | 30-day free trial, then usage-based; low at this volume (INFERRED). Check the trial's cost estimate before day 30. | **Recommended** |
| R10 | **VPC flow logs** (C6) | Add to CDK (NetworkEgress or a small stack) delivering to S3 with a lifecycle rule, rather than CloudWatch Logs | < $1/mo at pilot volume (INFERRED) | Recommended; not blocking |
| R11 | **App DB secret rotation** (D4) | Automatic rotation needs a rotation Lambda that can reach RDS and Secrets Manager. For the pilot, rotate manually every 90 days (procedure written with R7) and automate later. | $0 manual; ≈ $0 automated | **Decision:** manual for the pilot |
| R12 | **Record-retention period** | A legal/business decision: how long visit records and signatures must be kept. It sets S3 lifecycle rules and a DB archival policy later. | — | **Owner/legal decision**; nothing is deleted until decided |

## 6. Risks to accept (or reject) at sign-off

| Risk | Why acceptable for the pilot | Revisit |
| --- | --- | --- |
| Single-AZ RDS: an AZ outage stops the service until restored. Recovery time is set by R7. | Pilot scale; visits can be recorded on paper during an outage and corrected later with full audit history | Before scaling past the pilot; Multi-AZ ≈ +$16/mo (INFERRED) |
| No WAF | All public routes need a 256-bit link token (hashed before storage) and are throttled at 20 req/s; everything else needs a Cognito token | If abuse appears in access logs, or at production cutover |
| Default CloudFront certificate allows TLSv1 minimum | Browsers negotiate TLS 1.2/1.3; old protocols are a theoretical downgrade risk | Custom domain with `TLSv1.2_2021` at production cutover |
| CloudWatch Logs and SNS use AWS-owned encryption rather than a customer key | Logs and alarms carry no PHI (B3 confirms) | If any PHI could reach logs |
| No Object Lock on evidence | Versioning makes overwrites and deletes recoverable; Object Lock is irreversible | With R12 |
| Lambda concurrency limited to 10 by the account | Ample for one agency's pilot; throttling caps load | Request a quota increase before more agencies |
| App security group allows outbound to 0.0.0.0/0 with no route out | No NAT or internet gateway path from the Lambda subnets | Tighten during the next network change |

## 7. Out of scope for this review, still open

- **Supabase/Netlify production path:** whether real client data already lives in Supabase, and whether a Supabase BAA exists. These are separate from this AWS review but material to SCS's HIPAA position.
- **Caregiver devices:** personal phones are used. Tokens are kept in session storage with a 12-hour refresh limit. Service Verification stores no visit data in the browser; local storage holds only the selected organization ID and the report column layout (VERIFIED, `apps/web/src`). A device policy (screen lock, no shared phones) is an administrative control for the owner.
- **Job-application page** (`apply-page.tsx`): autosaves an applicant's draft in that browser's local storage. Not part of Service Verification, but it is personal data on a shared device; review it separately.
- **Email:** Cognito invitation emails use Cognito's default message (no custom invitation template exists in the CDK code): the username and a temporary password, with no client data.

## 8. Sign-off

Real client data may be entered only when **all** of these are true:

- [x] AWS BAA ACTIVE in AWS Artifact (A2: PASS, live 2026-10-03)
- [ ] Services in use confirmed on AWS's current HIPAA-eligible list (owner, §4.1)
- [x] `phase7_evidence.py` run on real AWS with 0 ERROR (2026-10-03 21:03 UTC)
- [ ] Re-run after remediation: GAP only C6/D4 (or fixed), each covered by §5 or §6
- [ ] R1 alarms reach a person
- [x] R2 budget alerts (G2: PASS)
- [x] R3 CloudTrail multi-region + log-file validation (B1: PASS)
- [x] R4 RDS deletion protection (E1: PASS)
- [x] R5 Cognito deletion protection (F1: PASS)
- [x] R6 admin host IMDSv2 required (C7: PASS); stop it when idle (owner habit)
- [ ] R8 account-wide S3 public access block (D2)
- [ ] R9 GuardDuty (G3), or accept in §6
- [ ] R7 restore drill passed, with the time recorded
- [ ] R11 rotation decision recorded
- [ ] R12 retention decision recorded (or "retain everything until decided")
- [ ] Risk analysis, offboarding, and incident-response procedures written (§4.1)
- [ ] §6 risks accepted as listed

| Role | Name | Decision | Date |
| --- | --- | --- | --- |
| Owner / Security Official | | ☐ Approve ☐ Approve with conditions ☐ Reject | |
| Notes | | | |
