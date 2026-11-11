# Pins for the UX redesign TEST release (generated 2026-11-11; verify every value before use)

**Status: PREPARED, NOT AUTHORIZED, NOT RUN.** Nothing here moves until the owner gives the written Phase C statement (commit, TEST only, operator, window) and the owner's written authorization for the temporary security-group attach and admin credential in memory used by `OPERATOR_TEST_DB.sh` (the 0088 approval does not carry over). The window and the GO reference are NOT in these files: the operator exports them from the owner's statement.

| Item | Value |
|---|---|
| **Application commit (the only approved deployment commit)** | `7f9483d39690ae94db2710465d6995cd0b82b271` (branch `claude/ogevia-ux-audit-redesign-w36cov`; CI run 431: success). Commits after it are documents only. |
| Target | TEST only: stacks `Ogevia-prod-*`, database `ogevia_sv_test`. Never `Ogevia-prd-*` or `ogevia_prd` |
| `OPERATOR_TEST_DB.sh` sha256 | `203d7795be58817223e30858a1973f1c7dd6ab1fa89564dff200ec6bf2374ab9` |
| `OPERATOR_TEST_DEPLOY.sh` sha256 | `dc3b6b8f2f31492ac329a9a7426a34d845d89e2e578a25a875a04bbb36f6cfb6` |
| `diff_gate_ux.py` sha256 | `cf00c8d22cc1a40867721ebda30bc134ce0c8292019fe3fccc4112bb4e2de7ca` |
| `VERIFY_0090_0094.sql` sha256 | `33b7d540e944bb88767093a961d957b00e99014d1557f068312d85e28a15c3ea` |
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
| `pnpm-lock.yaml` (includes the dependency overrides) | `d00fb2b4fe6c6b2447fa25b302578f59958e61d5a369d3554a904ffcbd1d522f` |
| Handler code asset (cdk synth, `-c env=prod`) | `af1a87696ace52f31d40afa75121de98e893c1ae18124cde10a1f480973707bb.zip` (reproduced from two separate checkouts) |
| IdentityHandler code asset | `7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759.zip` (identical to the 0088 release: unchanged) |
| API routes in the assembly | 255 (the previous deployed TEST commit `464dea64` synthesizes 250; the gate allows exactly these 5 added: `POST /v1/caregivers/{caregiverRecordId}/signin-override`, `GET /v1/signin-overrides`, `POST /v1/imports/{kind}`, `GET /v1/staff/duplicates`, `POST /v1/staff/{profileId}/merge`) |
| Previous TEST Handler asset (rollback reference, from the 0088 record) | `9e5a510ef7771fe0f70bb0db1a6b22bf2dbe313ab8f019c0c34ccd42686824b7.zip` (to be confirmed by the live capture; the live Lambda may differ) |
| Web publish method (owner decision 2026-11-11: the 0088 release method) | `infra/aws/scripts/deploy-test-slice.sh web`, called by `OPERATOR_TEST_DEPLOY.sh web` with `VITE_APP_VERSION=<commit>`; file sha256 `bbbdf1b78877b161bfe4c9764c72e785db7d8c886f163f604417531c9b71a6c4`, **byte-identical to the 0088 release** (no change between `464dea64` and `7f9483d`). `test-web-release.sh` is NOT used. |
| Toolchain | Node 22.x, pnpm 9.15.4, CDK CLI 2.1143.0 (the checkout's own), aws CLI v2, jq, psql, session-manager-plugin, python3, curl |

## What was verified, and what was not
- **Verified locally (2026-11-11):** both scripts pass `bash -n` and their `selftest` against a clean checkout of `7f9483d`; they refuse a checkout at another commit, a modified migration, a missing window, an assembly built from `464dea64`, and (deploy) a missing approval; `VERIFY_0090_0094.sql` returns 53 checks all passing on a database with the five migrations applied (`expect=present`) and on a database without them (`expect=absent`), and fails on the opposite expectation; the gate reports **EXPECTED-ONLY: YES** between a synthesis of `464dea64` (stand-in for the live template) and `7f9483d`.
- **NOT verified (needs the operator in CloudShell):** every AWS call; the admin host, security group and RDS instance identifiers (copied from the 0088 scripts; the scripts stop if live values differ and U1/U2 should be read first); that the live TEST template equals the `464dea64` synthesis; the web build and publish; `aws`, `psql` and `session-manager-plugin` availability in the operator's shell.
