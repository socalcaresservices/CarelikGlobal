#!/usr/bin/env bash
# READ-ONLY live inventory of the TEST environment (and a comparison read of production) for the request-cleanup release.
# Run in the operator's AWS CloudShell (us-west-2). Calls only describe-*, get-* and list-* APIs plus public HTTPS GETs of the TEST site.
# Never reads a secret value, a table row, a log, or a client record. Writes sanitized JSON into an output directory, then runs check_inventory.py.
#
#   OUT=$HOME/ogevia-inventory-$(date -u +%Y%m%dT%H%M%SZ) bash TEST_INVENTORY.sh
#   optional: PGDATABASE=ogevia_sv_test PGHOST=... PGUSER=... PGPASSWORD=... (the operator's own tunnel) also reads the migration ledger and runs TEST_0109_LEDGER.sh probe
set -euo pipefail
set +x +H
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER='' AWS_CLI_AUTO_PROMPT=off
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT:-$HOME/ogevia-inventory-$(date -u +%Y%m%dT%H%M%SZ)}"
A() { aws --cli-connect-timeout 5 --cli-read-timeout 60 "$@"; }
stop() { echo "STOP: $*" >&2; exit 2; }
mkdir -p "$OUT"

ACCOUNT="$(A sts get-caller-identity --query Account --output text)"
[[ "$ACCOUNT" == 300094796789 ]] || stop "wrong AWS account"
echo "{\"account\":\"$ACCOUNT\",\"region\":\"$AWS_REGION\"}" > "$OUT/identity.json"

sanitize_template() { # reads a template on stdin, redacts secret-looking defaults and environment values, writes JSON to stdout
  python3 -c '
import json, re, sys
t = json.load(sys.stdin); t = t.get("TemplateBody", t)
secret = re.compile(r"PASSWORD|SECRET|TOKEN|PRIVATE_KEY|ENCRYPTION_KEY|SIGNING_KEY|ACCESS_KEY|API_KEY|CREDENTIAL", re.I)
for name, p in t.get("Parameters", {}).items():
    v = p.get("Default")
    if v and (p.get("NoEcho") or (secret.search(name) and isinstance(v, str) and not v.startswith("arn:"))):
        p["Default"] = "<REDACTED>"
for r in t.get("Resources", {}).values():
    env = r.get("Properties", {}).get("Environment", {}).get("Variables", {})
    for k, v in env.items():
        if isinstance(v, str) and not v.startswith("arn:") and secret.search(k):
            env[k] = "<REDACTED>"
json.dump(t, sys.stdout)'
}

capture_api() { # label stack
  local label="$1" stack="$2" fn api
  A cloudformation describe-stacks --stack-name "$stack" --query 'Stacks[0].{name:StackName,status:StackStatus}' --output json > "$OUT/$label-api-stack.json"
  A cloudformation get-template --stack-name "$stack" --template-stage Original --query TemplateBody --output json | sanitize_template > "$OUT/$label-api-template.json"
  A cloudformation list-stack-resources --stack-name "$stack" --output json > "$OUT/$label-api-resources.json"
  fn="$(jq -er '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId|startswith("Handler")))] | if length==1 then .[0].PhysicalResourceId else error("expected exactly one Handler") end' "$OUT/$label-api-resources.json")"
  A lambda get-function-configuration --function-name "$fn" \
    --query '{function:FunctionName,codeSha256:CodeSha256,runtime:Runtime,lastModified:LastModified,dbHost:Environment.Variables.DB_HOST,dbName:Environment.Variables.DB_NAME,envName:Environment.Variables.OGEVIA_ENV}' --output json > "$OUT/$label-handler.json"
  api="$(jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::ApiGatewayV2::Api")][0].PhysicalResourceId // empty' "$OUT/$label-api-resources.json")"
  if [[ -n "$api" ]]; then
    A apigatewayv2 get-routes --api-id "$api" --query 'Items[].RouteKey' --output json > "$OUT/$label-live-routes.json"
  else echo '[]' > "$OUT/$label-live-routes.json"; fi
}
capture_api test Ogevia-prod-ServiceVerificationApi
capture_api production Ogevia-prd-ServiceVerificationApi

A cloudformation describe-stacks --stack-name Ogevia-prod-WebHosting --query 'Stacks[0].{status:StackStatus,outputs:Outputs}' --output json > "$OUT/test-web-stack.json"
A rds describe-db-instances --query 'DBInstances[].{instance:DBInstanceIdentifier,host:Endpoint.Address,port:Endpoint.Port,public:PubliclyAccessible,backupDays:BackupRetentionPeriod,engine:EngineVersion,status:DBInstanceStatus,encrypted:StorageEncrypted}' --output json > "$OUT/rds.json"

SITE="${SITE:-https://demo.ogevia.com}"
code="$(curl -sS -o "$OUT/test-index.html" -w '%{http_code}' --connect-timeout 10 --max-time 60 "$SITE/" || echo 000)"
printf '{"url":"%s","httpCode":"%s","indexSha256":"%s"}\n' "$SITE" "$code" "$( [[ -s "$OUT/test-index.html" ]] && sha256sum "$OUT/test-index.html" | cut -d' ' -f1 || echo none)" > "$OUT/test-web.json"
rm -f "$OUT/test-index.html"

if [[ -n "${PGDATABASE:-}" ]]; then
  if probe="$(bash "$HERE/TEST_0109_LEDGER.sh" probe 2>&1)"; then pr=ok; else pr=failed; fi
  led="$(psql -X -At -c 'select count(*)||'"'"'/'"'"'||max(version) from ogevia_meta.schema_migrations' 2>/dev/null || echo unreadable)"
  printf '{"database":"%s","ledger":"%s","probe":"%s"}\n' "$PGDATABASE" "$led" "$pr" > "$OUT/test-db.json"
  echo "$probe" | sed -E 's#postgres://[^ ]*#postgres://<redacted>#g' > "$OUT/test-db-probe.txt"
else
  echo '{"database":null,"ledger":null,"probe":"not-run"}' > "$OUT/test-db.json"
fi
echo "captured into $OUT (sanitized; no secret values, no table data)"
python3 "$HERE/check_inventory.py" "$OUT"
