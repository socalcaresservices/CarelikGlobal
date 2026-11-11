# Pins for the UX redesign TEST release (generated 2026-11-11; verify every value before use)

**Status: PREPARED, NOT AUTHORIZED, NOT RUN.** Nothing here moves until the owner gives the written Phase C statement (commit, TEST only, operator, window) and the owner's written authorization for the temporary security-group attach and admin credential in memory used by `OPERATOR_TEST_DB.sh` (the 0088 approval does not carry over). The window and the GO reference are NOT in these files: the operator exports them from the owner's statement.

| Item | Value |
|---|---|
| **Application commit (the proposed application commit; NOT approved for deployment)** | `f4316c5f1a9a844dc7749152243271cee003e94c` (branch `claude/ogevia-ux-audit-redesign-w36cov`; CI run 436: success; final continuation head still needs its own green run). The continuation after it changes tests/release tooling/docs, not app behavior. |
| Target | TEST only: stacks `Ogevia-prod-*`, database `ogevia_sv_test`. Never `Ogevia-prd-*` or `ogevia_prd` |
| `OPERATOR_TEST_DB.sh` sha256 | `dfff09905e3919cef001b770ccd84fb7d331b4882bc02ca2fbdaae56cef1d4bf` |
| `OPERATOR_TEST_DEPLOY.sh` sha256 | `76167deb03cbe46e69d406eab55bd2a3a3db7817efd612cba2210a33f2a109de` |
| `diff_gate_ux.py` sha256 | `e66aff283370a447a22f143a20c3b1aeb6fcdf093bcaea2b82b46ce57a836fd7` |
| `VERIFY_0090_0094.sql` sha256 | `0f78a265376152a4f14aea523bce10d86398966dcd6d268a298c81c0365cd1ab` |
| Migration `0090_caregiver_signin_override.sql` | `963d8cf4e7c8bdfa7da38d2719d4a4be2f7dafd7ab50e371c4e2ae1a567dfe54` |
| Migration `0091_caregiver_client_labels.sql` | `673dea984d97433cad1df663a890233acb2d240eb87abb8434db655d9a7596f3` |
| Migration `0092_bulk_import.sql` | `2dc18c125b459750431981dad2dd257630c6864e5ed41102770e6d9d1f992121` |
| Migration `0093_staff_duplicates.sql` | `952e1c9176ecee8b9475fd45f923fdff175bf78de14341a61b46e49d9f28affa` |
| Migration `0094_standard_document_types.sql` | `b0a28f483462a826aac0c9bb1e8e7b4ad8d26bfea80156668ab80874508f8d91` |
| Rollback `0090` / `0091` | `75cc1db8b9af4f4d61e909f8eb5e8245b88c5c71032ad35bcf41f49b9779a56e` / `843580f116fb7a682da1c1313c605aa7db507e1186ce60b8176d9b68d03f385d` |
| Rollback `0092` / `0093` / `0094` | `b6e96f069b28a7e790869ef5e02f1a9ae7da6dd72cb5eb71661e66f0dd2ff09a` / `24fe53618b70ab48b519813021fd06ce8f8671d9fa0aa32b16449b61caf839ff` / `1d0cbfe10b6b20baf2af221e3812949603332029a1343cc214238b7ddca67d44` |
| Pending migrations set (5 files, `LC_ALL=C sha256sum -- *.sql \| sha256sum`) | `dc971a797a07aa4b2d1bfe9b6a5aa60f987d19380983aec126ceefefb4faca06` |
| Pending rollback set (5 files) | `b0bb79933c75defa1a680ccafe73ad088a4f45418024a9c5b6dd40e633660b44` |
| All 88 released migration files (unchanged since the 0088 release) | `049c52cb3cbc0c90efad7003967d8bfe8297cd771d2d471d5b42506a889e372c` |
| `pnpm-lock.yaml` (includes the dependency overrides) | `ff6caae63c43f9e98c5386ac65ec49a43ba331fe8ed4f8ef6a179f8a8c49fbc0` |
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
