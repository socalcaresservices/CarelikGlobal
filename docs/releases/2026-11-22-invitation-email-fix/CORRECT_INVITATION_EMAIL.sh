#!/usr/bin/env bash
# ADMIN PROCEDURE (reusable): correct ONE caregiver's invitation email before their first sign-in. Runs inside an already-open database session (PGHOST/PGUSER/... set by the TEST or PRD wrapper) and with AWS access.
#   TARGET=test|production POOL=<user pool id> CAREGIVER_CODE=<code> NEW_EMAIL=<corrected address> REASON=<why> [ORG_SLUG=<slug>] bash CORRECT_INVITATION_EMAIL.sh
# Steps (read-only checks first, then one typed confirmation, then): 1 sign-in account email changed (Cognito, email marked verified) -> 2 ONE database transaction (invitation email, contact email, audit)
#   -> if step 2 fails, step 1 is reversed -> 3 a fresh invitation is sent to the corrected address (new temporary password, valid 7 days; the old one stops working).
# Never prints a full email address (masked) and never reads or prints a password. Changes nothing else.
set -euo pipefail
set +x +H
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" PYTHONDONTWRITEBYTECODE=1
stop() { echo "STOP: $*" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL="$HERE/CORRECT_INVITATION_EMAIL.sql"; [[ -f "$SQL" ]] || stop "CORRECT_INVITATION_EMAIL.sql must sit beside this script"
: "${TARGET:?set TARGET=test or production}"; : "${POOL:?set POOL}"; : "${CAREGIVER_CODE:?set CAREGIVER_CODE}"; : "${NEW_EMAIL:?set NEW_EMAIL}"; : "${REASON:?set REASON}"
case "$TARGET" in test) WANT_DB=ogevia_sv_test;; production) WANT_DB=ogevia_prd;; *) stop "TARGET must be test or production";; esac
[[ "$CAREGIVER_CODE" =~ ^[A-Za-z0-9-]{3,40}$ ]] || stop "the caregiver code looks wrong"
NEW_EMAIL="$(printf '%s' "$NEW_EMAIL" | tr -d '[:space:]' | tr 'A-Z' 'a-z')"
[[ "$NEW_EMAIL" =~ ^[a-z0-9.!#\$%\&\'*+/=?^_\`{|}~-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ && ${#NEW_EMAIL} -le 254 ]] || stop "the new email address is not valid"
[[ ${#REASON} -ge 5 && ${#REASON} -le 500 ]] || stop "the reason must be 5 to 500 characters"
mask() { local e="$1" l; if [[ "$e" == *@* ]]; then l="${e%%@*}"; printf '%s***@%s' "${l:0:2}" "${e#*@}"; else printf '(none)'; fi; }
A() { timeout --foreground -k 5 "${OGEVIA_AWS_TIMEOUT:-60}" aws --cli-connect-timeout 5 --cli-read-timeout 30 "$@"; }
confirm() { local got; echo; echo "$2"; if [[ "${OGEVIA_NO_CONFIRM:-}" == 1 ]]; then return 0; fi
  printf 'Type exactly  %s  to continue: ' "$1" > /dev/tty; read -r got < /dev/tty; [[ "$got" == "$1" ]] || stop "confirmation not given"; }
psqlq() { psql -X -qAt -F '|' --no-password -v ON_ERROR_STOP=1 "$@"; }
CUR_DB="$(psqlq -c 'select current_database()')"
# OGEVIA_LOCAL_REHEARSAL=1 allows a local disposable database named ogevia_test_<12 hex> with TARGET=test only (the automated test); it never widens a real target.
if [[ "${OGEVIA_LOCAL_REHEARSAL:-}" == 1 && "$TARGET" == test && "$CUR_DB" =~ ^ogevia_test_[0-9a-f]{12}$ && "${PGHOST:-localhost}" =~ ^(localhost|127\.0\.0\.1|)$ ]]; then WANT_DB="$CUR_DB"; fi
[[ "$CUR_DB" == "$WANT_DB" ]] || stop "connected to the wrong database (expected $WANT_DB for TARGET=$TARGET)"
echo "TARGET: $TARGET  database $WANT_DB  user pool $POOL"

echo "=== 1. read-only checks ==="
ROW="$(psqlq -v "code=$CAREGIVER_CODE" -v "slug=${ORG_SLUG:-}" -f - <<'SQL'
select count(*) over (), i.email, i.existing_account, coalesce(i.first_signed_in_at::text, ''), coalesce(u.cognito_sub, ''), (r.linked_user_id = i.user_id), i.send_count, coalesce(i.last_sent_at::text, '')
  from ogevia.caregiver_records r join ogevia.organizations o on o.id = r.organization_id
  join ogevia.caregiver_invitations i on i.organization_id = r.organization_id and i.caregiver_record_id = r.id
  join ogevia.app_users u on u.id = i.user_id
 where r.caregiver_code = :'code' and r.deleted_at is null and (:'slug' = '' or o.slug = :'slug');
SQL
)"
[[ -n "$ROW" && "$(wc -l <<<"$ROW")" == 1 ]] || stop "expected exactly one invited caregiver with that code (none found, or several agencies: pass ORG_SLUG)"
IFS='|' read -r N OLD_EMAIL EXISTING SIGNED SUB LINKED SENDS LASTSENT <<<"$ROW"
OLD_EMAIL="$(tr 'A-Z' 'a-z' <<<"$OLD_EMAIL")"
echo "caregiver $CAREGIVER_CODE: invited address $(mask "$OLD_EMAIL"), invitations sent $SENDS (last $LASTSENT)"
[[ "$EXISTING" == f ]] || stop "this caregiver already had a sign-in account; this procedure is only for accounts created by the invitation"
[[ -z "$SIGNED" ]] || stop "this caregiver has already signed in ($SIGNED): they use Forgot password"
[[ "$LINKED" == t && "$SUB" =~ ^[0-9a-f-]{36}$ ]] || stop "the invitation is not linked to this caregiver's sign-in account"
[[ "$OLD_EMAIL" != "$NEW_EMAIL" ]] || stop "the new address is the same as the invited one"
U="$(A cognito-idp admin-get-user --user-pool-id "$POOL" --username "$OLD_EMAIL" --output json)" || stop "no sign-in account found for the invited address"
[[ "$(jq -r .UserStatus <<<"$U")" == FORCE_CHANGE_PASSWORD && "$(jq -r .Enabled <<<"$U")" == true ]] || stop "the account is not waiting for its first password (status $(jq -r .UserStatus <<<"$U"), enabled $(jq -r .Enabled <<<"$U")): this procedure does not apply"
[[ "$(jq -r '[.UserAttributes[] | select(.Name=="sub")][0].Value' <<<"$U")" == "$SUB" ]] || stop "the sign-in account is not the one Ogevia has linked to this caregiver"
TAKEN="$(A cognito-idp list-users --user-pool-id "$POOL" --filter "email = \"$NEW_EMAIL\"" --query 'length(Users)' --output text)"
[[ "$TAKEN" == 0 ]] || stop "another sign-in account already uses the corrected address ($TAKEN found): nothing changed"
echo "PASS: account waits for its first password, is linked to this caregiver, and the corrected address $(mask "$NEW_EMAIL") is free"

confirm CORRECT-INVITATION-EMAIL "ABOUT TO CHANGE ($TARGET): caregiver $CAREGIVER_CODE. The invited address $(mask "$OLD_EMAIL") becomes $(mask "$NEW_EMAIL") on the sign-in account AND in Ogevia (invitation and contact email, with an audit entry: '$REASON'), then a fresh invitation with a new temporary password is sent to the corrected address."

echo "=== 2. change the sign-in account ==="
A cognito-idp admin-update-user-attributes --user-pool-id "$POOL" --username "$OLD_EMAIL" --user-attributes "Name=email,Value=$NEW_EMAIL" "Name=email_verified,Value=true" >/dev/null || stop "the sign-in account could not be changed; nothing was changed"
echo "sign-in account email changed to $(mask "$NEW_EMAIL")"
echo "=== 3. change Ogevia (one transaction) ==="
if ! psql -X -q --no-password -v ON_ERROR_STOP=1 -v "org_slug=${ORG_SLUG:-}" -v "caregiver_code=$CAREGIVER_CODE" -v "old_email=$OLD_EMAIL" -v "new_email=$NEW_EMAIL" -v "cognito_sub=$SUB" -v "reason=$REASON" -f "$SQL"; then
  echo "The database step failed; its transaction rolled back. Reversing the sign-in account change..." >&2
  if A cognito-idp admin-update-user-attributes --user-pool-id "$POOL" --username "$NEW_EMAIL" --user-attributes "Name=email,Value=$OLD_EMAIL" "Name=email_verified,Value=true" >/dev/null; then echo "REVERSED: the sign-in account is back to $(mask "$OLD_EMAIL"). Nothing is changed." >&2
  else echo "REVERSAL FAILED: the sign-in account now has $(mask "$NEW_EMAIL") but Ogevia still has $(mask "$OLD_EMAIL"). Send me this output before doing anything else." >&2; fi
  exit 1
fi
echo "=== 4. send the fresh invitation to the corrected address ==="
if ! A cognito-idp admin-create-user --user-pool-id "$POOL" --username "$NEW_EMAIL" --message-action RESEND --desired-delivery-mediums EMAIL >/dev/null; then
  echo "The account and Ogevia are corrected, but the invitation email could not be sent now. Press 'Resend sign-in link' for this caregiver in Care team: it now goes to the corrected address." >&2; exit 1
fi
echo "invitation sent to $(mask "$NEW_EMAIL")"
echo "=== 5. read back ==="
U2="$(A cognito-idp admin-get-user --user-pool-id "$POOL" --username "$NEW_EMAIL" --output json)"
echo "sign-in account: $(mask "$(jq -r '[.UserAttributes[] | select(.Name=="email")][0].Value' <<<"$U2")") | status $(jq -r .UserStatus <<<"$U2") | email verified $(jq -r '[.UserAttributes[] | select(.Name=="email_verified")][0].Value' <<<"$U2") | same account: $([[ "$(jq -r '[.UserAttributes[] | select(.Name=="sub")][0].Value' <<<"$U2")" == "$SUB" ]] && echo yes || echo NO)"
psqlq -v "code=$CAREGIVER_CODE" -v "slug=${ORG_SLUG:-}" -f - <<'SQL'
select 'Ogevia invitation email ' || left(split_part(i.email, '@', 1), 2) || '***@' || split_part(i.email, '@', 2) || ' | invitations sent ' || i.send_count
       || ' | contact email ' || coalesce(left(split_part(c.contact_email, '@', 1), 2) || '***@' || split_part(c.contact_email, '@', 2), '(none)')
  from ogevia.caregiver_records r join ogevia.organizations o on o.id = r.organization_id join ogevia.caregiver_invitations i on i.organization_id = r.organization_id and i.caregiver_record_id = r.id
  left join ogevia.caregiver_contacts c on c.caregiver_record_id = r.id where r.caregiver_code = :'code' and (:'slug' = '' or o.slug = :'slug');
SQL
echo "DONE: tell the caregiver to check inbox and spam for the new invitation, and to use only the newest email."
