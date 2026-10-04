#!/usr/bin/env bash
# =============================================================================
# Ogevia AWS TEST: independent live status (READ-ONLY), in this order:
#   1. Phase 7 security settings (phase7_evidence.py): encryption, private DB,
#      IAM, CloudTrail, alarms and retention, backups, S3 public access,
#      Cognito MFA, budgets. Describe/get/list calls only.
#   2. Deployment and access (owner-access-check.sh):
#      part A, no prompt: Cognito sign-ins and which API build is live;
#      part B, only if you type READ-DB: migration ledger (expects 0018 after
#      the pilot), agency memberships, roles and effective permissions, in a
#      READ ONLY transaction. The app security group is attached to the admin
#      host for the tunnel and removed again (verified);
#      part C, only if you type OWNER: the owner fix, shown in full first.
# Never prints passwords, tokens or secret values. Never touches production,
# Netlify or Supabase.
# =============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
echo "=== 1/2 Security settings (read-only) ==="
python3 "$HERE/phase7_evidence.py" || echo "Security evidence ended with exit $? (see the lines above)."
echo
echo "=== 2/2 Deployment, sign-ins and owner access ==="
bash "$HERE/owner-access-check.sh"
