> Current reconciliation supersedes the legacy shared-release asset/SHA/ledger narrative below. Use OPERATOR_TEST_DEPLOY.sh isolated-compare with the final green commit, then the current separation proposal. It retains all 256 live TEST routes and adds exactly three (259), preserves the existing NoEcho QR parameter and key, verifies the accepted 0102 API source hash, and captures the actual live rollback ZIP. Fresh isolated TEST uses accepted 0001–0102 plus UX 0103–0107 (107 ledger rows); no production migration set changes. Old f4316c5 assets and commands remain historical, not authorization to deploy. These tool-file checksum rows match the current reviewed bytes.

# Pins for the UX redesign TEST release (generated 2026-11-11; verify every value before use)

**Status: PREPARED, NOT AUTHORIZED, NOT RUN.** Nothing here moves until the owner gives the written Phase C statement (commit, TEST only, operator, window) and the owner's written authorization for the temporary security-group attach and admin credential in memory used by `OPERATOR_TEST_DB.sh` (the 0088 approval does not carry over). The window and the GO reference are NOT in these files: the operator exports them from the owner's statement.

| Item | Value |
|---|---|
| **Application commit (the proposed application commit; NOT approved for deployment)** | `f4316c5f1a9a844dc7749152243271cee003e94c` (branch `claude/ogevia-ux-audit-redesign-w36cov`; CI run 436: success; final continuation head still needs its own green run). The continuation after it changes tests/release tooling/docs, not app behavior. |
| Target | TEST only: stacks `Ogevia-prod-*`, database `ogevia_sv_test`. Never `Ogevia-prd-*` or `ogevia_prd` |
| `OPERATOR_TEST_DB.sh` sha256 | `20c1ff63b57ea3d8a490904128f7ffa80531f907889aab68d5cff7b9c258ff7f` |
| `OPERATOR_TEST_DEPLOY.sh` sha256 | `9b1cf041a04bbdf9dde5345f73898d0c4e48e5e61ffc88882155baca34e999d2` |
| `diff_gate_ux.py` sha256 | `5ae675435abfe0c87324f6ef4a549722033053f12611611bc9ddad2b3dde00ba` |
| `VERIFY_0090_0094.sql` sha256 | `0f78a265376152a4f14aea523bce10d86398966dcd6d268a298c81c0365cd1ab` |
| Migration `0103_caregiver_signin_override.sql` | `963d8cf4e7c8bdfa7da38d2719d4a4be2f7dafd7ab50e371c4e2ae1a567dfe54` |
| Migration `0104_caregiver_client_labels.sql` | `7e492ae24aff345ef15f0905e51bb0ee0c801857f6e1ee549fdf4b45f9e68712` |
| Migration `0105_bulk_import.sql` | `2dc18c125b459750431981dad2dd257630c6864e5ed41102770e6d9d1f992121` |
| Migration `0106_staff_duplicates.sql` | `952e1c9176ecee8b9475fd45f923fdff175bf78de14341a61b46e49d9f28affa` |
| Migration `0107_standard_document_types.sql` | `b0a28f483462a826aac0c9bb1e8e7b4ad8d26bfea80156668ab80874508f8d91` |
| Rollback `0090` / `0091` | `75cc1db8b9af4f4d61e909f8eb5e8245b88c5c71032ad35bcf41f49b9779a56e` / `843580f116fb7a682da1c1313c605aa7db507e1186ce60b8176d9b68d03f385d` |
| Rollback `0092` / `0093` / `0094` | `b6e96f069b28a7e790869ef5e02f1a9ae7da6dd72cb5eb71661e66f0dd2ff09a` / `24fe53618b70ab48b519813021fd06ce8f8671d9fa0aa32b16449b61caf839ff` / `1d0cbfe10b6b20baf2af221e3812949603332029a1343cc214238b7ddca67d44` |
| Pending migrations set (5 files, `LC_ALL=C sha256sum -- *.sql \| sha256sum`) | `dc971a797a07aa4b2d1bfe9b6a5aa60f987d19380983aec126ceefefb4faca06` |
| Pending rollback set (5 files) | `b0bb79933c75defa1a680ccafe73ad088a4f45418024a9c5b6dd40e633660b44` |
| All 88 released migration files (unchanged since the 0088 release) | `049c52cb3cbc0c90efad7003967d8bfe8297cd771d2d471d5b42506a889e372c` |
| `pnpm-lock.yaml` (includes the dependency overrides) | `8bcc5a445284d84ddef2885544c09d6219356f537e62468c9e40d931fcd8b267` |
| Handler code asset (cdk synth, `-c env=prod`) | `7baa45221daa410dec24424c55dd64605e5ce2fe36059165a4f5d958239346eb.zip` (local synthesis; confirm against CI artifact before any deployment) |
| IdentityHandler code asset | `7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759.zip` (identical to the 0088 release: unchanged) |
| API routes in the assembly | 253 (the previous deployed TEST commit `464dea64` synthesizes 250; the gate allows exactly these 3 added: `POST /v1/caregivers/{caregiverRecordId}/signin-override`, `GET /v1/signin-overrides`, `POST /v1/imports/{kind}`) |
| Previous TEST Handler asset (rollback reference, from the 0088 record) | `9e5a510ef7771fe0f70bb0db1a6b22bf2dbe313ab8f019c0c34ccd42686824b7.zip` (to be confirmed by the live capture; the live Lambda may differ) |
| Web publish method (owner decision 2026-11-11: the 0088 release method) | `infra/aws/scripts/deploy-test-slice.sh web`, called by `OPERATOR_TEST_DEPLOY.sh web` with `VITE_APP_VERSION=<commit>`; file sha256 `bbbdf1b78877b161bfe4c9764c72e785db7d8c886f163f604417531c9b71a6c4`, **byte-identical to the 0088 release** (no change between `464dea64` and `f4316c5`). `test-web-release.sh` is NOT used. |
| Toolchain | Node 22.x, pnpm 9.15.4, CDK CLI 2.1143.0 (the checkout's own), aws CLI v2, jq, PostgreSQL 18 psql/pg_dump/pg_restore, session-manager-plugin, python3, curl |

## Current verification
The previous verification narrative concerned 7f9483d and is superseded. Current app: f4316c5; 253 routes; 3 additions; duplicate routes remain absent. Typecheck, lint, build and TEST synthesis pass locally. Windows full suites have recorded failures, not waived. CI and the final release record must be read before deployment.
The DB script now makes a TEST-only logical backup, refuses instance snapshot mode, and commits each migration and its ledger row atomically. Applied ledger: 93/0094 (0089 was withdrawn); rollback: 88/0088. The backup file, checksum and metadata must stay together. No AWS command was run here.

## Isolated TEST cutover supersedes the shared release commands
The current separation recipe is docs/aws/DEMO_PROD_DATABASE_SEPARATION_PROPOSAL.md. Its explicit isolated-* DB modes use the final green release commit, candidate ogevia-postgres, no SG attachment, a fresh dedicated TEST login/secret and ledger 93/0094. The new --isolated-assemblies gate compares the shared and isolated assemblies without loosening the original UX gate. The legacy application SHA/assets above remain historical pins for the shared UX package; they do not pin or authorize the separation candidate. No deployment has run.

## Current CloudShell execution source
Application commit: 6cbab00b2795d0cfe42bf644adc6a559adda7c76; CI #446 green (3,813 full-suite passes, zero failed/skipped; harness 45/45). The new operator mode runs this exact clean source, independently of the helper's docs-only publication commit. Current Handler asset: ed01f08a2df9d8870ed44c25912ce9c9d18f4e6dd73dba29594c954a538c983b.zip; index.js SHA256: 98e84618f6eeaf6472985db06db9132cf39d887d296d38301ee0137e3a6e991c. Older shared-release asset pins above do not apply to this application. Operator syntax, telemetry-only acceptance, wildcard-secret drift refusal, removed-resource refusal, wrong-account refusal and checksum tests passed locally. No live deployment is claimed by these local tests.

## NOINHERIT verifier correction and post-seed resume
The owner reached synthetic seeding and then the login verifier failed with permission denied for schema ogevia. A local PostgreSQL regression reproduced that exact failure before the fix. The verifier now uses BEGIN READ ONLY / SET LOCAL ROLE ogevia_app, checks session_user plus runtime API-only privileges, and rolls back. No schema grants, migration bytes, application source or credentials change. The regression also detects missing API EXECUTE and unwanted direct-table SELECT grants. Local: 3/3 DB tests, 2/2 pin tests, typecheck and Bash syntax pass. cloudshell-resume verifies and backs up the existing database, validates the captured targets/asset, and continues only endpoint/API/alarms/web; it contains no initialization, migration or seed invocation. Do not rerun the fresh initializer after this post-seed stop.

Durable post-seed recovery: cloudshell-recover restores the latest private before-release archive, verifies its pinned app/source and every archived file checksum after path relocation, and enters resume without initializing/migrating/seeding. Preparation-only restores local tools/source and returns before capture/deployment. Local recovery tests accepted valid archived checksums and refused corruption, traversal, symbolic links and wrong accounts. This addresses an unavailable original /tmp workspace; no live recovery is claimed until the owner runs it.
