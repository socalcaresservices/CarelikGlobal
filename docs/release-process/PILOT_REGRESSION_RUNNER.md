# Pilot regression runner

`infra/aws/slice/pilot_regression.py` automates the API-level part of **Phase C** of `docs/TESTING_AND_RELEASE_PROCESS.md`: catalog **smoke set S** and **regression set R**, plus the standard Service Verification workflow. It writes a report that goes into the release checklist, section C. It does **not** replace the manual catalog cases (screens, mobile layout, Cognito sign-in and MFA, S3/KMS objects, email), UAT, or the owner's GO.

**Status (2026-10-13): implemented and tested locally, NOT yet run against the pilot.** Whether it passes on the real pilot is unknown until an Operator runs it.

## How it works
- It reuses the invoker of the existing smoke suites (`smoke.py`): API-Gateway-shaped events carrying synthetic identities' claims.
  - `--mode aws`: sent to the deployed **pilot** Lambda with `aws lambda invoke` (IAM-gated; run from CloudShell with admin credentials). This exercises Lambda, RDS and the database rules. It does **not** exercise the API Gateway JWT authorizer, except for the two HTTPS checks that run when `--api-url` is given.
  - `--mode local`: sent to a local handler over a database seeded like the pilot (`pilot-regression-local.sh`).
- It creates **one synthetic client** ("Regression <run id>") with **one 10-hour monthly authorization**, runs its cases on it, then cancels its shifts, ends its series and sets the client **Inactive**. Nothing is deleted. It also runs the standard workflow (`smoke.workflow`) on the test-slice agency when given those identities.

## Safety (aws mode)
- Refuses to start without `--i-am-targeting-the-pilot` and `--commit <sha>`.
- Reads the Lambda's configuration (read-only) and **refuses** unless `DB_NAME` is `ogevia_sv_test` (override only with `--expect-db`) and `OGEVIA_ENV` is not `prd`. It only ever targets the stack `Ogevia-prod-ServiceVerificationApi` (the pilot), never `Ogevia-prd-*`.
- Never prints tokens or secret values. Reports contain case names and counts, not identities.

## Run it on the pilot (Operator, CloudShell, after the pilot deployment of the release)
```bash
git fetch origin && git checkout <APPROVED_COMMIT_SHA>
python3 infra/aws/slice/pilot_regression.py --mode aws --i-am-targeting-the-pilot --commit <APPROVED_COMMIT_SHA> \
  --client-id <pilot app client id> \
  --manager-sub <PILOT_MG> --caregiver-a-sub <PILOT_CA> --caregiver-b-sub <PILOT_CB> \
  --caregiver-a-code SCS-CG-A --caregiver-b-code SCS-CG-B \
  --other-manager-sub <TEST_MG> --test-caregiver-sub <TEST_CG> --test-manager-sub <TEST_MG> \
  --api-url <pilot API URL> --report-dir ~/ogevia-regression-reports
```
The subs are the synthetic identities seeded by `infra/aws/db/deploy/02_*` and `04_*` (values in `infra/aws/slice/pilot-e2e/subs.env`). The standard workflow waits about a minute for server time to pass. Run time is a few minutes.

Exit codes: **0** every case ran and passed; **1** a case failed; **2** refused to start; **3** some case could not run (for example `--api-url` omitted). **A release gate needs exit 0.** Do not use `--allow-skip` for a gate.

Copy `pilot-regression-<run>.md` and `.json` into `docs/releases/<release-id>/evidence/` and link them in checklist rows C5 and C7. A FAIL means stop: fix forward and restart at Phase A.

## Test the runner itself (and rehearse Phase C) locally
```bash
HARNESS_PG=postgres://postgres:<pw>@127.0.0.1:5432 bash infra/aws/slice/pilot-regression-local.sh
```
Creates a throwaway database seeded like the pilot, runs the same cases through the local invoker, and writes the report to `~/ogevia-regression-reports`. Without `--api-url` the HTTPS authorizer case cannot run, so locally the expected exit code is **3** (35 passed, 1 not run).

**Evidence that the runner detects defects:** on 2026-10-13, with the reservation accounting deliberately disabled in a throwaway database, the runner failed SCH-02 (a 7-hour shift was accepted), SCH-03 (both racing shifts accepted), the "reserved never exceeds the authorization" check (1140 of 600 minutes) and SCH-10, and exited 1. With the real database it passed.

## What it covers (catalog IDs)
| Catalog ID | Case |
|---|---|
| SMK-01, USR-01 | Each persona signs in with the right role in one membership |
| SMK-04, EVV-05 | Caregiver's client list carries codes only |
| SMK-06 | No sign-in, other issuer, other app client, expired token refused (401); anonymous and forged token over HTTPS when `--api-url` is given |
| USR-01, SCH-13, USR-02 | Caregiver cannot create or list shifts; another agency's manager cannot list clients or visits or create a shift |
| SCH-01, AUT-01 | 4-hour shift reserves 240; balance shows 240 reserved, 360 remaining |
| SCH-07 | Retry with the same key returns the same shift |
| SCH-02 | 7-hour shift refused with the exact hours |
| SCH-03 | Two simultaneous 4-hour shifts for the last 6 hours: exactly one accepted |
| SCH-10 | Cancelling releases the time; a cancelled shift cannot be changed |
| SCH-04 | Overlapping shifts for one caregiver refused |
| SCH-09 | Call-out, replacement, history, reserved time unchanged |
| REC-01, REC-02, REC-03 | Series preview lists every date; flagged dates refuse creation; skipping creates exactly the ok dates and records the rest |
| REC-09, REC-10, REC-11 | Change one occurrence; end the series; time released |
| RPT-01, DSH-01, AUT-01 | Dashboard hours equal client balances; remaining = authorized - billable - reserved |
| DSH-02 | Action needed counts are whole numbers |
| VIS-01, VIS-02, VIS-04, VIS-05, VIS-06, VIS-08, VIS-11, EVV-01, SMK-05 | The standard Service Verification workflow (35 checks) |

**Not covered here, still manual in Phase C:** SMK-02/03/07 (screens, banner), SMK-08 (the standard smoke suites are run separately), VIS-03, VIS-07, VIS-09, VIS-10, EVV-02/03/04, AUT-04 to AUT-11, DSH-03 to DSH-12, RPT-02 to RPT-09, AVL, MAT, NTF, USR-03 to USR-10, REC-04 to REC-08, REC-12. Extend the runner (and this table) when a release changes one of these areas.

## Known limits
- Pilot-only fixtures: the caregiver codes and the service code (`RSP`) must exist in the pilot agency.
- Dates use the agency's default timezone (America/Los_Angeles).
- The runner depends on the pilot's data shape (for example two ready caregivers). If setup fails the report says `SETUP`, and nothing else runs.
- A run leaves one inactive synthetic client with cancelled shifts on the pilot per run.
