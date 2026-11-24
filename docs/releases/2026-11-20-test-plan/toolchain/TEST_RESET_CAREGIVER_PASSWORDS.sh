#!/usr/bin/env bash
# TEST ONLY: set a NEW sign-in password for every active CAREGIVER of the TEST agency (database ogevia_sv_test), so people can sign in to https://demo.ogevia.com again.
#   dry run (default, changes nothing):   bash TEST_DB_SESSION.sh bash TEST_RESET_CAREGIVER_PASSWORDS.sh
#   apply (typed confirmation):           bash TEST_DB_SESSION.sh bash TEST_RESET_CAREGIVER_PASSWORDS.sh apply
# Who is reset: ONLY accounts that are active CAREGIVERS in the TEST database and nothing else (an account that is also an owner, manager or scheduler is skipped). The list comes from the TEST database,
# not from Cognito, because the legacy sign-in pool is shared and may hold people who are not in this test agency. Nobody outside that list is touched.
# What it does per person: AdminSetUserPassword (a new random password, permanent) and a global sign-out of their existing sessions. No email or text is sent (test accounts often have addresses that cannot receive mail).
# Where the passwords go: one file in your home folder, readable only by you (chmod 600), one line per caregiver code. They are NEVER printed or logged. Give them out yourself and delete the file afterwards.
# Refuses to run unless: the AWS account is 300094796789 in us-west-2; the TEST site's own config.json names exactly the TEST sign-in pool below; the database is ogevia_sv_test.
set -euo pipefail
set +x +H
umask 077
stop() { echo "STOP: $*" >&2; exit 2; }
MODE="${1:-dry-run}"; case "$MODE" in dry-run|apply) ;; *) stop "usage: (nothing) | apply";; esac
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
TEST_POOL="${OGEVIA_TEST_POOL_ID:-us-west-2_849AYz5J7}"
SITE="${OGEVIA_TEST_SITE:-https://d2xumch5w0izfg.cloudfront.net}"
A() { timeout --foreground -k 5 60 aws --cli-connect-timeout 5 --cli-read-timeout 30 "$@"; }
[[ "$(A sts get-caller-identity --query Account --output text)" == 300094796789 ]] || stop "wrong AWS account (expected 300094796789 in us-west-2)"
[[ "${PGDATABASE:-}" == ogevia_sv_test ]] || stop "run this through TEST_DB_SESSION.sh (PGDATABASE must be ogevia_sv_test)"
SITE_POOL="$(curl -fsS --max-time 30 "$SITE/config.json" | jq -er '.VITE_COGNITO_USER_POOL_ID')" || stop "cannot read $SITE/config.json"
[[ "$SITE_POOL" == "$TEST_POOL" ]] || stop "the TEST site uses pool '$SITE_POOL', not '$TEST_POOL'. Nothing was changed."
# active caregivers only (a person with ANY other active role in the agency is not listed)
ROWS="$(psql -X -At -F '|' -c "select u.cognito_sub, coalesce(cr.caregiver_code, '-') from ogevia.app_users u join ogevia.organization_memberships m on m.user_id = u.id and m.status = 'active' and m.role = 'caregiver' left join ogevia.caregiver_records cr on cr.linked_user_id = u.id and cr.organization_id = m.organization_id and cr.deleted_at is null where u.status = 'active' and u.cognito_sub is not null and not exists (select 1 from ogevia.organization_memberships o where o.user_id = u.id and o.status = 'active' and o.role <> 'caregiver') order by 2")" || stop "cannot read the caregiver list from the TEST database"
[[ -n "$ROWS" ]] || stop "no active caregivers with a sign-in were found"
echo "TEST pool $TEST_POOL (matches the site's config). Caregivers in the TEST database with a sign-in: $(wc -l <<<"$ROWS")"
declare -a SUBS CODES USERS
while IFS='|' read -r sub code; do
  [[ "$sub" =~ ^[0-9a-f-]{36}$ ]] || stop "unexpected sign-in id in the list"
  uname="$(A cognito-idp list-users --user-pool-id "$TEST_POOL" --filter "sub = \"$sub\"" --query 'Users[0].Username' --output text 2>/dev/null || echo None)"
  if [[ -z "$uname" || "$uname" == None ]]; then echo "  $code: no sign-in account in the pool (skipped)"; continue; fi
  SUBS+=("$sub"); CODES+=("$code"); USERS+=("$uname"); echo "  $code: will be reset"
done <<<"$ROWS"
[[ "${#USERS[@]}" -gt 0 ]] || stop "no matching sign-in accounts were found in the pool"
if [[ "$MODE" == dry-run ]]; then echo; echo "DRY RUN: nothing was changed. ${#USERS[@]} caregiver account(s) would be reset. To apply, add the word apply."; exit 0; fi
if [[ "${OGEVIA_NO_CONFIRM:-}" != 1 ]]; then
  echo; echo "ABOUT TO CHANGE TEST SIGN-IN ONLY: set a new password for ${#USERS[@]} caregiver account(s) and sign them out everywhere. No email or text is sent."
  printf 'Type exactly  RESET-TEST-CAREGIVER-PASSWORDS  to continue: ' > /dev/tty; read -r got < /dev/tty; [[ "$got" == RESET-TEST-CAREGIVER-PASSWORDS ]] || stop "confirmation not given"
fi
OUT="${OGEVIA_PASSWORD_FILE:-$HOME/test-caregiver-passwords-$(date -u +%Y%m%dT%H%M%SZ).csv}"
: > "$OUT"; chmod 600 "$OUT"; echo "caregiver_code,password" > "$OUT"
ok=0; bad=0
for i in "${!USERS[@]}"; do
  pw="$(python3 -c 'import secrets,string; a=string.ascii_lowercase; b=string.ascii_uppercase; d=string.digits; s="!#%^*-_=+"; r=[secrets.choice(a),secrets.choice(b),secrets.choice(d),secrets.choice(s)]+[secrets.choice(a+b+d+s) for _ in range(20)]; secrets.SystemRandom().shuffle(r); print("".join(r))')"
  if A cognito-idp admin-set-user-password --user-pool-id "$TEST_POOL" --username "${USERS[$i]}" --password "$pw" --permanent >/dev/null 2>&1; then
    A cognito-idp admin-user-global-sign-out --user-pool-id "$TEST_POOL" --username "${USERS[$i]}" >/dev/null 2>&1 || echo "  ${CODES[$i]}: password set, but the sessions could not be ended (harmless)"
    printf '%s,%s\n' "${CODES[$i]}" "$pw" >> "$OUT"; ok=$((ok+1)); echo "  ${CODES[$i]}: password reset"
  else bad=$((bad+1)); echo "  ${CODES[$i]}: FAILED (the pool's password rule or permissions refused it; nothing was written for this person)"; fi
  unset pw
done
echo; echo "DONE: $ok reset, $bad failed. Passwords are in $OUT (readable only by you). Give them out yourself, then delete the file."
[[ "$bad" == 0 ]] || exit 1
