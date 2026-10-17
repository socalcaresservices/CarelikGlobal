# Migration-ledger check: exact read-only CloudShell instructions

**Purpose.** Establish whether any database has applied a migration numbered 0053 or higher, before anyone edits the unreleased migration files in place. Run once for TEST and once, separately, for PRODUCTION. Nothing here merges or deploys anything.

**Not yet run.** This document and the script were written without AWS access. They were verified only by `bash -n`, a static test (`infra/aws/test/ledger-check-readonly.test.ts`) and a rehearsal of the SQL against the local harness database (it reads, and a write attempt is refused in the read-only session).

## What exists in the repository (inspected)
| Fact | Source |
|---|---|
| TEST/pilot: stacks `Ogevia-prod-*`, database `ogevia_sv_test`, synthetic data, web `d2xumch5w0izfg.cloudfront.net` | `infra/aws/slice/pilot-lib.sh`, `docs/aws/URL_REGISTRY_AND_LAUNCH_CHECKLIST.md` |
| PRODUCTION candidate: stacks `Ogevia-prd-*`, database `ogevia_prd`, `OGEVIA_ENV=prd`, web `d3l4psdkokkvnb.cloudfront.net` | `infra/aws/lib/config.ts`, `scripts/print-prd-config.ts`, same registry |
| **Both databases live on ONE RDS instance, `ogevia-prod-postgres`, with one master credential.** The word "prod" in `Ogevia-prod-*` and in the instance name means the pilot slice, not production data. | `lib/config.ts` (`databases.prod`), `pilot-lib.sh` |
| Account 300094796789, region us-west-2; the database is private and reached through the admin host `ogevia-db-admin-temp` and an SSM port-forward | `pilot-lib.sh`, `owner-access-check.sh` |
| Existing database reads (`owner-access-check.sh`, `pilot-lib.sh` "DB window") **temporarily attach the app security group to the admin host** (an AWS change, restored on exit) and read the RDS master secret | same files |
| The registry records production `ogevia_prd` migrations as OPEN (unverified); the last recorded TEST ledger is `52|0052` (owner-reported 2026-10-16) | registry item 6; `docs/releases/2026-10-16-test-web-release/README.md` |

## What the new script does and does not do
`infra/aws/slice/ledger-check-readonly.sh test|prod` (one environment per run).
- **No AWS or database setting is changed.** It never attaches a security group. Every `aws` call is describe-, list- or get-; the database session is read-only and the query is wrapped in a read-only transaction that is rolled back.
- **Two audit-only side effects:** it reads the RDS master credential (`secretsmanager get-secret-value`) into shell memory, never printing or saving it, and it opens a Session Manager port-forward (`ssm start-session`). CloudTrail and Session Manager history record both. Say if either needs separate approval.
- **It stops, rather than changes anything,** if the admin host cannot already reach the database. The repository's own method for that case changes a security group, which you excluded.
- **It proves the environment before querying:** the named API stack must exist; its Lambda's `DB_NAME` must equal the expected database (`ogevia_sv_test` for `test`, `ogevia_prd` for `prod`) and `OGEVIA_ENV` must be `prd` for production and not `prd` for TEST; the database must exist on the instance; and the session's `current_database()` must equal the expected name and be read-only, or it stops.

## Steps (AWS CloudShell, region us-west-2, the same administrator sign-in used for `pilot-preflight-readonly.sh`)
1. Fetch the script without changing your checkout. In your existing CloudShell checkout of the repository:
   ```
   git fetch origin claude/ogevia-test-deployment-verify-5xqjsa
   git show FETCH_HEAD:infra/aws/slice/ledger-check-readonly.sh > ~/ledger-check-readonly.sh
   sha256sum ~/ledger-check-readonly.sh
   ```
   Compare the printed hash with the one in the chat reply, then read the script (about 100 lines) before running it.
2. TEST: `bash ~/ledger-check-readonly.sh test`
3. PRODUCTION, as a separate run after reading the TEST result: `bash ~/ledger-check-readonly.sh prod`
4. Send back the two `RESULT.txt` files (path printed at the end; they contain no credentials) or the terminal output.

## Reading the result
| Output | Meaning |
|---|---|
| `Environment identified: ...` then `connected: ogevia_sv_test` (or `ogevia_prd`) | The right environment and database. Do not trust a result without both lines. |
| `RESULT ... NO ROW has version >= 0053` | That environment has applied none of the unreleased migrations. In-place editing is safe for it. |
| `RESULT ... migrations numbered 0053 or higher ARE APPLIED` with rows | STOP. Do not edit migration files in place; send the output. |
| `database ogevia_prd DOES NOT EXIST` | Production has applied nothing (the Lambda being configured for it does not prove the database was created). |
| `STOPPED: ... security-group change` | The admin host cannot already reach the database. Nothing was changed. Decide whether to approve the repository's "DB window" for this one read. |
| any other `STOPPED:` | The message names the missing item. |

## Information I could not establish (do not guess)
1. Whether the admin host can already reach the database without a security-group change (depends on live AWS state; the script checks it).
2. Whether the `Ogevia-prd-*` stacks and the `ogevia_prd` database exist today (owner-provided 2026-10-10 output says the stacks were deployed; the database is recorded as unverified).
3. Whether `psql` and the Session Manager plugin are installed in your CloudShell (the script checks and tells you; it installs nothing).
4. Whether reading the RDS master secret for this check needs your explicit approval beyond this message.
5. The path of your CloudShell checkout of the repository.

## Update
The read-only script stops on TEST because the admin host cannot reach RDS. The reviewed temporary-access alternative is in `TEMP_DB_ACCESS_PROCEDURE.md` (not applied).
