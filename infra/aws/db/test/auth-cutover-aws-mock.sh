#!/usr/bin/env bash
# Mock aws for the production authentication-separation scripts (a-deploy, b-admin, c-web, d-verify, e-rollback). Stateful through files under $MOCK_DIR/state. Handles the
# calls those scripts make; everything else (the database window: ec2, ssm, rds, ...) is delegated unchanged to the release package's mock. WRITE verbs are logged to
# $MOCK_DIR/writes.log; secret values are never logged.
D="$MOCK_DIR"; S="$D/state"; svc="$1"; verb="$2"; ALL="$*"
arg() { local k="$1"; shift; while [[ $# -gt 0 ]]; do [[ "$1" == "$k" ]] && { echo "$2"; return; }; shift; done; }
log() { echo "$ALL" >> "$D/aws-calls.log"; }
case "$svc $verb" in
  "cloudformation describe-stacks")
    shift 2; n=$(arg --stack-name "$@"); [[ -f "$S/stacks/$n.json" ]] || { [[ -n "$n" ]] && { log; echo "An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id $n does not exist" >&2; exit 254; }; }
    log; cat "$S/stacks/$n.json" ;;
  "cloudformation get-template") shift 2; n=$(arg --stack-name "$@"); log; [[ -f "$D/live/$n.json" ]] || { echo "does not exist" >&2; exit 254; }; jq -c '{TemplateBody: .}' "$D/live/$n.json" ;;
  "cloudformation list-stack-resources")
    shift 2; n=$(arg --stack-name "$@"); log; [[ -f "$S/resources/$n.json" ]] && cat "$S/resources/$n.json" || { echo '{"StackResourceSummaries":[]}'; } ;;
  "cognito-idp admin-get-user")
    shift 2; p=$(arg --user-pool-id "$@"); u=$(arg --username "$@"); log
    [[ -f "$S/cognito/$p.json" ]] || { echo "ResourceNotFoundException" >&2; exit 254; }
    jq -e --arg u "$u" '.users[$u]' "$S/cognito/$p.json" > "$D/cog.tmp" 2>/dev/null || { echo "UserNotFoundException" >&2; exit 254; }
    jq -n --slurpfile x "$D/cog.tmp" '{Username:"u", UserStatus:$x[0].status, Enabled:$x[0].enabled, UserAttributes:[{Name:"sub",Value:$x[0].sub},{Name:"email",Value:"x"}]}' ;;
  "cognito-idp describe-user-pool") shift 2; p=$(arg --user-pool-id "$@"); log; [[ -f "$S/cognito/$p.json" ]] || { echo "ResourceNotFoundException" >&2; exit 254; }; jq -c '{UserPool: .pool}' "$S/cognito/$p.json" ;;
  "cognito-idp list-user-pool-clients") shift 2; p=$(arg --user-pool-id "$@"); log; [[ -f "$S/cognito/$p.json" ]] || { echo "ResourceNotFoundException" >&2; exit 254; }; jq -c '{UserPoolClients: [.clients[] | {ClientId, ClientName}]}' "$S/cognito/$p.json" ;;
  "cognito-idp describe-user-pool-client") shift 2; p=$(arg --user-pool-id "$@"); c=$(arg --client-id "$@"); log; jq -c --arg c "$c" '{UserPoolClient: (.clients[] | select(.ClientId==$c))}' "$S/cognito/$p.json" ;;
  "apigatewayv2 get-authorizers") shift 2; a=$(arg --api-id "$@"); log; [[ -f "$S/authorizers/$a.json" ]] && cat "$S/authorizers/$a.json" || { echo "NotFoundException" >&2; exit 254; } ;;
  "lambda get-function-configuration") shift 2; n=$(arg --function-name "$@"); log; [[ -f "$S/lambda/$n.json" ]] && cat "$S/lambda/$n.json" || { echo "ResourceNotFoundException" >&2; exit 254; } ;;
  "lambda invoke")
    echo "$ALL" | sed -E 's/--payload [^ ]+ /--payload <payload> /' >> "$D/aws-calls.log"; echo "lambda invoke $(arg --function-name $ALL)" >> "$D/writes.log"
    shift 2; payload=$(arg --payload "$@"); echo "$payload" > "$D/last-invoke-payload.json"
    # the output file is the one positional argument after the options
    positional=(); skip=0; for a in "$@"; do if (( skip )); then skip=0; continue; fi; case "$a" in --function-name|--payload|--output|--cli-binary-format) skip=1 ;; --*) ;; *) positional+=("$a") ;; esac; done
    cp "$S/invoke-response.json" "${positional[0]}"; echo '{"StatusCode":200}' ;;
  "rds describe-db-snapshots")
    shift 2; id=$(arg --db-snapshot-identifier "$@"); log; [[ -f "$S/snapshot.json" ]] || { echo "DBSnapshotNotFound" >&2; exit 254; }
    jq -c --arg id "$id" '{DBSnapshots:[ . + {DBSnapshotIdentifier:$id} ]}' "$S/snapshot.json" ;;
  "s3 cp")
    shift 2; if [[ "$1" == s3://* ]]; then k="${1#s3://*/}"; log; [[ -f "$D/web/$k" ]] && cp "$D/web/$k" "$2" || { echo "NoSuchKey" >&2; exit 1; }
    else k="${2#s3://*/}"; log; echo "s3 cp $1 -> $2" >> "$D/writes.log"; mkdir -p "$(dirname "$D/web/$k")"; cp "$1" "$D/web/$k"; fi ;;
  "s3 sync")
    shift 2; src="$1"; dst="${2#s3://}"; prefix="${dst#*/}"; [[ "$dst" == */* ]] || prefix=""; ex=(); shift 2
    while [[ $# -gt 0 ]]; do case "$1" in --exclude) ex+=("$2"); shift 2 ;; --delete) echo "UNEXPECTED s3 sync --delete" >> "$D/unexpected.log"; exit 97 ;; *) shift ;; esac; done
    log; echo "s3 sync $src -> $dst (exclude: ${ex[*]})" >> "$D/writes.log"
    (cd "$src" && find . -type f | sed 's|^\./||') | while read -r f; do skip=0; for e in "${ex[@]}"; do case "$f" in $e) skip=1 ;; esac; done; [[ $skip == 1 ]] && continue
      t="$D/web/${prefix:+$prefix/}$f"; mkdir -p "$(dirname "$t")"; cp "$src/$f" "$t"; done ;;
  "s3api list-objects-v2") log; (cd "$D/web" && find . -type f | sed 's|^\./||' | while read -r f; do printf '%s\t%s\n' "$f" "$(stat -c %s "$f")"; done) | jq -Rn '{IsTruncated:false, Contents:[inputs | split("\t") | {Key:.[0], Size:(.[1]|tonumber)}]}' ;;
  "s3api head-object") shift 2; k=$(arg --key "$@"); log; [[ -f "$D/web/$k" ]] && echo '{"ContentLength":1}' || { echo "Not Found" >&2; exit 254; } ;;
  "cloudfront get-distribution-config") log; echo "POLMOCK" ;;
  "cloudfront get-response-headers-policy") log; [[ -f "$S/cloudfront/csp.txt" ]] && cat "$S/cloudfront/csp.txt" || { echo "NoSuchResponseHeadersPolicy" >&2; exit 254; } ;;
  "cloudfront create-invalidation") log; echo "cloudfront create-invalidation" >> "$D/writes.log"; echo '{"Invalidation":{"Id":"IMOCK"}}' ;;
  "secretsmanager get-secret-value") log; echo "secret read" >> "$D/writes.log"; u="${MOCK_PG_USER:-postgres}"; jq -nc --arg u "$u" '{SecretString: ({username:$u, password:"localtest"} | tostring)}' ;;
  "sts get-caller-identity") log; echo '{"Account":"300094796789","Arn":"arn:aws:sts::300094796789:assumed-role/mock/operator"}' ;;
  *) exec bash "$(dirname "${BASH_SOURCE[0]}")/prd-release-exec-aws-mock.sh" "$@" ;;
esac
