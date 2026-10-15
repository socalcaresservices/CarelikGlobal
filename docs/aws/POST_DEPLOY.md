# Post-deploy script (`infra/aws/slice/post-deploy.sh`)

Status: **PREPARED FOR REVIEW. NOT RUN. No AWS change was made to write it.** Run it in AWS CloudShell, after `deploy-production.sh all` has succeeded. It covers two steps of `GO_LIVE_RUNBOOK.md`: the Cognito client change (step 3) and the production restore test (step 4a). It needs `jq` and the AWS CLI only.

## Modes

| Command | What it does | Changes AWS? |
|---|---|---|
| `bash post-deploy.sh plan` | Checks the preconditions and prints the exact Cognito change as a table. Saves the current client and a rollback input file. | No |
| `OGEVIA_COGNITO_APPROVAL=<ref> bash post-deploy.sh cognito` | Same checks, then (after you type `UPDATE`) applies the change and verifies every field. | **Yes: one Cognito app client** |
| `OGEVIA_RESTORE_TEST_APPROVAL=<ref> bash post-deploy.sh restore-test` | Runs `prd-restore-test.sh` from the same folder (see `PRD_RESTORE_TEST.md`). `resume` continues an interrupted run. | **Yes: creates, then deletes, one temporary RDS instance** |

The two files must sit in the same folder. They are on the PR #73 branch, not on `main` at `a59a4b8`, so upload them on their own and verify their SHA-256.

## Cognito change (pool `us-west-2_849AYz5J7`, client `ogevia-web`)

| Setting | Target |
|---|---|
| Callback URL | `https://app.ogevia.com/auth/callback`. **The old callback URL is replaced**, so it stops working for sign-in. |
| Logout URL | `https://app.ogevia.com/` |
| Auth flows | `ALLOW_REFRESH_TOKEN_AUTH`, `ALLOW_USER_SRP_AUTH` (removes `ALLOW_USER_AUTH`) |
| Refresh token | 12 hours |

`update-user-pool-client` resets any field you do not pass, so the script sends back the whole saved client with only these fields changed.

It refuses to run (and changes nothing) when:
- the pool's MFA is not ON;
- `Ogevia-prd-ServiceVerificationApi` does not exist or is not complete;
- there is not exactly one client named `ogevia-web`, or its id is not `1i27abbina08fvg1i9u8vprgo9` (the id in the Netlify variable `VITE_COGNITO_CLIENT_ID`);
- the production API's JWT authorizer does not list that client;
- the client has a secret, or auth flows other than refresh, SRP and `ALLOW_USER_AUTH`;
- the approval reference is missing or you do not type `UPDATE`.

If the client already has the target values it says so and does nothing.

Afterwards it re-reads the client and compares every field with what it sent. A difference prints `FAIL` and the rollback command. It never rolls back by itself.

Files written to `~/ogevia-phase7/`: `cognito-before-<UTC>.json` (full client before), `cognito-rollback-input-<UTC>.json`, `cognito-update-input-<UTC>.json`, `cognito-after-<UTC>.json`, `cognito-change-<UTC>.txt` (the record), and a log. None contains a secret.

**Rollback:** `aws cognito-idp update-user-pool-client --cli-input-json file://$HOME/ogevia-phase7/cognito-rollback-input-<UTC>.json`

## What this does not cover
Netlify variables and the site switch, the first administrator's MFA sign-in, and the real-phone test stay manual.

## How it was checked
`bash -n` passes. Rehearsed against a simulated AWS: the plan; a full successful change; an already-correct client; refusals for MFA off, a missing stack, an authorizer that does not list the client, a duplicate or different client id, a client secret, extra auth flows, a missing approval reference and a wrong confirmation; AWS rejecting the update (client unchanged); and AWS altering a field after the update (reported as `FAIL` with the rollback command). **It has not run against real AWS**, and whether the real `update-user-pool-client` accepts the saved client unchanged is untested.
