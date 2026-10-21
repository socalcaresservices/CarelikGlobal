# Phase 0 checks: AWS inventory, user counts and agency-record counts (CloudShell, read-only)

Date: 2026-10-21. Status: **prepared, not run.** This session's AWS credentials are still rejected (`UnrecognizedClientException` on a read-only
Cognito call, 2026-10-21), so none of the results below exist yet. Nothing in AWS was changed.

Run in this order. **Stop at any step that says STOP and tell me.**

| Step | What | Reads | Needs a decision from you |
|---|---|---|---|
| 1 | Infrastructure inventory (already written) | AWS metadata | No: `CLOUDSHELL_READONLY_INVENTORY.md` |
| 2 | Cognito user counts | counts only | No |
| 3 | Database counts for `ogevia_prd` and `ogevia_sv_test` | counts, dates, agency slugs/names | **Yes: it reads the database master password into your shell (see 3.0)** |
| 4 | Overlap of sign-ins between the two databases and Cognito | counts only | No |

## Step 1: infrastructure inventory

Run the block in `docs/aws/CLOUDSHELL_READONLY_INVENTORY.md` unchanged. Return the output file.

## Step 2: Cognito counts (no emails, no names)

`list-users` normally returns emails, so the command below keeps only the status flags. Nothing is printed except counts.

```bash
export AWS_PAGER="" AWS_DEFAULT_REGION=us-west-2
POOL=us-west-2_849AYz5J7
aws cognito-idp describe-user-pool --user-pool-id $POOL --query "UserPool.{Estimated:EstimatedNumberOfUsers,MFA:MfaConfiguration}" --output json

echo "== users by status / enabled (count) =="
aws cognito-idp list-users --user-pool-id $POOL --attributes-to-get sub \
  --query "Users[].[UserStatus,Enabled]" --output text | sort | uniq -c
```

## Step 3: database counts (ON HOLD: do not run until the owner approves the access method in 3.0)

### 3.0 What this step does, and what it needs from you

The application login cannot read tables (by design), so counting requires the database **master** login. This is the same method the repository's own `deploy-production.sh` already uses (`open_tunnel`). It:

- reads the master secret from Secrets Manager **into a shell variable only** (never printed);
- opens an SSM port-forward to the private RDS instance through the temporary admin host (`ogevia-db-admin-temp`);
- runs **one read-only SQL file** (`BEGIN READ ONLY ... ROLLBACK`; a write is refused by PostgreSQL, tested locally).

If you prefer not to read the master secret, skip Step 3 and instead tell me the counts you can see in the application's Admin screens (agencies, people, clients, visits) and answer the "real or test" questions in section 5.

**STOP conditions:** the admin host is not running (do **not** start it; that is a change; tell me), the host lacks the application security group (the script below checks), or the session-manager plugin cannot be installed.

### 3.1 Prepare CloudShell (installs local client tools only; no AWS change)

```bash
sudo dnf install -y postgresql15 jq >/dev/null 2>&1 || sudo dnf install -y postgresql16 jq
curl -sSL "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/linux_64bit/session-manager-plugin.rpm" -o /tmp/smp.rpm \
  && sudo dnf install -y /tmp/smp.rpm >/dev/null
command -v psql session-manager-plugin
```

### 3.2 Save the read-only SQL (this is `docs/aws/inventory/read_only_counts.sql`)

```bash
cat > ~/read_only_counts.sql <<'SQL_END'
-- READ ONLY inventory counts for one Ogevia database (run once per database: ogevia_prd, ogevia_sv_test).
-- Emits counts, dates and agency slugs/names only. It selects NO client names, caregiver names, emails, Cognito subs, notes, or signatures.
-- Everything runs inside a READ ONLY transaction that is rolled back; it cannot change data.
--   psql -X -At -v ON_ERROR_STOP=1 -f read_only_counts.sql
\set ON_ERROR_STOP on
begin read only;
select 'database' k, current_database() v;
select 'migrations' k, count(*)::text || ' / max ' || coalesce(max(version), 'none') v from ogevia_meta.schema_migrations;

\echo '--- agencies (slug | status | created | seed-marker | name)'
select o.slug || ' | ' || o.status || ' | ' || o.created_at::date || ' | '
       || case when o.id::text like '7e570000-%' or o.id::text like '5c500000-%' then 'SEED-ID(synthetic)' else 'no-seed-marker' end
       || ' | ' || o.display_name
from ogevia.organizations o order by o.created_at;

\echo '--- sign-in identities'
select 'app_users total' k, count(*)::text v from ogevia.app_users;
select 'app_users linked to a Cognito sub' k, count(*)::text v from ogevia.app_users where cognito_sub is not null;
select 'app_users by status ' || status k, count(*)::text v from ogevia.app_users group by status order by 1;
select 'app_users created ' k, coalesce(min(created_at)::date::text, 'n/a') || ' .. ' || coalesce(max(created_at)::date::text, 'n/a') v from ogevia.app_users;
select 'users with an active membership in 2+ agencies' k, count(*)::text v
from (select user_id from ogevia.organization_memberships where status = 'active' group by user_id having count(*) > 1) x;

\echo '--- memberships by agency, role, status'
select o.slug || ' | ' || m.role || ' | ' || m.status || ' = ' || count(*)
from ogevia.organization_memberships m join ogevia.organizations o on o.id = m.organization_id
group by o.slug, m.role, m.status order by 1;

\echo '--- invitations'
select 'caregiver_invitations total / first sign-in recorded' k,
       count(*)::text || ' / ' || count(first_signed_in_at) v from ogevia.caregiver_invitations;

\echo '--- records by agency (live rows only; counts, never names)'
select o.slug || ' | caregivers=' || (select count(*) from ogevia.caregiver_records c where c.organization_id = o.id and c.deleted_at is null)
    || ' linked=' || (select count(*) from ogevia.caregiver_records c where c.organization_id = o.id and c.deleted_at is null and c.linked_user_id is not null)
    || ' | clients=' || (select count(*) from ogevia.clients c where c.organization_id = o.id and c.deleted_at is null)
    || ' (seed-id ' || (select count(*) from ogevia.clients c where c.organization_id = o.id and c.id::text like any (array['7e570000-%','5c500000-%'])) || ')'
    || ' | authorizations=' || (select count(*) from ogevia.client_authorizations a where a.organization_id = o.id)
    || ' | shifts=' || (select count(*) from ogevia.shifts s where s.organization_id = o.id)
    || ' | assignments=' || (select count(*) from ogevia.caregiver_assignments a where a.organization_id = o.id)
from ogevia.organizations o order by o.created_at;

\echo '--- visits by agency and status'
select o.slug || ' | ' || v.status || ' = ' || count(*) || ' (first ' || min(v.created_at)::date || ', last ' || max(v.created_at)::date || ')'
from ogevia.service_visits v join ogevia.organizations o on o.id = v.organization_id
group by o.slug, v.status order by 1;
select 'visits with signature/evidence rows' k, count(*)::text v from ogevia.visit_evidence;
select 'visit confirmations' k, count(*)::text v from ogevia.visit_confirmations;
select 'billing approvals (all / active)' k, count(*)::text || ' / ' || count(*) filter (where voided_at is null) v from ogevia.billing_approvals;
select 'visits in the last 7 days' k, count(*)::text v from ogevia.service_visits where created_at > now() - interval '7 days';

\echo '--- audit trail: earliest/latest and most common actions'
select 'audit_events' k, count(*)::text || ' (' || coalesce(min(occurred_at)::date::text, 'n/a') || ' .. ' || coalesce(max(occurred_at)::date::text, 'n/a') || ')' v from ogevia.audit_events;
select 'action ' || action k, count(*)::text v from ogevia.audit_events group by action order by count(*) desc, action limit 15;
rollback;
SQL_END
grep -ciE "insert|update|delete|drop|alter|create|grant|truncate" ~/read_only_counts.sql   # expect only matches inside comments/labels; the transaction is READ ONLY regardless
```

### 3.3 Open the tunnel, run the counts for both databases, close everything

```bash
set +x +H; export AWS_PAGER="" AWS_DEFAULT_REGION=us-west-2
IID=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=ogevia-db-admin-temp" "Name=instance-state-name,Values=running" \
      --query 'Reservations[0].Instances[0].InstanceId' --output text)
[[ "$IID" == i-* ]] || { echo "STOP: admin host is not running. Do not start it; tell Claude."; return 2>/dev/null || exit 2; }

# authoritative instance details (also settles which master secret belongs to this instance)
RDS_HOST=$(aws rds describe-db-instances --db-instance-identifier ogevia-prod-postgres --query 'DBInstances[0].Endpoint.Address' --output text)
MASTER_ARN=$(aws rds describe-db-instances --db-instance-identifier ogevia-prod-postgres --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)
echo "master secret (ARN only, not the value): $MASTER_ARN"
aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text

aws ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$RDS_HOST,portNumber=5432,localPortNumber=15432" >/dev/null &
TUNNEL=$!; sleep 8; kill -0 $TUNNEL 2>/dev/null || { echo "STOP: tunnel did not start (usually the admin host lacks the app security group)."; return 2>/dev/null || exit 2; }

MASTER=$(aws secretsmanager get-secret-value --secret-id "$MASTER_ARN" --query SecretString --output text)
export PGHOST=127.0.0.1 PGPORT=15432 PGSSLMODE=require PGUSER=$(jq -r .username <<<"$MASTER") PGPASSWORD=$(jq -r .password <<<"$MASTER")
unset MASTER

psql -X -At -d postgres -c "select datname from pg_database where datname like 'ogevia%' order by 1"

for DB in ogevia_prd ogevia_sv_test; do
  psql -X -At -v ON_ERROR_STOP=1 -d "$DB" -f ~/read_only_counts.sql > ~/counts_$DB.txt 2>&1 || echo "FAILED for $DB (see ~/counts_$DB.txt)"
  psql -X -At -d "$DB" -c "begin read only; select substr(encode(sha256(convert_to(cognito_sub,'UTF8')),'hex'),1,16) from ogevia.app_users where cognito_sub is not null; rollback;" \
    | grep -E '^[0-9a-f]{16}$' | sort -u > ~/h_$DB.txt
done

kill $TUNNEL 2>/dev/null; unset PGPASSWORD PGUSER PGHOST PGPORT PGSSLMODE
echo done; wc -l ~/counts_*.txt ~/h_*.txt
```

## Step 4: overlap counts (ON HOLD with Step 3; it uses locally computed one-way sign-in hashes that are never printed or sent; the owner may veto this step separately)

```bash
echo "prd subs:   $(wc -l < ~/h_ogevia_prd.txt)"
echo "pilot subs: $(wc -l < ~/h_ogevia_sv_test.txt)"
echo "in BOTH databases:            $(comm -12 ~/h_ogevia_prd.txt ~/h_ogevia_sv_test.txt | wc -l)"
rm -f ~/h_*.txt        # hashes are no longer needed
```

## 5. What to send back (and what not to)

Send: the Step 1 output file and the Step 2 counts. (After approval of Steps 3-4 only: the two count files and the three overlap numbers. Hash files are never sent.)
**Do not send** emails, names, sign-in ids or their hashes, tokens, passwords, secrets, or screenshots of client records. The count files contain none by construction; read them once before sending. They do contain agency names and slugs (business names).

### How I will interpret the results (and what counts cannot prove)

| Question | Evidence the count files give | What it cannot tell us |
|---|---|---|
| Does production have users? | `app_users total`, `linked to a Cognito sub`, memberships by role | Whether each is a real person |
| Does production have agency records? | agencies list, records by agency | Whether the agency or its clients are real |
| Real or test? | Agency seed marker (`SEED-ID(synthetic)` from the repository's fixed seed ids); agency names containing "synthetic"/"pilot"; creation dates vs the production bootstrap date; visits with signature evidence; audit actions (`organization.bootstrapped`, `owner_bootstrapped`) | **A count never proves real.** No seed marker and a normal-looking name is still only "not obviously synthetic". Real vs test is confirmed only by you naming the people/agencies, or by the absence of any data other than the bootstrap tenant and one owner |
| Is the shared pool a live exposure? | Overlap count (in both databases); Cognito users in neither database | Whether a pilot user has actually attempted a production sign-in (that needs Cognito/CloudTrail sign-in events) |
| What migration level is production at? | `migrations` line (expected 38, 46 or 52; documents disagree) | Which commit was deployed (compare the Lambda code hash from Step 1 with a local synth) |

### Decision rules I will apply

- **Production records are treated as potentially real until the owner confirms otherwise, even if there is only one agency and one owner.** A short-switch cutover is chosen only after the owner confirms in writing who the production people and agencies are.
- Production has any visit with a signature, more than the bootstrap owner, or agencies without the seed marker beyond the bootstrap tenant: treat as **possibly real** until you confirm each, then **parallel stack** per the Phase 2 design.
- Any overlap count above 0: the shared-pool exposure is live for those people; prioritize the cutover.

## 6. Safety summary

- AWS: only `describe`/`list`/`get` calls plus one `get-secret-value` (the database master secret, in Step 3 only, into a shell variable) and one SSM **port-forward session** (opens a session; changes no resource). Nothing is created, started, stopped or modified.
- Database: one read-only transaction per database, rolled back; only counts, dates and agency names are selected.
- The admin host is never started by these commands.
