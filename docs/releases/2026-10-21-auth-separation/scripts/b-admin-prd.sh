#!/usr/bin/env bash
# B: ACTIVATE THE PRODUCTION ADMINISTRATOR on the new production pool WITHOUT creating a duplicate agency or person record.
#   OGEVIA_DEPLOY_APPROVAL=<ref> OGEVIA_ADMIN_EMAIL=<the administrator's own inbox> bash b-admin-prd.sh invite
#       YELLOW (sends ONE Cognito email). Invokes the PRODUCTION identity function, which can act only on the production pool (checked first), to create the administrator's
#       sign-in there. Cognito emails a temporary password; the administrator sets a password and enrols an authenticator app at first sign-in. Nothing in the database changes.
#   OGEVIA_DEPLOY_APPROVAL=<ref> OGEVIA_EXPECT_HOST_IP=<admin host IP> bash b-admin-prd.sh inspect
#       YELLOW (opens the same temporary database window as the release's d1/f1 scripts, READ ONLY): lists every person record and its access (15_prd_inspect_sign_ins.sql).
#       Shows no email, no sign-in id and no hash.
#   ... OGEVIA_ADMIN_EMAIL=<email> [OGEVIA_OLD_EMAIL=<email in the old pool if different>] bash b-admin-prd.sh relink
#       YELLOW: moves the EXISTING person record of that email's old sign-in (shared pool) to its new sign-in (production pool) (16_prd_relink_sign_in.sql): same person, same agency, same
#       role, same history; refuses if it would create or merge a duplicate; one audit event per agency. Idempotent.
#   ... bash b-admin-prd.sh undo      the same procedure with the two sign-ins swapped (rollback of one person).
# Typed phrases: INVITE-PRD-ADMIN / OPEN-5432-WINDOW-AUTH-INSPECT / -RELINK / -UNDO. No sign-in id, email or password is ever printed. Exit codes as d1-migrate-prd.sh (3 = the temporary
# database rule could not be verified removed).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/common.sh"
ARG="${1:-}"; MIGRATING=0
[[ $# -eq 1 && "$ARG" =~ ^(invite|inspect|relink|undo|--restore-only)$ ]] || { echo "usage: bash b-admin-prd.sh invite|inspect|relink|undo|--restore-only" >&2; exit 2; }
need aws jq timeout
EMAIL_RE='^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
SUBRE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
cog() {   # $1 = pool id, $2 = email -> prints "sub|status|enabled" (read-only admin-get-user); never echoed to the screen by this script
  local j; j=$(A cognito-idp admin-get-user --user-pool-id "$1" --username "$2" --output json 2>/dev/null) || return 1
  jq -r '[(.UserAttributes[] | select(.Name=="sub") | .Value), .UserStatus, (.Enabled|tostring)] | join("|")' <<<"$j"
}
resolve_pools() {
  NEW_POOL=$(stack_out "$AUTH_STACK" UserPoolId); [[ "$NEW_POOL" =~ ^us-west-2_[A-Za-z0-9]+$ && "$NEW_POOL" != "$SHARED_POOL" ]] || stop "the production pool is not deployed (run a-deploy-prd.sh first), or its id equals the shared pool"
}
[[ "${OGEVIA_DEPLOY_APPROVAL:-}" =~ $APPROVAL_RE || "$ARG" == --restore-only ]] || stop "set OGEVIA_DEPLOY_APPROVAL to the approval reference"

if [[ "$ARG" == invite ]]; then
  check_account; resolve_pools
  EMAIL="${OGEVIA_ADMIN_EMAIL:-}"; [[ "$EMAIL" =~ $EMAIL_RE ]] || stop "set OGEVIA_ADMIN_EMAIL to the administrator's own email"
  ENV_POOL=$(A lambda get-function-configuration --function-name "$PRD_IDENTITY_FN" --output json 2>/dev/null | jq -r '.Environment.Variables.COGNITO_USER_POOL_ID // empty')
  [[ "$ENV_POOL" == "$NEW_POOL" ]] || stop "the production identity function acts on '${ENV_POOL:-unknown}', not the production pool. Refusing to send an invitation."
  ok "the production identity function acts on the production pool only"
  say "== PROPOSED (YELLOW): create one sign-in for the administrator in the production pool; Cognito sends ONE email with a temporary password to that address. No database change."
  read -r -p "Type INVITE-PRD-ADMIN to send it (anything else stops, nothing changed): " ANS || true
  [[ "${ANS:-}" == INVITE-PRD-ADMIN ]] || { say "Declined. Nothing was changed."; exit 0; }
  umask 077; OUTF="$AB/invite.out"
  A lambda invoke --function-name "$PRD_IDENTITY_FN" --payload "$(jq -nc --arg e "$EMAIL" '{action:"invite",email:$e}')" --cli-binary-format raw-in-base64-out "$OUTF" --output json >/dev/null 2>&1 || { rm -f "$OUTF"; stop "the identity function could not be invoked"; }
  RESP=$(jq -c '{ok, existingAccount, error}' "$OUTF" 2>/dev/null); rm -f "$OUTF"     # the raw response holds the sign-in id: deleted, never printed
  [[ "$(jq -r '.ok // false' <<<"$RESP")" == true ]] || stop "the invitation was refused: $(jq -r '.error // "unknown"' <<<"$RESP")"
  C=$(cog "$NEW_POOL" "$EMAIL") || stop "the sign-in cannot be read back from the production pool"
  ST="${C#*|}"; STATUS="${ST%%|*}"; ENABLED="${ST##*|}"
  [[ "$ENABLED" == true && ( "$STATUS" == FORCE_CHANGE_PASSWORD || "$STATUS" == CONFIRMED ) ]] || stop "the new sign-in is in an unexpected state ($STATUS, enabled=$ENABLED)"
  [[ "${C%%|*}" =~ $SUBRE ]] && ok "the administrator's sign-in exists in the PRODUCTION pool (status $STATUS)" || stop "the new sign-in has no valid id"
  say "INVITED. The administrator opens the email, signs in at the production site, sets a password and enrols an authenticator app. THEN run: bash b-admin-prd.sh relink"
  exit 0
fi

# --- database modes: the same temporary window as the release's f1 script ---
ARG_PHRASE=""; case "$ARG" in inspect) ARG_PHRASE=OPEN-5432-WINDOW-AUTH-INSPECT ;; relink) ARG_PHRASE=OPEN-5432-WINDOW-AUTH-RELINK ;; undo) ARG_PHRASE=OPEN-5432-WINDOW-AUTH-UNDO ;; esac
source "$VENDOR/window.sh"
WIN_PHRASE="$ARG_PHRASE"
on_exit() { local rc=$?; win_close; [[ $RC != 0 ]] && exit "$RC"; exit "$rc"; }
trap on_exit EXIT
trap 'say "Interrupted: cleaning up."; exit 130' INT TERM HUP
say "== B administrator access: $ARG (PRODUCTION $DB_EXPECT) UTC $(date -u +%FT%TZ)"
check_account
if [[ "$ARG" == --restore-only ]]; then win_restore_only; exit "$RC"; fi
[[ ! -f "$WIN_OPEN" ]] || stop "an earlier window is marked OPEN ($WIN_OPEN). Run: bash b-admin-prd.sh --restore-only"
SQLDIR="${OGEVIA_AUTH_SQL_DIR:-$HERE/sql}"; [[ -f "$SQLDIR/16_prd_relink_sign_in.sql" ]] || SQLDIR="$HERE/../../../../infra/aws/db/deploy"
[[ -f "$SQLDIR/16_prd_relink_sign_in.sql" && -f "$SQLDIR/15_prd_inspect_sign_ins.sql" ]] || stop "the SQL files were not found ($SQLDIR)"
# inspect is read-only and is meant to run BEFORE the production pool exists; relink and undo need the pool
[[ "$ARG" == inspect ]] || resolve_pools
# window.sh reads the handler function name from here
FN=$(A cloudformation list-stack-resources --stack-name "$API_STACK" --output json 2>/dev/null | jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId | startswith("Handler")))][0].PhysicalResourceId // empty')
[[ -n "$FN" ]] || stop "cannot find the API handler function"; printf '%s\n' "$FN" > "$B/handler-function-name.txt"
OLD_SUB=""; NEW_SUB=""; PROP=""
if [[ "$ARG" != inspect ]]; then
  EMAIL="${OGEVIA_ADMIN_EMAIL:-}"; [[ "$EMAIL" =~ $EMAIL_RE ]] || stop "set OGEVIA_ADMIN_EMAIL to the administrator's own email"
  OLD_EMAIL="${OGEVIA_OLD_EMAIL:-$EMAIL}"; [[ "$OLD_EMAIL" =~ $EMAIL_RE ]] || stop "OGEVIA_OLD_EMAIL is not a valid email"
  OC=$(cog "$SHARED_POOL" "$OLD_EMAIL") || stop "cannot read the administrator's sign-in in the old (shared) pool"
  NC=$(cog "$NEW_POOL" "$EMAIL") || stop "cannot read the administrator's sign-in in the production pool (run: bash b-admin-prd.sh invite)"
  O_SUB="${OC%%|*}"; N_SUB="${NC%%|*}"; NR="${NC#*|}"; N_STATUS="${NR%%|*}"; N_ENABLED="${NR##*|}"
  [[ "$O_SUB" =~ $SUBRE && "$N_SUB" =~ $SUBRE ]] || stop "a sign-in id is not a UUID"
  [[ "$O_SUB" != "$N_SUB" ]] || stop "the old and new sign-ins are the same (the two pools must give different ids)"
  [[ "$N_ENABLED" == true && ( "$N_STATUS" == FORCE_CHANGE_PASSWORD || "$N_STATUS" == CONFIRMED ) ]] || stop "the production sign-in is $N_STATUS / enabled=$N_ENABLED"
  if [[ "$ARG" == relink ]]; then OLD_SUB="$O_SUB"; NEW_SUB="$N_SUB"; PROP="move the existing person record from the old (shared-pool) sign-in to the production-pool sign-in; no person, agency or membership is added or removed"
  else OLD_SUB="$N_SUB"; NEW_SUB="$O_SUB"; PROP="UNDO: move the person record back from the production-pool sign-in to the old (shared-pool) sign-in"; fi
  say "sign-ins resolved (ids not shown): old pool ${OC#*|}; production pool $N_STATUS"
fi
win_preflight
win_propose "$([[ "$ARG" == inspect ]] && echo "read the person records and their access (read-only; nothing is written)" || echo "$PROP, with an audit event per agency")"
win_open
ORGN=$(RO -d "$DB_EXPECT" -c "select count(*) from ogevia.organizations") || stop "cannot read the organizations"
say "agencies in $DB_EXPECT: $ORGN"
COUNTS_SQL="select (select count(*) from ogevia.organizations) || ' agencies, ' || (select count(*) from ogevia.app_users) || ' people, ' || (select count(*) from ogevia.organization_memberships) || ' memberships, ' || (select count(*) from ogevia.caregiver_records) || ' caregiver records'"
case "$ARG" in
  inspect)
    RO -d "$DB_EXPECT" -v expected_db="$DB_EXPECT" -f "$SQLDIR/15_prd_inspect_sign_ins.sql" 2>&1 | tee -a "$LOG" | sed 's/^/   /'
    say "INSPECT DONE. Nothing was changed." ;;
  relink|undo)
    BEFORE_COUNTS=$(RO -d "$DB_EXPECT" -c "$COUNTS_SQL") || stop "cannot count the records"; say "before: $BEFORE_COUNTS"
    MIGRATING=1
    if OUT=$(RW -d "$DB_EXPECT" -v expected_db="$DB_EXPECT" -v old_sub="$OLD_SUB" -v new_sub="$NEW_SUB" -v approval_ref="$OGEVIA_DEPLOY_APPROVAL" -f "$SQLDIR/16_prd_relink_sign_in.sql" 2>&1); then
      MIGRATING=0; printf '%s\n' "$OUT" | grep -v -e "$OLD_SUB" -e "$NEW_SUB" | tee -a "$LOG" | sed 's/^/   /'
    else
      MIGRATING=0; say "REFUSED OR FAILED (rolled back; nothing changed): $(printf '%s' "$OUT" | grep -v -e "$OLD_SUB" -e "$NEW_SUB" | grep -i -m1 -e 'ERROR' -e 'Refusing' | sed 's/^ERROR: *//')"; RC=1
    fi
    AFTER_COUNTS=$(RO -d "$DB_EXPECT" -c "$COUNTS_SQL") || stop "cannot count the records"; say "after:  $AFTER_COUNTS"
    [[ "$BEFORE_COUNTS" == "$AFTER_COUNTS" ]] && ok "no person, agency, membership or caregiver record was added or removed" || { nope "THE RECORD COUNTS CHANGED"; RC=1; } ;;
esac
win_close
say "SECURITY GROUP: $([[ -f "$WIN_OPEN" ]] && echo 'NOT RESTORED, see the instructions above' || echo 'restored and verified identical to the original')"
exit "${RC:-0}"
