# Temporary database-access procedure for the TEST ledger check: FOR REVIEW. NOT APPLIED.

**Status.** Prepared only. Nothing in AWS has been changed by this document or by the script. The script has been rehearsed against a fake AWS CLI (21 tests, `infra/aws/test/ledger-check-temp-access.test.ts`); it has never run against AWS.
**Why this exists.** `ledger-check-readonly.sh test` stopped: the admin host's security group cannot reach RDS on 5432. Nothing changed.

## 1. Is there an existing read path that avoids a configuration change? (inspected first)
| Path | Result |
|---|---|
| `pilot-preflight-readonly.sh --probe-lambda` (`pilot_preflight_probe.py`) | Read-only, through the Lambda with the synthetic test identity, **but its ladder ends at generation 0051** and its own text says "it cannot read the exact ledger". The deployed Lambda has no code that touches 0053+ objects, so it cannot show whether they exist. TEST only. **Not sufficient.** |
| An API route that returns the ledger | None: `apps/sv-api/src` never references `schema_migrations`. |
| `owner-access-check.sh`, `pilot-lib.sh` "DB window" | Work, but **attach the application security group to the admin host** (a host change, restored on exit). It also gives the host the application group's other allowance (HTTPS to the Secrets Manager endpoint). Owner-approved for earlier releases, recorded in `docs/aws/TEST_SLICE_DEPLOYMENT_APPROVAL.md`. |
| RDS Data API / query editor | Not available for a standard RDS PostgreSQL instance (AWS documentation; not tested here). |
| A CloudShell VPC environment in the application group | Would avoid touching the host or the RDS group (it creates a new CloudShell network interface instead), but it needs subnet and route facts the repository does not hold (whether AWS API calls work from that subnet). Not prepared; UNVERIFIED. |
Conclusion: **no existing read-only path answers the 0053+ question.** A temporary network allowance is needed.

## 2. What the repository says is the original configuration (live values are recorded by the script before it changes anything)
| Item | Repository evidence | Source |
|---|---|---|
| RDS instance | `ogevia-prod-postgres` (holds BOTH `ogevia_sv_test` and `ogevia_prd`) | `lib/config.ts` |
| RDS security group | `sg-00530a1f4f7648e65`, inbound **tcp 5432 from the application group `sg-064ffce3bcbe8eb3b` only** | `docs/aws/SECURITY_DECISIONS.md`, `CURRENT_AWS_INVENTORY.md` |
| Admin host | `i-0ce8db2d7e5839dd5` (`ogevia-db-admin-temp`), groups exactly **`sg-00e01e2ca80442c1f`** (`ogevia-db-admin-sg`: inbound 443 from itself, outbound all) | `CURRENT_AWS_INVENTORY.md` |
These are records, not live checks. The script reads the live values, prints them, and **stops** if the RDS group, the admin host's groups or the group's membership differ from the above.

## 3. The change (the only one) and why it is the narrowest option
| | Option A: the repository's DB window | **Option B (proposed)** |
|---|---|---|
| Change | Attach `sg-064ffce3bcbe8eb3b` to the admin host | Add ONE inbound rule on the RDS group `sg-00530a1f4f7648e65`: **tcp 5432 from `sg-00e01e2ca80442c1f`** |
| Host modified | Yes | **No** |
| What the host gains | Everything the application group carries: RDS 5432 **and** the Secrets Manager endpoint's 443 | RDS 5432 only |
| Other resources affected | Any resource whose rules name the application group | Only the RDS group (which fronts the shared instance) |
| Proof of restoration | The host's group list | **Hash of every inbound and outbound rule of the RDS group, before and after** |
| Drift while open | None on the host | The RDS group, which is managed by the `ogevia-prod-data-layer` stack, differs from its template for seconds (CloudFormation drift detection would show it) |
The rule applies only to members of `sg-00e01e2ca80442c1f`; the script refuses to proceed unless exactly one network interface uses that group and it is the admin host's. The RDS group is shared by TEST and the production candidate, so the rule reaches the instance holding both databases. The script says so, and proves which database it is connected to before querying.

## 4. What the script does, in order (`infra/aws/slice/ledger-check-temp-access.sh test|prod`)
1. **Read-only preconditions.** Account 300094796789; the named environment's API stack exists; its Lambda's `DB_NAME` matches the requested environment (`OGEVIA_ENV` is `prd` for production only); RDS available and private; RDS group is exactly the expected one; admin host groups are exactly the expected one; the admin group is used by exactly one interface; the rule does not already exist; no earlier window is marked open. Any failure: **stop, nothing changed.**
2. **Record the original.** Prints the RDS group's inbound rules and a SHA-256 of the canonical rule set (all inbound and outbound rules, order-independent); saves the full JSON (mode 600).
3. **Show the exact change and wait** for the typed phrase `OPEN-5432-WINDOW`. Anything else: nothing changed.
4. **Open.** Writes a marker `~/.ogevia-ledger-window/OPEN` (atomically; a second run cannot open another window), adds the single rule (description `TEMP ledger check <UTC>`), and checks that the group minus that rule equals the original hash. Anything else changed: abort.
5. **Query (seconds).** Session Manager port-forward to RDS; reads the master secret into memory (never printed or saved); proves `current_database()` equals the expected name and the session is read-only; runs only the ledger selects in a read-only transaction.
6. **Close and verify, on every exit.** Removes the rule (retrying up to 4 times), re-describes the group, and requires the rule to be absent **and** the complete rule-set hash to equal the original. Prints `RESTORED (verified)`, or `NOT RESTORED` with the exact manual revoke command.
Cleanup is attached to normal exit, any `stop`, and INT/TERM/HUP. A hard limit (default 300 s) ends the run into cleanup.

## 5. If the session dies or restoration fails
The marker survives. A new run refuses to start and tells you to run `bash ledger-check-temp-access.sh --restore-only`, which removes the rule idempotently and clears the marker **only after verification**. Only the run that opened the window, or `--restore-only`, ever removes the rule; a refused or concurrent run does not touch it. Manual fallback command is printed by the script.

## 6. Rehearsal evidence (fake AWS, not real AWS)
Success restores and verifies the identical rule set; a ledger with 0053+ rows is reported and still restored; a missing database is reported and restored; the wrong database stops and restores; a database failure after opening restores; an authorize failure leaves the group unchanged; SIGTERM mid-query restores; a revoke failing twice is retried; a revoke that always fails exits 3 with `NOT RESTORED`, leaves the marker, blocks the next run without touching the rule, and `--restore-only` then restores; an unrelated rule change during the window is detected by the hash; wrong environment, different admin-host groups, a shared interface, a different RDS group and a declined phrase all change nothing; the queries are read-only; the credential never appears in output or files; the script contains no host, instance, stack, Lambda or secret write and no CIDR rule.

## 7. NOT established (do not treat as verified)
- Real AWS behaviour: that `authorize`/`revoke` with this shorthand and description succeeds with the operator's permissions; that the Session Manager path works once the rule exists; that the live RDS group has no rules beyond those recorded (the script prints them and the hash).
- Whether the production-candidate database exists (the script reports it).
- That CloudFormation drift on the RDS group for a few seconds is acceptable to the owner (a stack update during the window would conflict; none is expected).
- That reading the RDS master secret, which also reaches the production database, is approved for this purpose.

## 8. Approval needed (one decision for each)
1. Approve Option B (one temporary inbound rule on the RDS group) instead of the repository's DB window (Option A)? Recommended: B.
2. Approve the master-secret read and the Session Manager session for this check?
3. Run TEST first, then production in a separate window, as before?
4. Operator and time window (no deployment or stack update should run during it).

## 9. Exact commands for the operator after approval (CloudShell, us-west-2)
```
git fetch origin claude/ogevia-test-deployment-verify-5xqjsa
git show FETCH_HEAD:infra/aws/slice/ledger-check-temp-access.sh > ~/ledger-check-temp-access.sh
sha256sum ~/ledger-check-temp-access.sh        # must equal the hash given with the approval request
less ~/ledger-check-temp-access.sh            # read it
bash ~/ledger-check-temp-access.sh test       # type OPEN-5432-WINDOW only after reading the printed original configuration
# only if a run was interrupted:  bash ~/ledger-check-temp-access.sh --restore-only
```
