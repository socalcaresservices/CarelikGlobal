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
# same three commands for 0125, then for 0126 (service address history; needs 0124)
```
`probe` refuses if a prerequisite is missing or the migration is already recorded; `verify` checks the ledger checksum plus 13 tables and 34 functions for 0124 (definer, pinned search_path, no PUBLIC execute, app role may execute) and the one 0125 function. The verification file itself is tested locally (`verify-pending-0124-0125.db.test.ts`).
Both migrations are additive; 0124's rollback drops its 13 tables **with their rows** (the snapshot is the restore point), 0125's drops one function, 0126's drops its history table and the inactive columns (the addresses stay; the three 0124 functions it replaces are restored exactly).

## 2. Code and switches (API + web): `TEST_R2_N8_SWITCH.sh`, one switch per run
The script follows the stage-7 pattern (guards, read-only capture of the live TEST state, both assemblies gated by `diff_gate_rt2.py` BEFORE anything changes, typed confirmation, `cdk deploy` of the one API stack, post-deploy checks, web publish and check). It **does not touch the database** (it only re-verifies 0123 and the migration the switch needs). Tested with stand-in tools (`test-r2-n8-switch.test.ts`: refusals, gate violation, happy path for each switch, rollbacks); **not yet run against real AWS**.
```bash
cd /tmp/ogevia && git pull --ff-only          # or re-clone; use the release commit printed in the PR
export REPO=/tmp/ogevia OGEVIA_RELEASE_COMMIT=$(git rev-parse HEAD) OGEVIA_APP_BASE=$(git rev-parse HEAD)
export WORK=/tmp/r2work && mkdir -p $WORK
export OGEVIA_DEPLOY_APPROVAL=<your reference> OGEVIA_EXTRA_RECIPIENT=<the caregiver test email address already allowed on the TEST email function>
TC=docs/releases/2026-11-20-test-plan/toolchain
# run 1
OGEVIA_SWITCH=homeLabels bash $TC/TEST_R2_N8_SWITCH.sh
# run 2 (after run 1 is accepted)
OGEVIA_SWITCH=authorizationWorklist OGEVIA_SWITCHES_ON=homeLabels bash $TC/TEST_R2_N8_SWITCH.sh
# run 3
OGEVIA_SWITCH=signatureEmail OGEVIA_SWITCHES_ON=homeLabels,authorizationWorklist bash $TC/TEST_R2_N8_SWITCH.sh
```
Expected route additions: 29, 1, 1 (all JWT). The script stops at the first failure and says why. Rollback for a run: `OGEVIA_SWITCH=<same> bash $TC/TEST_R2_N8_SWITCH.sh rollback-web`, then `rollback-routes`, then `rollback-api` (each asks you to type a confirmation).

## 2b. Step 4: service address history (migration 0126, switch `serviceAddresses`, 4 routes) and the Home stickers screens
Do the database step first (section 1, for 0126; take a fresh snapshot), then:
```bash
OGEVIA_SWITCH=serviceAddresses OGEVIA_SWITCHES_ON=homeLabels,authorizationWorklist,signatureEmail bash $TC/TEST_R2_N8_SWITCH.sh
```
Confirmation text: `DEPLOY-TEST-serviceAddresses`. Expected: 4 routes added (all JWT), 334 live after. This run also publishes the web build, which carries the **Home stickers** menu entry and page, the validated "Sticker ID or sticker link" field, and the address controls. **Rules built in:** one current home address per client (database-enforced); a second address is added as an *alternate* and can carry its own sticker; making an address current is one step and the previous one becomes an alternate; *historical* turns that address's sticker off; a wrong address can be deleted only if it never had a sticker (its text is scrubbed from the history); at the sticker of a non-current address an **arrival** is refused ("not the current service address") and appears in Visit exceptions, a **departure** is never blocked. Only home addresses are limited to one current; community places are not.

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
| 13 | Home stickers menu and page (Operations) | the menu entry opens a page with the three steps; Register creates IDs; each row has "Print, copy link or change" |
| 14 | Sticker ID or link field | `OGL-7K3M9XQ2`-style ID or the full link is accepted; `OGL-1111111` shows "never contains 1" and "exactly 8 characters"; a registered ID assigns |
| 15 | Two-parent home: add a second home address | saved as **Alternate (not current)**; give it its own sticker; the first stays current |
| 16 | Make the alternate current | one step; the other becomes Alternate; at the old address's sticker a clock-in is refused with a plain reason and shows under Visit exceptions; the new address's sticker clocks in; a clock-**out** at the old sticker still works |
| 17 | Mark inactive / historical, with a reason | reason required; historical turns that sticker off; the address stays in the history; "Use this address again" works |
| 18 | Delete an address entered by mistake | allowed only if it never had a sticker; refused otherwise with the reason; the history shows "Address deleted" and no street text |
| 19 | Address history | opens on request, newest first, who and why; an edit shows the previous address |

Record device models, browsers, prompts shown, and screenshots under this folder.

## 4. Rollback (reverse order, each step reversible)
1. Set the three switches back to false and deploy (routes disappear; data stays).
2. `TEST_PENDING_LEDGER.sh rollback 0125`, then `rollback 0124` (typed approval; 0124 drops its tables **with their rows**).
3. The stage-7 web/API captures remain the rollback reference for the code.

## 5. Status
0124 and 0125 were applied and verified in TEST by the operator on 2026-11-28 (ledger 125 rows, last 0125; snapshot `ogevia-r2-pre-0124-202611280143`). The code and switch steps (section 2) are next.
