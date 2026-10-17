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
4. **Open.** Writes a marker `~/.ogevia-ledger-window/OPEN` (atomically; a second run cannot open another window), adds the single rule (description `TEMP-ledger-check-<UTC stamp>`), and checks that the group minus that rule equals the original hash. Anything else changed: abort.
5. **Query (seconds).** Session Manager port-forward to RDS; reads the master secret into memory (never printed or saved); proves `current_database()` equals the expected name and the session is read-only; runs only the ledger selects in a read-only transaction.
6. **Close and verify, on every exit.** Removes the rule (retrying up to 4 times), re-describes the group, and requires the rule to be absent **and** the complete rule-set hash to equal the original. Prints `RESTORED (verified)`, or `NOT RESTORED` with the exact manual revoke command.
Cleanup is attached to normal exit, any `stop`, and INT/TERM/HUP. The 300 s figure is NOT a hard limit: see section 5A.

## 5. If the session dies or restoration fails
The marker survives. A new run refuses to start and tells you to run `bash ledger-check-temp-access.sh --restore-only`, which removes the rule idempotently and clears the marker **only after verification**. Only the run that opened the window, or `--restore-only`, ever removes the rule; a refused or concurrent run does not touch it. Manual fallback command is printed by the script.

## 5A. What the 300-second limit is, and what independently removes the rule (corrected)
**The script's 300 s limit is a soft, in-process check, not a hard limit.** `OGEVIA_WINDOW_MAX_SECONDS` is compared with the clock at two points only: once after the tunnel opens (before the secret is read) and once after the queries finish. It does not interrupt a step that hangs. The only bounded steps are the database connection (15 s) and each statement (20 s); the AWS CLI calls and the Session Manager tunnel have no timeout. The earlier wording "hard limit" in this document and in the script header overstated it. The script file is unchanged, so its hash is unchanged; the header comment still says "hard limit" and is inaccurate.

**Nothing independent of the CloudShell session removes the rule.** Every cleanup mechanism is inside, or on the disk of, the process that opened it: the EXIT/INT/TERM/HUP traps, the re-entrant `close_window`, the retries, and the marker file. If CloudShell is terminated completely, the process is SIGKILLed, the session is torn down, or the network drops at the wrong moment, no trap runs and **the rule stays until a person revokes it**. The marker file only prevents a second run from starting; it removes nothing. Security groups have no expiry for a rule, and this design creates no scheduled job, Lambda or alarm, because that would be a new AWS resource and was not proposed.

**What the exposure is while a rule is left in place (analysis, not tested):** the admin host (no inbound ports; reachable only through Session Manager) could open TCP 5432 to both databases on the RDS instance. Using it still needs the master credential and a Session Manager session. It is a standing broader path, not a harmless one, and it would show as drift on the `ogevia-prod-data-layer` stack.

**Separate-session recovery (read-only to identify; one write to remove). Run in a NEW CloudShell session, region us-west-2:**
```
# 1. Identify. Read-only. Expected ORIGINAL state: exactly ONE inbound rule on this group, source sg-064ffce3bcbe8eb3b.
aws ec2 describe-security-group-rules --region us-west-2 --filters Name=group-id,Values=sg-00530a1f4f7648e65 \
  --query 'SecurityGroupRules[?IsEgress==`false`].{rule:SecurityGroupRuleId,proto:IpProtocol,from:FromPort,to:ToPort,source:ReferencedGroupInfo.GroupId,cidr:CidrIpv4,desc:Description}' --output table

# 2. The temporary rule is the row where source = sg-00e01e2ca80442c1f, proto = tcp, from = to = 5432
#    (its description normally starts "TEMP-ledger-check-"; identify by source and port, not by description alone).
#    Copy its rule id (sgr-...). Do NOT touch the row whose source is sg-064ffce3bcbe8eb3b.

# 3. Remove exactly that rule by id (the only write).
aws ec2 revoke-security-group-ingress --region us-west-2 --group-id sg-00530a1f4f7648e65 --security-group-rule-ids sgr-REPLACE_WITH_THE_ID_FROM_STEP_2

# 4. Verify: re-run step 1. Required: one inbound rule, source sg-064ffce3bcbe8eb3b, nothing sourced from sg-00e01e2ca80442c1f.
```
The marker `~/.ogevia-ledger-window/OPEN` lives in the home directory of the CloudShell session that ran the script. If that home directory is still available, running `bash ~/ledger-check-temp-access.sh --restore-only` there also revokes and verifies against the recorded original hash; if it is not available, the four steps above are the procedure. The step-1 expectation comes from the repository records (section 2), not from a live read; the rule set is only hash-verified against the original when the script's recorded state survives. Whether the CloudShell home directory persists after a forced termination is not tested here. Outbound rules of the RDS group were not read in the repository evidence; if recovery runs without the recorded state, outbound rules cannot be compared with the original.

**Detecting a left-open rule:** CloudTrail records `AuthorizeSecurityGroupIngress` and `RevokeSecurityGroupIngress` on `sg-00530a1f4f7648e65`. An authorize without a later revoke means the window is still open. Step 1 above is the direct check, and it should be run after every window regardless of what the script printed.

**Options to add independence (NOT built, NOT proposed for approval unless you ask):** (a) wrap the tunnel and AWS calls in `timeout` so a hang ends in cleanup (improves the in-process limit; still dies with the session); (b) a second, separate CloudShell session opened beforehand that runs a delayed revoke (an independent process, but still manual and still only as reliable as that second session); (c) an EventBridge Scheduler one-shot that revokes the rule at a fixed time (independent of CloudShell, but a new AWS resource with its own IAM role and a write permission; needs your approval). Without (c) the honest position is: **removal after a total session loss depends on a person running the recovery above.**

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
# Reviewed script: commit 3432c10f9dc7edfa08f7e47ac462955f681d0d25 (branch claude/ogevia-test-deployment-verify-5xqjsa).
# Byte-identical copy on the integration branch at f690e42b61723b7c6b8295f696ba23c9b247643c. Fetch by the commit, not the branch name.
# Needs read access to the private repository from CloudShell; that access is not established here.
git init -q ~/ogevia-review && cd ~/ogevia-review
git fetch --depth 1 https://github.com/socalcaresservices/CarelikGlobal.git 3432c10f9dc7edfa08f7e47ac462955f681d0d25
git rev-parse FETCH_HEAD                       # must print 3432c10f9dc7edfa08f7e47ac462955f681d0d25
git show FETCH_HEAD:infra/aws/slice/ledger-check-temp-access.sh > ~/ledger-check-temp-access.sh
sha256sum ~/ledger-check-temp-access.sh        # must print 2cb5c982d1ad0041d7d96f951e4ee1696e17f7130040132b8e8329be41174b4e
less ~/ledger-check-temp-access.sh            # read it
bash ~/ledger-check-temp-access.sh test       # type OPEN-5432-WINDOW only after reading the printed original configuration
# only if a run was interrupted:  bash ~/ledger-check-temp-access.sh --restore-only
```

## 9A. Branch naming
- `claude/ogevia-test-deployment-verify-5xqjsa`: the session's designated branch (its name reflects the original TEST-verification task; it now also carries the redesign and these procedures). The script was committed here at `3432c10f9dc7edfa08f7e47ac462955f681d0d25`.
- `integration/compliance-attention-onto-scheduling-recruiting`: the unmerged, undeployed combination branch. It carries the same script file in commit `f690e42b61723b7c6b8295f696ba23c9b247643c` (a different commit; `3432c10` is not its ancestor). The file hashes are identical (`2cb5c982d1ad0041d7d96f951e4ee1696e17f7130040132b8e8329be41174b4e` on both, compared with sha256sum).
- Either source gives the same bytes. Review and fetch from `3432c10` so the command does not depend on a branch name. Neither branch is merged or deployed. A documentation-only commit may sit above these SHAs; it does not change the script.
