# Release readiness status (2026-11-11). TEST only. Nothing deployed, merged or applied. Security NOT approved.

**Proposed release commit: `7f9483d39690ae94db2710465d6995cd0b82b271`.** CI run 431 on exactly this commit: success (validate, harness, postgres). Earlier candidate `69b122f` failed CI (a production-vs-TEST route parity test) and is superseded.

## CloudShell read-only checks U1 to U4 (run in us-west-2, account 300094796789; they only read)
Full block and interpretation: `docs/aws/DEMO_AUTODEPLOY_READONLY_CHECKS.md`. Summary of what each verifies:
| Check | Command family | What it verifies | Needed for |
|---|---|---|---|
| 0 | `aws sts get-caller-identity` | You are in the right account | every step |
| U1 | `aws rds describe-db-instances` (table) | Which RDS instance holds `ogevia_sv_test`, that it is private, backed up and sized as expected, and whether TEST and production share it (records say yes) | snapshot step S4, separation proposal, risk statement |
| U2 | `aws iam list-attached-role-policies` / `list-role-policies` for `OgeviaDBAdminSSMRole`; `aws ec2 describe-instances` for the admin host | What the admin host can reach and that it is running | migration step S5 |
| U3 | `aws cloudformation list-stacks`, `describe-stacks` outputs of the web-hosting stacks, `aws cloudfront list-distributions`, `aws iam list-open-id-connect-providers` | TEST web bucket and distribution ids, and that they differ from production's | web deploy S7 and rollback copy S4 |
| U4 | not AWS: GitHub Settings, Billing and plans, Usage | Actions minutes available (only for the optional automated-deploy proposal) | automation proposal only |

## Status table
| Item | Status | Detail |
|---|---|---|
| Dependency advisories (all 9 audit entries) analysed | **PASS (analysis)** | `SEC-3_EXCELJS_ADVISORIES.md`: 8 high/moderate brace-expansion findings + 1 uuid; not reachable (0 calls on a hostile read); patches exist; overrides clear all 9 |
| Security approval | **BLOCKED (owner)** | Not given; sign-off lines are blank on purpose |
| Overrides fix verified | **PASS** | audit through exceljs 9 to 0; parser 10/10, import API 6/6; bundle 1.13 MB, loads |
| Final CI on the exact release commit `7f9483d` | **PASS** | run 431 success |
| Local gates on a clean clone | **PASS** at `d7f7147` (before overrides and switches); infra suite re-run after the switches found and fixed one parity test; CI run 431 covers lint, typecheck, build, unit and database suites on the final commit |
| Switches: TEST on, production off | **PASS** | switch tests and the parity test assert exactly the 5 routes differ |
| U1 to U4 commands | **PASS (provided)** / results **BLOCKED** | need you or the operator to run them |
| TEST deployment plan | **PASS (prepared)** | `TEST_DEPLOYMENT_PLAN.md`; pinned toolchain generated in `toolchain/` (2026-11-11): scripts, hashes, commands; selftests pass; AWS calls not verified |
| 23-case Feature Test Plan | **PASS (kept)** | section 7 says which cases need TEST |
| Local regression (smoke and regression set) | **BLOCKED in part** | 35 pass, 0 fail, 1 not run (SMK-06 needs the deployed API) |
| Feature cases needing deployed TEST | **BLOCKED** | UXR-08c, 09b, 19 (cold start), 21, 23, TEST parts of 01 to 16, UXR-18 final gate |
| Feature cases needing you or a phone | **BLOCKED** | UXR-01c, 03b, 13 wording, 14c, 22 |
| Phase A and B sign-offs | **BLOCKED (person)** | blank on purpose |
| Phase C | **NOT STARTED** | needs your written statement |

## Who does what
| I can complete independently (done or doable now) | Needs your approval or decision | Needs you, the operator, or a physical device |
|---|---|---|
| Analysis, patches prepared, CI reads, plan and checklist text, generating the pinned toolchain and run commands for the commit once you authorize, re-running any local test | Security approval and SEC-3 option (A/B/C/D); SEC-5 (caregiver sees first name + initial, city); the Phase C statement (commit, TEST only, operator, window); applying migrations; deploying; merging; whether to delete the separate-database proposal or approve it | Running U1 to U4 in CloudShell; running every Phase C command; UXR-01c, 03b, 14c, 22; judging R27 wording; UAT |

## Recommendation
**Do not start Phase C yet; the candidate is ready for you to decide.** Specifically: (1) read `SEC-3_EXCELJS_ADVISORIES.md` and choose option A (recommended) or another, and sign or reject the security review; (2) run U1 to U4 and send me the output so the plan's database and bucket names are confirmed rather than assumed; (3) name the operator and the window and give the written Phase C statement for commit `7f9483d`; then I generate the pinned toolchain for that commit and the operator can begin at S0. Releasing to **TEST only** is reasonable once those three are done. **Production is not recommended or authorized** by anything here.
