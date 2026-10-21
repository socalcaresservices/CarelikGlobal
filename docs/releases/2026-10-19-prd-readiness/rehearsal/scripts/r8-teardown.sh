#!/usr/bin/env bash
# R8 TEARDOWN of the rehearsal copy. RED when executing: it DELETES an RDS instance (a copy, without a final snapshot) and its security group, optionally the rehearsal snapshot.
#   bash r8-teardown.sh plan                    read-only: shows exactly what exists and what execute would delete
#   bash r8-teardown.sh execute [--also-snapshot]
# Only ever deletes resources whose identifier matches ogevia-prd-rehearsal-YYYYMMDD(-sg) / ogevia-prod-postgres-pre-rehearsal-YYYYMMDDHHMM AND that carry purpose=rehearsal-delete-after
# AND are recorded in the state file. It cannot target ogevia-prod-postgres or any production resource. Needs the owner's separate instruction naming the identifier.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
MODE="${1:-}"; ALSO="${2:-}"
[[ "$MODE" == plan || "$MODE" == execute ]] || { echo "usage: bash r8-teardown.sh plan|execute [--also-snapshot]" >&2; exit 2; }
[[ -z "$ALSO" || "$ALSO" == --also-snapshot ]] || { echo "usage: bash r8-teardown.sh plan|execute [--also-snapshot]" >&2; exit 2; }
need aws jq timeout
check_account
REH=$(state_get REH_ID); SG=$(state_get SG_ID); SNAP=$(state_get SNAP_ID)
valid_reh_id "${REH:-}" || stop "no valid rehearsal identifier in $STATE; nothing to delete"
D=$(A rds describe-db-instances --db-instance-identifier "$REH" --output json 2>/dev/null | jq -c '.DBInstances[0]') || D=""
if [[ -n "$D" && "$D" != null ]]; then
  [[ "$(jq -r '[.TagList[]? | select(.Key=="purpose") | .Value] | first // empty' <<<"$D")" == rehearsal-delete-after ]] || stop "$REH is not tagged purpose=rehearsal-delete-after: refusing"
  [[ "$(jq -r '[.TagList[]? | select(.Key=="source-snapshot") | .Value] | first // empty' <<<"$D")" == "$SNAP" ]] || stop "$REH was not restored from the recorded snapshot $SNAP: refusing"
  [[ "$(jq -r .DBInstanceIdentifier <<<"$D")" != "$PROD_RDS" ]] || stop "refusing: that is the production instance"
  say "instance to delete: $REH (status $(jq -r .DBInstanceStatus <<<"$D"))"
else say "instance $REH: not found (already deleted?)"; fi
if [[ -n "$SG" ]]; then
  [[ "$SG" =~ ^sg-[0-9a-f]+$ && "$SG" != "$PROD_RDS_SG" ]] || stop "the recorded security group '$SG' is not acceptable"
  G=$(A ec2 describe-security-groups --group-ids "$SG" --output json 2>/dev/null | jq -c '.SecurityGroups[0]') || G=""
  if [[ -n "$G" && "$G" != null ]]; then
    [[ "$(jq -r .GroupName <<<"$G")" == "$REH-sg" ]] || stop "$SG is named '$(jq -r .GroupName <<<"$G")', not $REH-sg: refusing"
    say "security group to delete: $SG ($REH-sg)"
  else say "security group $SG: not found"; fi
fi
if [[ "$ALSO" == --also-snapshot ]]; then
  [[ "$SNAP" =~ ^ogevia-prod-postgres-pre-rehearsal-[0-9]{12}$ ]] || stop "the recorded snapshot id is not a rehearsal snapshot: refusing"
  say "snapshot to delete: $SNAP"
else say "snapshot $SNAP is KEPT (add --also-snapshot to delete it)"; fi
[[ "$MODE" == plan ]] && { say "PLAN ONLY: nothing was changed."; exit 0; }
confirm "DELETE-$REH"
if [[ -n "$D" && "$D" != null ]]; then
  A rds delete-db-instance --db-instance-identifier "$REH" --skip-final-snapshot --delete-automated-backups --output json >/dev/null || stop "delete-db-instance failed"
  timeout --foreground -k 5 3600 aws rds wait db-instance-deleted --db-instance-identifier "$REH" || stop "the instance did not finish deleting"
fi
if [[ -n "${G:-}" && "$G" != null ]]; then
  for _ in 1 2 3 4 5 6; do A ec2 delete-security-group --group-id "$SG" >/dev/null 2>&1 && break; sleep "${OGEVIA_SG_RETRY_SLEEP:-20}"; done
  A ec2 describe-security-groups --group-ids "$SG" --output json >/dev/null 2>&1 && stop "the security group $SG still exists after retries (delete it later)"
fi
if [[ "$ALSO" == --also-snapshot ]]; then
  confirm "DELETE-SNAPSHOT-$SNAP"
  A rds delete-db-snapshot --db-snapshot-identifier "$SNAP" --output json >/dev/null || stop "delete-db-snapshot failed"
fi
say "TEARDOWN DONE: verify with r8-teardown.sh plan (it should report nothing found)."
