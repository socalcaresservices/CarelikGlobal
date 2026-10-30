# V4 readiness: other-tenant and Caregiver negatives, including the same-agency Caregiver check (TEST)

Written 2026-10-28 for candidate `fb491a5`. **Nothing here has been run.** Every result is NOT RUN until the Owner pastes the output; this document passes and excepts nothing. V4 is run **after** the TEST upgrade (`OPERATOR_PROCEDURE_fb491a5.md` Steps 0-16), because the invitation checks need the 0087 API and database.

## 1. What is ready
| Item | State |
|---|---|
| `staff_negative_checks_v3.py` (read-only GETs through the API Lambda: Owner 200, Caregiver and non-Owner 403, other-agency 403/404, unknown agency, missing id) | EXISTS (`docs/releases/2026-10-26-redesign/scripts/`); passed 36 of 36 on TEST on 2026-10-26 with the **same-agency Caregiver not named** (VERIFIED record). The Caregiver check is exactly what is still open. |
| Same-agency Caregiver account | **NOT YET CREATED.** Step C1 below creates it (a real sign-in in the TEST pool with an inbox the Owner controls). |
| `invitation_checks_v4.py` (new: read-only checks of M-1, L-1, L-3 before and after each browser action) | READY: `docs/releases/2026-10-28-staff-invitation-fix/scripts/`; 13 tests against a fake handler (it passes for the world the fix creates and fails, naming the check, for each way it can be wrong); never calls a POST route. **Not yet run against TEST.** |
| Package on CloudShell | the TEST upgrade tarball of `fb491a5`, extracted at `$PKG` (`/tmp/ogevia-pkg`) by Steps 1-3 of the TEST procedure |

## 2. Test accounts (TEST pool `us-west-2_849AYz5J7`, client `1i27abbina08fvg1i9u8vprgo9`; synthetic data only)
| # | Account | Role in the checks | Where it comes from |
|---|---|---|---|
| A | TEST Owner `admin.ogevia@gmail.com`, sub `685183b0-f041-70fb-270e-d8ca934231d2` | Owner of agency `scs-pilot-synthetic`; positive control | exists (VERIFIED 2026-10-26) |
| B | same-agency non-Owner (Manager), sub `d86123c0-90b1-70a2-c52b-501f5efcf7ac` | must get 403 on the four staff routes | exists (VERIFIED 2026-10-26) |
| **C** | **same-agency Caregiver**, to be invited as `admin.ogevia+v4cg@gmail.com` | must get 403 on the four staff routes | **create in Step C1** (Care Team > a synthetic caregiver with no sign-in > Sign-in) |
| D, E | other-agency accounts, subs `58d173c0-e0d1-709f-4288-116f2ed5dbfc` and `8861c310-9081-70d4-85f7-0a33f9a58a94` | belong to a DIFFERENT agency; must get 403/404 on the Owner's agency | exist (VERIFIED 2026-10-26 through the Lambda; **whether they can sign in in a browser is NOT VERIFIED**) |
| X | the **invitee** for M-1 (an EXISTING sign-in whose agency is not A, with an inbox you control) | for V5 (M-1, L-1, L-3) | one of D or E if you can sign in as it; otherwise created per `V5_V7_PREPARATION.md` section 1 |

## 3. Pass criteria
- **C1:** the invitation e-mail arrives; the new person sets a password; `--probe <new sub>` prints `status 200: [('scs-pilot-synthetic', 'caregiver')]`.
- **C2 (the same-agency Caregiver check):** `staff_negative_checks_v3.py` with `--caregiver-sub <sub of C>` prints, for the Caregiver, a `PASS` line in area `setup` ("the named Caregiver is a member of the Owner's agency") and four `PASS` lines in area `negative` ("<route>: Caregiver -> 403 (must be 403)", one per staff route); the line `Caregiver not named: not checked` is **gone**; the last lines are `N checks, 0 failed` and `STAFF CHECKS PASSED`; exit 0.
- **C3 (re-run for the other accounts after the upgrade):** the same run also shows Owner 200 on 4 routes, non-Owner 403 on 4, each other-agency account 403/404 with no data on 4 routes and the Owner 403/404 on their agencies, unknown agency 403/404, no organizationId 400.
- **C4 (0087 checks):** `invitation_checks_v4.py` ends `INVITATION CHECKS PASSED` for phases `before`, `after` (and `inactive`, if V5 runs that step).

## 4. Fail criteria (each is a STOP; none is an exception)
- Any `200` or any returned data for the Caregiver, the non-Owner, or an other-agency account on a staff route: **P0, cross-tenant or privilege exposure.** Stop, roll back per R1-R3 of the TEST procedure, report.
- The Caregiver is not a member of the Owner's agency (setup check fails): the account was created in the wrong place; recreate, never excuse.
- `STAFF CHECKS FAILED` or a non-zero exit; a script error; the line `Caregiver not named: not checked` still present.
- `invitation_checks_v4.py` `before` phase shows the invitee **has** a membership in the Owner's agency (M-1 not fixed), or a pending invitation that exposes an e-mail or name (L-1).

## 5. Exact execution steps (CloudShell, after the TEST upgrade; read-only unless marked)
Uses `$PKG` and `session-env.sh` from the TEST procedure. Upload `staff_negative_checks_v3.py` and `invitation_checks_v4.py` to CloudShell (their sha256 travel in the covering message), then:
```
source ~/ogevia-before/session-env.sh
cp ~/staff_negative_checks_v3.py ~/invitation_checks_v4.py "$PKG"/ && cd "$PKG"
CLIENT=1i27abbina08fvg1i9u8vprgo9; OWNER=685183b0-f041-70fb-270e-d8ca934231d2; MGR=d86123c0-90b1-70a2-c52b-501f5efcf7ac
OTH1=58d173c0-e0d1-709f-4288-116f2ed5dbfc; OTH2=8861c310-9081-70d4-85f7-0a33f9a58a94
```
**C1 - create the same-agency Caregiver (the Owner, in the browser; this WRITES one synthetic TEST sign-in).** Sign in at `https://demo.ogevia.com` (the amber TEST band must show) as the Owner. Care Team > open a synthetic caregiver that has no sign-in > Sign-in > Caregiver's email `admin.ogevia+v4cg@gmail.com` > send. Open the e-mail in the Owner's Gmail inbox, follow the link, set a password (never paste it anywhere).

**C1b - learn the new sub and probe it (read-only).**
```
aws cognito-idp list-users --user-pool-id us-west-2_849AYz5J7 --region us-west-2 --query 'Users[].[Attributes[?Name==`sub`]|[0].Value,UserStatus,Enabled]' --output text
CG=<the newest user's sub from the line above>
python3 staff_negative_checks_v3.py --client-id $CLIENT --probe $CG $MGR $OTH1 $OTH2
```
Expected: `status 200: [('scs-pilot-synthetic', 'caregiver')]` for `$CG`; a manager role for `$MGR`; one different agency for each of `$OTH1` and `$OTH2`.

**C2/C3 - the full negative run with the Caregiver named (read-only).**
```
python3 staff_negative_checks_v3.py --client-id $CLIENT --owner-sub $OWNER --nonowner-sub $MGR --caregiver-sub $CG --other-agency-subs $OTH1 $OTH2 | tee ~/ogevia-before/v4-run.txt | tail -25
```
Expected: see section 3 (C2 and C3). Paste back the whole output (it contains only statuses, roles and agency short names).

**C4 - the invitation checks are run inside V5**, between the browser actions (see `V5_V7_PREPARATION.md` section 1).

## 6. Limits
Direct Lambda calls with the account's sub (IAM-gated), not a browser sign-in with a real token; the API Gateway JWT authorizer is exercised for refusals (401) only, by the route smoke of the procedure. Read-only GETs of the four staff routes only. `--other-agency-subs` proves isolation only for those two agencies.
