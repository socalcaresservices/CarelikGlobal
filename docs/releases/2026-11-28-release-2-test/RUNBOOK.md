# Release 2 in TEST: operator runbook (migrations 0124 + 0125, three switches)

Branch `claude/amazing-clarke-8b309z` (PR #125), which contains PR #124. **Nothing here has been run.** TEST only: database `ogevia_sv_test`, stacks `Ogevia-prod-*`, account 300094796789, us-west-2. Production is not touched. Synthetic data only.

## What is added
| Item | Needs | Switch (TEST config) | New routes |
|---|---|---|---|
| 0124 NFC/QR visit verification | 0110, 0111 in the ledger | `homeLabels` | 29 |
| 0125 Authorization Worklist | 0110, 0111 in the ledger | `authorizationWorklist` | 1 |
| Signing-link email | the email function from stages 4-6 (`notifications` + `notificationEmail`) | `signatureEmail` | 1 |
| Stroke-based secure-link signing, exports, office filters | nothing (code only) | none | 0 |
Total with all three switches on: **+31 routes**. With all three OFF the API has no new routes (only a new code bundle).

## 0. Before anything
1. TEST must already hold stages 1-7 (migrations 0113-0123; email function live). Check: `TEST_DB_SESSION.sh bash TEST_PENDING_LEDGER.sh probe 0124` prints `prerequisites missing: none`. If a stage is missing, finish it first with its own script (`docs/release-train-2/deployment-plan.md`).
2. `git checkout <release commit>` on a clean checkout. The stage scripts require the application files to equal an "audited commit": set `OGEVIA_APP_BASE=<this release commit>` (the pins were re-pinned to it) or they will refuse.
3. Owner TEST authorization reference in `OGEVIA_DEPLOY_APPROVAL` (6-64 chars).

## 1. Database (reversible, one migration per run, ledger row in the same transaction)
```bash
export PGDATABASE=ogevia_sv_test OGEVIA_DEPLOY_APPROVAL=<ref> OGEVIA_TEST_SNAPSHOT=<fresh available snapshot id of ogevia-postgres, under 24 h>
TC=docs/releases/2026-11-20-test-plan/toolchain
bash $TC/TEST_DB_SESSION.sh bash $TC/TEST_PENDING_LEDGER.sh probe  0124
bash $TC/TEST_DB_SESSION.sh bash $TC/TEST_PENDING_LEDGER.sh apply  0124
bash $TC/TEST_DB_SESSION.sh bash $TC/TEST_PENDING_LEDGER.sh verify 0124
# same three commands for 0125
```
`probe` refuses if a prerequisite is missing or the migration is already recorded; `verify` checks the ledger checksum plus 13 tables and 34 functions for 0124 (definer, pinned search_path, no PUBLIC execute, app role may execute) and the one 0125 function. The verification file itself is tested locally (`verify-pending-0124-0125.db.test.ts`).
Both migrations are additive; 0124's rollback drops its 13 tables **with their rows** (the snapshot is the restore point), 0125's drops one function.

## 2. Code and switches (API + web)
The existing stage scripts (`TEST_RT2_N*.sh`) are hard-wired to their own migration and route set; **a stage-8 script for this release does not exist yet.** Until it does, do it as a normal reviewed TEST change set:
1. In the isolated-TEST features line of `infra/aws/lib/config.ts` (the one `TEST_RT2_N7_READINESS_OVERRIDE.sh` edits) keep every switch that is ON today and add `homeLabels: true, authorizationWorklist: true, signatureEmail: true`. Do this first with all three **false** and deploy the code only; then turn them on one at a time (homeLabels, authorizationWorklist, signatureEmail), in that order.
2. `cdk synth` / `cdk diff` for `Ogevia-prod-ServiceVerificationApi` each time. Expected: switches off = Handler code asset change only; each switch on = exactly its routes (29, 1, 1), all `AuthorizationType: JWT`, nothing else. Anything else: stop.
3. Web: build for TEST stamped with the commit and publish with the existing method (`deploy-test-slice.sh` / the stage web step), then check the served `index.html` references the new bundle.
4. Smoke (no token): each new route answers 401 (not 403/404/500) once its switch is on; with the switch off the route does not exist.

## 3. Acceptance in TEST (synthetic client, caregiver, manager; owner signs off)
| # | Check | Expected |
|---|---|---|
| 1 | Menu as an Administrator | "Authorization worklist" (Clients) and "Visit verification" (Operations) appear **only** after their switch is on; "Caregiver holds" is always present for readiness.read |
| 2 | Authorization worklist | shows missing / expired / expiring / exhausted / nearly exhausted for the synthetic clients; filters by office, program, month; CSV and Excel open in Excel with the same rows and order; Print preview is clean |
| 3 | Client record > Service address and home label | add an address (city and ZIP required); register 2 stickers; assign by typing the ID; duplicate and other-agency assignment refused; print the label in the three layouts (no name or address on it) |
| 4 | **Real iPhone and Android**: tap a programmed tag and scan the QR | opens Ogevia, asks to sign in, resumes; preview only (no time saved); Clock in saves once; repeated tap/reload never checks out; Clock out saves; location prompt appears only on the button press |
| 5 | Wrong/revoked label, outside the window, other caregiver | refused with a plain reason; attempt visible under Visit exceptions |
| 6 | Off-site checkout of a home-only visit | saved; no signing on the phone; follow-up "direct confirmation"; appears in Checked out without signature |
| 7 | Sign now on the phone | pad works with a finger; "Signed <date>" shown; a pasted/uploaded picture cannot be submitted (API refuses) |
| 8 | Sign later, then **Email the link** to the TEST allow-listed address | email arrives with a generic subject, the link, no code and no visit details; staff screen shows the 6-digit code; link + code on the secure page works once; the follow-up clears |
| 9 | Resend | earlier open link is revoked; old link no longer works |
| 10 | Email to a non-allow-listed address | "could not be sent"; link and code are shown for copying; delivery failure recorded |
| 11 | Reports | six reports load; office filter works; CSV (export permission) / Excel / Print |
| 12 | Isolation | a second synthetic agency sees none of the above |

Record device models, browsers, prompts shown, and screenshots under this folder.

## 4. Rollback (reverse order, each step reversible)
1. Set the three switches back to false and deploy (routes disappear; data stays).
2. `TEST_PENDING_LEDGER.sh rollback 0125`, then `rollback 0124` (typed approval; 0124 drops its tables **with their rows**).
3. The stage-7 web/API captures remain the rollback reference for the code.

## 5. Not covered by this package
A stage-8 automation script with its mocked test and gate (the pattern of `TEST_RT2_N7_*`). It is the next thing to build once the TEST state is confirmed by the `probe` above, so the script matches the real ledger and live template.
