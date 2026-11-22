#!/usr/bin/env bash
# READ-ONLY lookup of invited caregivers (reusable). Runs inside an already-open database session (set by the TEST or PRD wrapper) with AWS read access. Changes nothing.
#   TARGET=test|production POOL=<user pool id> SEARCH=<part of a name, or the caregiver code> [ORG_SLUG=<slug>] bash LOOKUP_INVITATION.sh
# Prints, for each invited caregiver that matches: code, name, invited address (masked), invitations sent, whether they have signed in, and the sign-in account status (PENDING = waiting for its first password).
# Never prints a full email address or any password.
set -euo pipefail
set +x +H
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" PYTHONDONTWRITEBYTECODE=1
stop() { echo "STOP: $*" >&2; exit 2; }
: "${TARGET:?set TARGET=test or production}"; : "${POOL:?set POOL}"; : "${SEARCH:?set SEARCH}"
case "$TARGET" in test) WANT_DB=ogevia_sv_test;; production) WANT_DB=ogevia_prd;; *) stop "TARGET must be test or production";; esac
RE="^[A-Za-z0-9 .'-]{2,60}\$"; [[ "$SEARCH" =~ $RE ]] || stop "SEARCH must be 2 to 60 letters, digits, spaces, dots, apostrophes or hyphens"
mask() { local e="$1" l; if [[ "$e" == *@* ]]; then l="${e%%@*}"; printf '%s***@%s' "${l:0:2}" "${e#*@}"; else printf '(none)'; fi; }
A() { timeout --foreground -k 5 "${OGEVIA_AWS_TIMEOUT:-60}" aws --cli-connect-timeout 5 --cli-read-timeout 30 "$@"; }
psqlq() { psql -X -qAt -F '|' --no-password -v ON_ERROR_STOP=1 "$@"; }
CUR_DB="$(psqlq -c 'select current_database()')"
if [[ "${OGEVIA_LOCAL_REHEARSAL:-}" == 1 && "$TARGET" == test && "$CUR_DB" =~ ^ogevia_test_[0-9a-f]{12}$ && "${PGHOST:-localhost}" =~ ^(localhost|127\.0\.0\.1|)$ ]]; then WANT_DB="$CUR_DB"; fi   # the automated test only; it never widens a real target
[[ "$CUR_DB" == "$WANT_DB" ]] || stop "connected to the wrong database (expected $WANT_DB for TARGET=$TARGET)"
echo "TARGET: $TARGET  database $WANT_DB  (read-only)"
ROWS="$(psqlq -v "q=$SEARCH" -v "slug=${ORG_SLUG:-}" -f - <<'SQL'
select r.caregiver_code, r.first_name || ' ' || r.last_name, i.email, i.send_count, coalesce(i.first_signed_in_at::text, ''), i.existing_account
  from ogevia.caregiver_records r join ogevia.organizations o on o.id = r.organization_id
  join ogevia.caregiver_invitations i on i.organization_id = r.organization_id and i.caregiver_record_id = r.id
 where r.deleted_at is null and (:'slug' = '' or o.slug = :'slug')
   and (r.caregiver_code ilike '%' || :'q' || '%' or (r.first_name || ' ' || r.last_name) ilike '%' || :'q' || '%')
 order by r.caregiver_code limit 10;
SQL
)"
[[ -n "$ROWS" ]] || { echo "no invited caregiver matches '$SEARCH'"; exit 0; }
while IFS='|' read -r CODE NAME EMAIL SENDS SIGNED EXISTING; do
  EMAIL="$(tr 'A-Z' 'a-z' <<<"$EMAIL")"; STATUS="(not found)"
  if U="$(A cognito-idp admin-get-user --user-pool-id "$POOL" --username "$EMAIL" --output json 2>/dev/null)"; then STATUS="$(jq -r .UserStatus <<<"$U")"; fi
  PENDING=no; [[ -z "$SIGNED" && "$EXISTING" == f && "$STATUS" == FORCE_CHANGE_PASSWORD ]] && PENDING=YES
  echo "CG_CODE=$CODE | $NAME | invited address $(mask "$EMAIL") | invitations sent $SENDS | signed in: $([[ -n "$SIGNED" ]] && echo yes || echo no) | sign-in account: $STATUS | still pending (correctable): $PENDING"
done <<<"$ROWS"
echo "Read-only: nothing was changed."
