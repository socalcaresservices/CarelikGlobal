# Plan: align the production branch and the CDK code with the live infrastructure

**Status: PROPOSED PLAN for the owner's review. Nothing in this plan has been executed.** No deployment, no `cdk deploy`, no change-set, no migration, no production change. The only code added is a read-only report tool and its tests (section 4); it only reads two JSON files.
Written 2026-11-15 after the sign-in override release. Facts marked VERIFIED were read in the repository or measured locally; UNKNOWN means it needs the live stack, which this environment cannot read.

## 1. The two gaps today
### 1a. Branch: production runs a branch that is not `main`
| Fact | Evidence |
|---|---|
| Production was deployed from the UX branch `claude/ogevia-ux-audit-redesign-w36cov` (Handler code, website, database 0103 to 0107), not from `main` | VERIFIED: `docs/releases/2026-11-10-ux-redesign-test/RELEASE_READINESS.md`; the API's Handler hash matches accepted TEST code |
| `origin/main` is at `466f8ac9`. The UX branch is **253 commits ahead**, `main` has **0 commits** the UX branch lacks | VERIFIED: `git rev-list --count` |
| Merging the UX branch into `main` is a clean fast-forward-equivalent: **no conflicts** (`git merge-tree`), 704 files changed, +57,169 / −2,039 lines | VERIFIED locally |
| The UX branch has an open draft pull request into `main`: #108 "DRAFT: Reconcile accepted TEST features with UX redesign and isolated release". Pull request #109 (sign-in override, deployed and accepted) targets the UX branch | VERIFIED: GitHub |
| Other open pull requests are based on older or unrelated branches (#98 and #99 on an older `main`; #100 to #107 on release-candidate branches, several marked "do not merge") | VERIFIED: GitHub list |

### 1b. CDK: the code does not describe production
| Gap | Evidence |
|---|---|
| Production's API serves **six routes the CDK code does not synthesize for production**: `GET /v1/reports/missing-visits`, `POST /v1/shifts/{shiftId}/missing-visit`, `GET` and `POST /v1/business-documents`, `POST /v1/checkin`, `POST /v1/clients/{clientId}/qr-card`. A `cdk deploy` of the production API stack would **remove them** | VERIFIED: `production-signin-override-release.test.ts` (real synthesis lacks them); `production-ux-release.py` requires them in the live template |
| They are behind `features.liveTestRepairs`, which is **TEST-only by code**: the stack throws `"Accepted live repair routes are TEST-only"` unless `envName === "prod"` and the database purpose is `test-slice`. Setting it for production is impossible without changing that guard | VERIFIED: `lib/service-verification-api-stack.ts:435-436`, `lib/config.ts` (`resolveLiveTestBaseline`, `resolveTestDatabase`) |
| The same feature also adds things production names differently: the QR parameter (`ClientQrEncryptionKey` in code, **`QrEncryptionKey0102` in production**), `RepairCodeBucket` / `RepairCodeKey` code parameters, a handler `Tags` override from CLI context, and fixed logical ids for four of the routes (`BusinessDocumentsGet0095`, `BusinessDocumentsPost0095`, `QrCheckinPost0102`, `ClientQrCardPost0102`) with the cdk path metadata removed | VERIFIED in code. **UNKNOWN** whether production's logical ids equal TEST's |
| The Handler's `Code` in production is a manually packaged zip, not the CDK asset the code would produce | VERIFIED: `production-ux-release.py` patches `Code` to a literal S3 key |
| Today's safe path therefore patches the **captured live template** (the sign-in override release did exactly that) | VERIFIED |

## 2. Principles
1. **Never `cdk deploy`, and never create a change set from a synthesized template, until a synthesized template provably equals the live one.** A logical-id difference makes CloudFormation delete and recreate a route.
2. One source of truth for production: `main`, with CDK code that synthesizes the live stack.
3. Every step reversible, with its own checklist and owner GO. No history rewrite, no force-push.
4. The proof is data, not belief: a committed copy of the live templates and a test that the code synthesizes them.

## 3. Stages (each a separate release; only Stage 0 touches AWS, and only to read)
### Stage 0: capture and measure (read-only, about 30 minutes, the owner in CloudShell)
Capture the live templates of the six production stacks that `cdk synth -c env=prd -c mode=plan` produces and compare each with the code. (`Ogevia-prd-NetworkEgress`, which `deploy-production.sh` manages, comes from a different synth mode and is left for a later step.) Uses the tool in section 4.
```bash
cd /tmp/CarelikGlobal && git fetch origin claude/keen-hawking-e9o2jg && git checkout --detach origin/claude/keen-hawking-e9o2jg   # or the commit the owner names
export PATH=/tmp/node-v22.11.0-linux-x64/bin:$PATH
mkdir -p /tmp/drift && (cd infra/aws && npx cdk synth --quiet -c env=prd -c mode=plan --output /tmp/drift/cdk.out)
for S in Auth DatabaseSecret EvidenceStorage ServiceVerificationApi Observability WebHosting; do
  aws cloudformation get-template --stack-name "Ogevia-prd-$S" --template-stage Original --query TemplateBody --output json > "/tmp/drift/live-$S.json"
  python3 infra/aws/scripts/production-template-drift.py "/tmp/drift/live-$S.json" "/tmp/drift/cdk.out/Ogevia-prd-$S.template.json" | tee "/tmp/drift/drift-$S.txt"
done
```
Paste the reports (they print no secret value: names containing KEY, SECRET, TOKEN, PASSWORD or CREDENTIAL are shown as "value hidden"). The templates themselves hold definitions, ids and ARNs, no secret values (NoEcho parameters are definitions only); review before committing any of them. For the API stack the expected drift is the six routes only in live, the QR parameter, and the Handler `Code`; the report will show the real logical ids.
**Gate:** the owner and I read the reports together and agree the exact drift list. Output: the list; no change.

### Stage 1: branch alignment (pull-request review, no AWS)
1. Merge pull request #109 into the UX branch (docs, tests, the release scripts; the one behavioral change, `signInOverride` for production, is already deployed).
2. Review pull request #108 (UX branch into `main`) as the owner's decision: 704 files. Because `main` has nothing the UX branch lacks, merging it is a **clean fast-forward-equivalent**, so no content is rewritten and production's deployed source is exactly what lands on `main`. CI must be green; merge with a normal merge commit, no force-push, no rebase of the shared branch.
3. After the merge: `main` is the single base; point `docs/` and the release scripts at `main`; decide the fate of the stale pull requests (#98, #99 on an older `main`; #100 to #107 are marked "do not merge").
**Rollback:** a revert commit on `main` (history preserved); production is unaffected because nothing is deployed by a merge.
**Risk:** the 704-file review. Mitigation: the owner already accepted this content on TEST and production; the merge changes no deployed bytes.

### Stage 2: make the code synthesize production (code only, no AWS)
After the Stage 0 reports exist:
1. Add a **separate** production-only compatibility mode (working name `liveProductionBaseline`), never reusing the TEST-only `liveTestRepairs` or relaxing its guard. It adds exactly what the reports list: the six routes with the **live** logical ids, no construct-path metadata where live has none, the live parameter names (`QrEncryptionKey0102`, plus `RepairCodeBucket` / `RepairCodeKey` only if live has them), and the Handler tags. Everything else stays as is.
2. Commit the redacted live templates as fixtures under `infra/aws/test/fixtures/prd-live-<date>/`.
3. Add a test that the synthesized production stacks **equal** those fixtures, with an explicit allow-list of the deltas still expected (the Handler `Code` asset until Stage 3 settles it). Any other difference fails CI.
4. Decide, with the owner, the Handler `Code`: (a) keep the manually packaged zip via a parameter, or (b) accept the CDK-built asset, which is allowed only if its bytes equal the accepted bundle (the accepted hash is pinned in `production-ux-release.py`; two independent CDK CLI builds were already shown to be identical in the 2026-11-11 record).
**Rollback:** code only; revert the commit. Nothing is deployed.
**Risk:** a wrong logical id would be caught by the equality test before any AWS action.

### Stage 3: prove it against production without changing it (one read-only AWS operation per stack)
1. Create a CloudFormation change set from the aligned, synthesized template for each stack and require that CloudFormation answers **"The submitted information didn't contain changes"** (a no-op). If it lists any change, **stop**: nothing is executed and the difference goes back to Stage 2.
2. Only after every stack proves a no-op, retire the "patch the captured live template" procedure for these stacks; future releases are `cdk synth` plus a guard (like `production-signin-override-release.py`) plus a change set.
**Rollback:** nothing to roll back (no change set is executed).
**Rule:** a change set is never executed in this stage.

## 4. The tool added for Stage 0: `infra/aws/scripts/production-template-drift.py` (read-only)
`python3 production-template-drift.py LIVE.json CANDIDATE.json [--fail-on-drift]` prints: routes only in live, routes only in code, routes whose logical id differs (the delete-and-recreate hazard), other resources only on one side, resources whose definition differs (Lambda environment variables compared by name; secret-looking values hidden), and parameter, condition, output and mapping differences. It reads two files, makes no AWS or network call and writes nothing. **Tests:** `infra/aws/test/production-template-drift.test.ts` (5 passing), on the real synthesized production template with a "live" template built the way production differs.
As a sanity check it was run on the repo's earlier real production capture (`test/fixtures/auth-separation/deployed/`, from before the staff routes and the six routes existed): it reported the 24 routes added since then, the CORS and Handler code differences, and nothing else. That is an old capture, **not** today's live state.

## 5. Risks of doing nothing
| Risk | Effect |
|---|---|
| Someone runs `cdk deploy` on the production API stack | The six routes (business documents, missing visits, QR check-in and QR card) are removed |
| The next release repeats the live-template patch | Works, but needs a captured template and a bespoke guard each time |
| `main` stays behind production | A fresh checkout of `main` does not describe what runs; CLAUDE.md's "verify checkout freshness" rule cannot be satisfied from `main` |

## 6. Decisions needed from the owner
1. Approve Stage 0 (read-only capture) and send the reports.
2. Merge path for Stage 1: pull request #109 into the UX branch, then #108 into `main` as a normal merge commit after review; and what to do with the stale pull requests.
3. Handler `Code` in Stage 2: parameterized live zip, or the CDK-built asset if its bytes match the accepted bundle.
4. Whether the live templates may be committed as fixtures (they hold ids and ARNs, no secret values).

## 7. What this plan does not do
It does not deploy, import or change any stack; it does not enable `liveTestRepairs` for production; it does not touch the database (the database fixes are the separate proposal in `docs/releases/2026-11-15-db-fixes-migration/`); it does not realign object ownership in the database.
