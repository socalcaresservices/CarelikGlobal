#!/usr/bin/env bash
# =============================================================================
# Ogevia AWS TEST: correct a pilot sign-in's email address (same person).
#   OLD=pinkpops@gmail.com NEW=pinkpopsllc@gmail.com bash infra/aws/slice/pilot-change-email.sh
# Read-only until you type CHANGE. Then, in the TEST Cognito pool only:
#   1. sets email=NEW (email_verified=true) on the SAME sign-in. The sub does
#      not change, so the database membership, caregiver record and history
#      stay linked; nothing in the database changes.
#   2. if the person never completed first sign-in, re-sends the invitation
#      (a new temporary password) to NEW.
#   3. updates ~/ogevia-pilot-run/inputs.env so pilot-rollback.sh still finds
#      the sign-in (backup kept next to it).
# For a DIFFERENT person, do not use this: create a new individual sign-in.
# =============================================================================
set -Eeuo pipefail
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
POOL=us-west-2_849AYz5J7
ACCOUNT=300094796789
OLD="${OLD:?set OLD=<current email>}"; NEW="${NEW:?set NEW=<new email>}"
stop() { echo "STOP: $* (nothing more was changed)"; exit 1; }
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT" ]] || stop "wrong AWS account"
[[ "$NEW" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || stop "not an email address: $NEW"
[[ "${OLD,,}" != "${NEW,,}" ]] || stop "the two addresses are the same"
user_json() { aws cognito-idp admin-get-user --user-pool-id "$POOL" --username "$1" --output json 2>/dev/null || true; }
attr() { jq -r --arg n "$2" '.UserAttributes[] | select(.Name == $n) | .Value' <<<"$1"; }

U=$(user_json "$OLD")
[[ -n "$U" ]] || stop "$OLD is not a sign-in in the TEST pool"
SUB=$(attr "$U" sub); STATUS=$(jq -r .UserStatus <<<"$U"); ENABLED=$(jq -r .Enabled <<<"$U"); USERNAME=$(jq -r .Username <<<"$U")
[[ "$SUB" =~ ^[0-9a-f-]{36}$ ]] || stop "could not read the sign-in's sub"
[[ -z "$(user_json "$NEW")" ]] || stop "$NEW already belongs to another sign-in in this pool"
# Email as a sign-in attribute: Username is an internal id and the email can change.
# Email as the literal username: it cannot be renamed; a new sign-in is needed instead.
[[ "${USERNAME,,}" != "${OLD,,}" ]] || stop "this pool stores $OLD as the username itself, so it cannot be renamed; ask Claude for a new-sign-in step instead"
cat <<EOF

Sign-in:  $OLD  (sub ${SUB:0:8}..., status $STATUS, enabled $ENABLED)
Change:   email -> $NEW (marked verified). Same sub: database role and records stay linked.
$( [[ "$STATUS" == FORCE_CHANGE_PASSWORD ]] && echo "Then:     re-send the invitation (new temporary password) to $NEW" || echo "Then:     no invitation (this person has already signed in; they use $NEW from now on)" )
Also:     ~/ogevia-pilot-run/inputs.env updated so the pilot rollback finds this sign-in (backup kept)
Not touched: the database, other sign-ins, production, Netlify, Supabase.
EOF
read -r -p "Type CHANGE to apply exactly this (anything else cancels): " a
[[ "$a" == CHANGE ]] || stop "cancelled"

aws cognito-idp admin-update-user-attributes --user-pool-id "$POOL" --username "$USERNAME" \
  --user-attributes Name=email,Value="$NEW" Name=email_verified,Value=true
if [[ "$STATUS" == FORCE_CHANGE_PASSWORD ]]; then
  aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$USERNAME" --message-action RESEND \
    --desired-delivery-mediums EMAIL >/dev/null
  echo "Invitation re-sent to $NEW."
fi
INP="$HOME/ogevia-pilot-run/inputs.env"
if [[ -f "$INP" ]] && grep -qiF "$OLD" "$INP"; then
  cp -p "$INP" "$INP.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  python3 - "$INP" "$OLD" "$NEW" <<'PY'
import re, sys
p, old, new = sys.argv[1:]
s = open(p).read()
open(p, "w").write(re.sub(re.escape(old), new, s, flags=re.I))
PY
  echo "Updated $INP (backup kept)."
fi
A=$(user_json "$NEW")
[[ -n "$A" && "$(attr "$A" sub)" == "$SUB" && "$(attr "$A" email)" == "$NEW" && "$(attr "$A" email_verified)" == true ]] \
  || stop "read-back did not match; check the sign-in in the Cognito console"
[[ -z "$(user_json "$OLD")" ]] || stop "$OLD still resolves to a sign-in; check the Cognito console"
echo "Read back: sub ${SUB:0:8}... now has email $NEW (verified); $OLD no longer signs in. Status $(jq -r .UserStatus <<<"$A")."
