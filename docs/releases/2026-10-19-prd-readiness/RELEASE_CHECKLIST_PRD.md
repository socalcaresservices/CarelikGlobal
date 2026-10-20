# Production release checklist: 2026-10-19-prd-readiness (46/0046 to 85/0085, API, web)

Status words: **proposed, implemented, tested, deployed, accepted** (never interchangeable). Everything below is **implemented and tested locally (mock AWS, real PostgreSQL 16)**. **Nothing is deployed to production.** Process: `docs/TESTING_AND_RELEASE_PROCESS.md`; template: `docs/release-process/RELEASE_CHECKLIST_TEMPLATE.md`. This file is the production-specific, short form; the template's phases A-E still apply to the code at `e80b770`, which the owner accepted on TEST.

## 0. Identity
| Field | Value |
|---|---|
| Code commit (the TEST operator tarball `ogevia-operator-e80b770`; accepted on TEST) | `e80b770210c54e423d28ecf48e00f1dda9506cec` |
| Release package | `ogevia-prd-release.tar.gz` (built from the commit named in its `BUILD_INFO.json`; its sha256 is given with the GO message) |
| Production stacks changed | `Ogevia-prd-ServiceVerificationApi` ONLY (gate: EXPECTED-ONLY YES, 68 resources added = 66 JWT routes + ComplianceSweep rule and permission; 5 changed) |
| Database | `ogevia_prd` 46/0046 to 85/0085 (39 migrations, rehearsed on a restored copy: forward, verify, rollback all PASS) |
| Data | all existing production records are owner-confirmed synthetic (readiness plan section 29); no real client, caregiver or PHI |
| Approval reference (owner-supplied 2026-10-20) | `owner-go-prd-20261020-01` (becomes the tag value `approved-owner-go-prd-20261020-01`; the placeholder `APPROVAL-REF-PENDING-OWNER` is refused). The TEST reference `owner-go-test-20261019-02` is not used for production. |
| Release window (UTC, at most 12 h) | **GO given for** (recommended window, assumed: 2026-10-21T17:00:00Z to 2026-10-21T21:00:00Z, see the readiness plan section 36) |

## 1. Evidence already in hand (all tested; none deployed)
| Item | Evidence |
|---|---|
| Production-copy rehearsal R0-R8 | PASS (readiness plan sections 22-28): 39 migrations in 11 s on the copy, verification set, schema parity with TEST, existing data unchanged, rollback to 46/0046 equal to baseline except the 11 objects the 0047 down script keeps by design |
| Stage A discovery + Stage B expected-only gate on REAL production | GATE PASSED (readiness plan section 34) |
| D1 migration executor | 25-test suite `prd-release-exec.db.test.ts`: pins, snapshot checks, gate, window open/close, DRIFT stop, lock-induced failure, full migration, rollback with two phrases, interrupted window and `--restore-only`, verb allow-list |
| D2 assembly | mock tests + a REAL `cdk synth -c env=prd -c mode=deploy` with an approval reference passes the assembly check against the real release templates. **Real finding:** the deploy-mode tag value is `approved-<REF>` (the first version of the check expected the bare reference and would have blocked the release) |
| D3 web | mock tests + a REAL `vite build` embeds `VITE_APP_VERSION:"<commit>"` with the other `VITE_*` values in the minified bundle exactly as the scripts parse them |
| E1 record | mock tests |

## 2. Mandatory before GO (owner or operator; none can be done by the package)
| # | Action | Why | Command / artifact |
|---|---|---|---|
| M1 | ~~approval reference~~ supplied: `owner-go-prd-20261020-01`. **GO recorded 2026-10-20 (owner: "GO for the 2026-10-21 window; operator preparation starts now")** for the recommended window 2026-10-21T17:00:00Z to 2026-10-21T21:00:00Z (assumed to be that window; owner to say if different). The GO opens the window and preparation; every YELLOW step still stops at its typed phrase | every YELLOW script requires them; the approval reference becomes the `ogevia:deployment-status` tag | GO message |
| M2 | **RESOLVED 2026-10-20 (owner statement):** TEST authoritative reference `owner-go-test-20261019-02`; `APPROVAL-REF-PENDING-OWNER` in the TEST tarball is a placeholder and not authoritative; production uses `owner-go-prd-20261020-01`. No script or tarball change needed (the production scripts read the reference only from `OGEVIA_DEPLOY_APPROVAL`). | one agreed reference per environment | closed |
| M3 | Operator confirms **the admin host is running** and gives its private IP | the migration rule names that /32 only | `OGEVIA_EXPECT_HOST_IP` |
| M4 | Operator extracts both tarballs in CloudShell, verifies both manifests and the release tarball sha256, installs dependencies in the operator package (`pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store`) | the assembly and the web build run from that package | README setup |
| M5 | Run step 1 of the README sequence (`p2-gate.sh`) the same day; if it reports CHANGED, rerun `p0-baseline-capture.sh` and review | the recovery copy of the web must be the site being replaced; the gate must describe today's production | README |
| M6 | Run steps 2-4 (assembly, guard `check`, web build) BEFORE opening the window; any FAIL ends the attempt with nothing changed | these are local or read-only | README |
| M7 | Owner accepts the **1-2 minute gap** between the migration and the API deploy (estimate, not measured) | the old API fails against the new schema; data is synthetic | owner decision |
| M8 | Owner decides snapshot retention (and the rehearsal snapshot `...pre-rehearsal-202610200131`, delete by 2026-10-27, a RED step) | cost; not a blocker for GO | owner decision |
| M9 | A person is ready to **sign in on the production web** and run the acceptance checks after step 10 | the package cannot prove Cognito sign-in, MFA or the screens | manual |
| M10 | A second CloudShell/session is open for recovery during the migration window | if the first session is lost the temporary rule is NOT removed automatically | `--restore-only` |

## 3. Known gaps (not blockers; stated so nobody assumes otherwise)
- No script performs the API quick rollback (previous asset exists and is documented); the DB rollback drops tables with rows and the snapshot restore is not a prepared procedure.
- The AWS side of every YELLOW step has never run (mocks emulate the calls). The first real run is the real test; each step stops on any unexpected result.
- Reproducibility of the CDK asset hashes in CloudShell is checked by the assembly check at run time (it reproduced in the development container).
- Production web `config.json` handling: the package never replaces one.

## 4. Sign-off
Prepared (implemented and tested locally): Claude Code, 2026-10-20. Owner GO: ____________ date ____________ approval reference ____________ window ____________ to ____________
