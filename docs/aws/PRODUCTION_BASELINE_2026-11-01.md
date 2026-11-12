# Production baseline: 2026-11-01 (control plane, read-only)

**Status: BASELINE RECORDED, NOT A DEPLOYMENT RECORD.** Recorded 2026-11-01 13:21 UTC from the operator's pasted CloudShell output (capture around 13:00 UTC; a first capture ran around 11:15 UTC). It is the starting point for the drift check required before the next production release (`docs/TESTING_AND_RELEASE_PROCESS.md` section 8.1) and supersedes `PRODUCTION_AS_FOUND_2026-10-26.md` as the reference for the items below. Nothing was changed in AWS; no database was opened; no secret value was read. Labels: **VERIFIED** (pasted output), **INFERRED**, **UNKNOWN**.

## 1. Result: no drift since the 2026-10-26 capture
| Item | Result | Label |
|---|---|---|
| Account, region | `300094796789`, `us-west-2` (the script stops otherwise) | VERIFIED |
| Live CloudFormation templates of `Ogevia-prd-Auth`, `-DatabaseSecret`, `-EvidenceStorage`, `-Observability`, `-ServiceVerificationApi`, `-WebHosting` and `Ogevia-prod-NetworkEgress` | each equals the 2026-10-26 capture (normalized JSON comparison) | VERIFIED |
| API Lambda | `CodeSha256` `E4Vv7ushYGqW7oVtyAW2T1QYjHwdFR+T+FaAQyJ9kW4=` (asset `debd1d43...`), last modified 2026-10-21T21:31:24Z, 260,561 bytes: identical to 2026-10-26 | VERIFIED |
| Web | 83 files, all byte-identical to the 2026-10-26 capture; served `index.html` sha256 `c61bfa92975cdf1b5b9171e7749bdfa0ec9f7b6d68bbe2e79a37cc1147548bb8` equals the bucket's; main bundle `assets/index-M5NkM-7g.js`, version string `e80b770210c54e423d28ecf48e00f1dda9506cec`, environment `production`, API host `zk527zk4ua` only | VERIFIED |
| Routes | 228 (the 2026-10-26 count). The 2026-10-26 capture did not keep a route list, so the lists cannot be compared; today's list is the first comparable one. It holds no `/v1/staff...` route and none of the 0088 routes | VERIFIED (count and list); the unchanged state of the list since 2026-10-26 is INFERRED from the unchanged template and Lambda |
| API CORS | origins `https://admin.ogevia.com`, `https://app.ogevia.com`, `https://d3l4psdkokkvnb.cloudfront.net`; methods GET, POST, OPTIONS | VERIFIED (first recorded now) |
| Cognito app client | callbacks `.../auth/callback` and logouts `/` on the same three hosts | VERIFIED (first recorded now) |
| Cognito pools | TEST `us-west-2_849AYz5J7` and production `us-west-2_FHJoX71ca`, both MFA on: separate pools | VERIFIED |
| RDS `ogevia-prod-postgres` (shared by TEST and production) | available, private, encrypted, engine 18.3, `db.t4g.micro`, single-AZ, 7-day backups, continuous backup running (restorable 2026-11-01T12:57:21Z) | VERIFIED |
| Manual snapshots | 22 (20 on 2026-10-26); the newest is `ogevia-prod-postgres-pre-0088-20261101t0752z` (2026-11-01T07:53Z, taken for the TEST release; it covers `ogevia_prd` as of that time, but is not the pre-production-deployment snapshot a production release needs); the other new one is not identified | VERIFIED (counts, newest); the other: UNKNOWN |
| Production app secret metadata | `ogevia/prd/database/app`, last changed 2026-10-10, rotation not enabled; no value read; identical to 2026-10-26 | VERIFIED |
| ComplianceSweep rules | one production rule and one TEST rule, both ENABLED | VERIFIED |
| S3 gateway endpoint policy | 4 entries for the TEST bucket, 4 for the production bucket, 2 client-documents entries; admits the production evidence bucket | VERIFIED |

**The TEST release did not touch production:** the production templates, Lambda and web are unchanged across the whole TEST window of 2026-11-01 (VERIFIED by the comparison above).

## 2. Fingerprints of the captured files (sha256; files remain in the operator's `~/ogevia-prd-baseline-20261101`)
```
ba586b4fabf330026eb8410e21e394fd14140ea0e78310c99689927de9cd5990  routes-before.json
7929013cac0922fe29ca8c8b43db42480348a5cca3923064f7a03a123f8f9c85  cors-before.json
8e361214d0f712eb09909ab48847af37e6307f81eeb6a2e926fb64a992d8b9bb  cognito-client-before.json
8d3656de35975a407d9fba744ad7a862366f052ae3b56c7416e771b0070f359f  lambda-config-before.json
dce6f6357427f982dca756e04b7e91717a8f4e4d26aceecd06e4d849900265ce  web-before.sha256
5e1a603dfc338b1eb62f37d9b437e0e6cf1de2a1c6a10450ffd86754cce38af8  live/Ogevia-prd-Auth.json
0d26d88fea188bc155b341d5fbddb43f982bc2233d9bd5d14a43775fe97c2afa  live/Ogevia-prd-DatabaseSecret.json
e0000fdb5b182f83c78bdfa19b5cd91ce598deebeff3d3bf7348740be33966e9  live/Ogevia-prd-EvidenceStorage.json
8a7362b0e6a768da8de8f7ad859ca74f3437011c625683d1e9afc2a2c6a6cfa7  live/Ogevia-prd-Observability.json
6c36cc468668e927dd998e298816f130ef9a1746b20e1e2e51e715ce99319416  live/Ogevia-prd-ServiceVerificationApi.json
fd3142f97b07402ebac6ed60717bdcb7d16a89898482a86e2e9c94e683d124e5  live/Ogevia-prd-WebHosting.json
fd4c8552658f12d97d3328045980b87a672619d3db627e8a775657eab0517bcd  live/Ogevia-prod-NetworkEgress.json
```
(Names of the last seven were cut by the paste at 90 characters and are restored from the stack list.) The old as-found folder `~/ogevia-prd-before` was used as the comparison source and was only read.

## 3. What this means for a production release of 0088 (written before the database was read; **superseded by section 5, which verifies it**)
Production is at the state before staff management and before 0088: the API has 228 routes, TEST after the 0088 release has 250 (228 + 14 staff + 8 readiness). A production release would therefore carry migrations 0086, 0087 and 0088 and 22 new routes. Whether production's database already holds the staff objects (which would need an `adopt` step, as on TEST) or not (a plain `migrate` of three files) is **UNKNOWN** until the production ledger and object checks are read.

## 4. Not covered and still UNKNOWN
Production database ledger and objects (last read 2026-10-26: 85/0085, ledger count and latest version only); what the tables hold and whether it is real or synthetic data (the owner stated synthetic only on 2026-10-20; not verified); IAM roles and policies beyond the templates; DNS for `app.ogevia.com` and `admin.ogevia.com`; Cognito users; the unidentified second new snapshot.
**Provenance caveat:** the operator's log holds two capture runs (RDS "restorable" 11:12 UTC and 12:57 UTC). Which package's copy of `p0-baseline-capture.sh` produced the files on disk was not confirmed (the intended one is `docs/releases/2026-10-26-redesign-prd-operator/scripts/p0-baseline-capture.sh`, sha256 `2304e5c8c9503cb855c374744f4a3821fad238c1eb1affaba19f1fb6a60f17aa`; the 2026-10-19 package carries a different copy). The comparison results above do not depend on it, but this record should not be used as a script-pinned baseline until that is confirmed.
**Not to be used for 0088:** `docs/releases/2026-10-19-prd-readiness/release/scripts/p2-gate.sh`. It belongs to the 2026-10-19 release (commit `e80b770`), compares production with that release's templates, and would write into the as-found folder unless `OGEVIA_PRD_BEFORE` is set. A production gate for 0088 has to be built from the 0088 assembly.

## 5. ADDENDUM: production database read, 2026-11-01 13:30:37Z (recorded 2026-11-01 13:33 UTC)
**Authorization:** the owner approved one run of `ledger-recheck-prd.sh prd --host-ip` ("Approve the production database check: ledger-recheck-prd.sh prd --host-ip, one run."). Script `docs/releases/2026-10-26-redesign-prd-operator/scripts/ledger-recheck-prd.sh`, sha256 `133ab6af0aeb4a4e0e17cc007046a57d7712b3f8ee166727be5dc25a3afa8c2c` (verified before the run), run by the operator in CloudShell with `OGEVIA_EXPECT_LEDGER_COUNT=85 OGEVIA_EXPECT_LEDGER_LATEST=0085 OGEVIA_EXPECT_0086=absent`; the typed confirmation `OPEN-5432-WINDOW-PRD` was given after the proposed change was read.
**Result (VERIFIED from the pasted output):**
| Item | Result |
|---|---|
| Environment identified | `Ogevia-prd-ServiceVerificationApi` `UPDATE_COMPLETE`; the Lambda serves `DB_NAME=ogevia_prd`, `OGEVIA_ENV=prd`; account `300094796789` |
| Connection | `connected: ogevia_prd | read_only=on` |
| Migration ledger | **85 migrations applied, latest 0085; no row above 0085** |
| Enforcement | activated for 0 of 0 agencies (the settings table has no rows; this says nothing about whether any organization exists) |
| Staff management (0086, 0087) | **ABSENT**: `staff_types|staff_profiles|functions of 21` = `0|0|0`; 0087 functions = 0 |
| Readiness (0088) | not present (follows from ledger 85 / 0085) |
**AWS changes made by the run (all temporary, all reverted):** one inbound rule tcp 5432 from `10.20.132.179/32` (the admin host's own private IP) added to RDS security group `sg-00530a1f4f7648e65`, description `TEMP-ledger-check-20261101T133037Z`, then removed; the group's complete rule set was proven identical to the recorded original (sha256 `76e9c75367c204f02dfcc52ff9d9dcc068e448b33fd2b3b664622ba8b514f175`; original inbound: tcp 5432 from `sg-064ffce3bcbe8eb3b` only). The RDS master secret was read into shell memory (never printed); one SSM port-forward session and one read-only database session were opened. CloudTrail records these. Nothing else was changed. Operator-side output: `~/ogevia-ledger-window-prd-20261101T133037Z/` (`RESULT.txt`, `rds-sg-before.json`).
**Consequence for a production release of 0088 (VERIFIED where stated, otherwise INFERRED):** production's database is at 85 / 0085 with no staff objects, so a production release means a plain `migrate` of 0086, 0087 and 0088 in order (no `adopt` step, which TEST needed only because its staff objects had been applied outside the ledger). The API gains 14 staff routes and 8 readiness routes (228 to 250, INFERRED from the TEST counts). The staff-management release prepared on 2026-10-26 was therefore never applied to production (VERIFIED for the database and the route list).
**Still UNKNOWN:** what the production tables hold (row counts, real versus synthetic data; the owner stated synthetic only on 2026-10-20), how many caregivers the 0088 backfill would approve, IAM roles beyond the templates, DNS for `app.ogevia.com` and `admin.ogevia.com`, Cognito users, the second new snapshot, and whether each ledger row's checksum equals the repository file (the script lists rows above 0085 only).

