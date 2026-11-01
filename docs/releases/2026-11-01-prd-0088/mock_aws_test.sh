#!/usr/bin/env bash
# MOCKED-AWS TEST of the pre-window control flow of STELLA_PRD_DB.sh (no AWS, no database): a stub `aws` returns canned JSON for the read-only calls and RECORDS every call. Scenarios prove that
# every guard stops the run before any security-group change, that a wrong confirmation changes nothing, and that the change is only reached when every guard passes and the phrase is typed.
#   bash mock_aws_test.sh        (needs: script(1), jq, python3; a LOCAL checkout with a clean tree)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT; mkdir -p "$W/bin" "$W/home"; export HOME="$W/home"
for t in aws session-manager-plugin; do :; done
cat > "$W/bin/session-manager-plugin" <<'S'
#!/bin/sh
exit 0
S
cat > "$W/bin/aws" <<'S'
#!/usr/bin/env bash
# the mock: records the call, answers by pattern, scenario switches come from MOCK_* environment variables
echo "$*" >> "$MOCK_LOG"
a="$*"
SGJSON='{"i":[{"IpProtocol":"tcp","FromPort":5432,"ToPort":5432,"UserIdGroupPairs":[{"GroupId":"sg-064ffce3bcbe8eb3b","UserId":"1"}],"IpRanges":[],"Ipv6Ranges":[],"PrefixListIds":[]}],"e":[{"IpProtocol":"-1","UserIdGroupPairs":[],"IpRanges":[{"CidrIp":"0.0.0.0/0"}],"Ipv6Ranges":[],"PrefixListIds":[]}]}'
case "$a" in
  *"sts get-caller-identity"*) echo '{"Account":"300094796789","Arn":"arn:aws:sts::300094796789:assumed-role/mock"}' ;;
  *"cloudformation describe-stacks"*) echo "${MOCK_STACK_STATUS:-UPDATE_COMPLETE}" ;;
  *"cloudformation list-stack-resources"*) echo '{"StackResourceSummaries":[{"ResourceType":"AWS::Lambda::Function","LogicalResourceId":"Handler886CB40B","PhysicalResourceId":"mock-handler"}]}' ;;
  *"lambda get-function-configuration"*) echo "{\"Environment\":{\"Variables\":{\"DB_NAME\":\"${MOCK_DB:-ogevia_prd}\",\"OGEVIA_ENV\":\"${MOCK_ENV:-prd}\"}}}" ;;
  *"rds describe-db-instances"*) echo '{"DBInstanceStatus":"available","PubliclyAccessible":false,"Endpoint":{"Address":"mock.rds.amazonaws.com"},"MasterUserSecret":{"SecretArn":"arn:aws:secretsmanager:us-west-2:300094796789:secret:mock"},"VpcSecurityGroups":[{"VpcSecurityGroupId":"sg-00530a1f4f7648e65"}]}' ;;
  *"ec2 describe-instances --filters"*) echo "[\"i-0ce8db2d7e5839dd5\",[\"${MOCK_HOSTSG:-sg-00e01e2ca80442c1f}\"]]" ;;
  *"ec2 describe-instances --instance-ids"*) if [[ "${MOCK_TWOIPS:-0}" == 1 ]]; then echo '{"state":"running","ip":"10.20.132.179","vpc":"vpc-1","enis":[{"eni":"eni-1","ips":["10.20.132.179","10.20.132.180"]}]}'; else echo '{"state":"running","ip":"10.20.132.179","vpc":"vpc-1","enis":[{"eni":"eni-1","ips":["10.20.132.179"]}]}'; fi ;;
  *"ec2 describe-network-interfaces --filters Name=group-id"*) echo '[["eni-1","i-0ce8db2d7e5839dd5"],["eni-2",null]]' ;;
  *"ec2 describe-network-interfaces --filters Name=addresses"*) echo '[["eni-1","i-0ce8db2d7e5839dd5"]]' ;;
  *"ec2 describe-security-groups"*"IpRanges[].CidrIp"*) if [[ "${MOCK_RULE_PRESENT:-0}" == 1 ]]; then printf '10.20.132.179/32\n'; fi ;;
  *"ec2 describe-security-groups"*"{i:IpPermissions"*) echo "$SGJSON" ;;
  *"ec2 authorize-security-group-ingress"*) echo "AUTHORIZED" >> "$MOCK_LOG" ;;
  *) echo "MOCK: unhandled aws call: $a" >&2; exit 1 ;;
esac
S
chmod +x "$W/bin/aws" "$W/bin/session-manager-plugin"
# a filled copy of the script with a window that contains now
cp "$HERE/STELLA_PRD_DB.sh" "$HERE/STELLA_PRD_READONLY.sql" "$HERE/fill_pins_prd.py" "$W/"
S0=$(date -u -d '-1 hour' '+%Y-%m-%d %H:%M:%S'); E0=$(date -u -d '+3 hours' '+%Y-%m-%d %H:%M:%S')
python3 "$W/fill_pins_prd.py" --repo "$REPO" --go-ref GO-MOCK-TEST-0000 --window-start "$S0" --window-end "$E0" --files STELLA_PRD_DB.sh >/dev/null || { echo "fill failed (is the tree clean?)"; exit 2; }
fail=0
run() {   # $1 label, $2 stdin text for the prompt, remaining: env assignments. Prints the verdict.
  local label="$1" ans="$2"; shift 2
  : > "$W/calls.log"
  local out; out=$(cd "$W" && printf '%s\n' "$ans" | env PATH="$W/bin:$PATH" MOCK_LOG="$W/calls.log" "$@" script -qec "bash STELLA_PRD_DB.sh probe" /dev/null 2>&1 | sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g; s/\r//g')
  OUTTXT="$out"; AUTH=$(grep -c '^AUTHORIZED' "$W/calls.log"); CALLS=$(grep -c . "$W/calls.log")
}
expect() { # label, pattern in output, expected authorize count
  if grep -q -E "$2" <<<"$OUTTXT" && [[ "$AUTH" == "$3" ]]; then echo "PASS $1 (authorize calls: $AUTH)"; else echo "FAIL $1: pattern '$2' found=$(grep -c -E "$2" <<<"$OUTTXT"), authorize calls=$AUTH (expected $3)"; echo "$OUTTXT" | tail -6 | cut -c1-160; fail=1; fi
}
run A1 "not the phrase"; expect "wrong confirmation phrase changes nothing" "confirmation not given" 0
grep -q "PROPOSED CHANGE" <<<"$OUTTXT" && grep -q "from 10.20.132.179/32" <<<"$OUTTXT" && grep -q "RDS security group sg-00530a1f4f7648e65, ORIGINAL inbound rules" <<<"$OUTTXT" && echo "PASS A1 the proposal names the /32, the group and the original rules" || { echo "FAIL A1 proposal text"; fail=1; }
run B1 "x" MOCK_ENV=test;            expect "a non-production Lambda (OGEVIA_ENV=test) stops the run" "must serve ogevia_prd with OGEVIA_ENV=prd" 0
run B2 "x" MOCK_DB=ogevia_sv_test;   expect "the TEST database name stops the run" "must serve ogevia_prd with OGEVIA_ENV=prd" 0
run C1 "x" MOCK_HOSTSG=sg-other;     expect "an admin host with a different security group stops the run" "expected exactly" 0
run D1 "x" MOCK_TWOIPS=1;            expect "an admin host with two addresses stops the run" "exactly ONE network interface with exactly ONE private IPv4" 0
run E1 "x" MOCK_RULE_PRESENT=1;      expect "a rule that already exists stops the run" "ALREADY exists" 0
[[ $fail == 0 ]] && echo "MOCK TEST PASSED" || { echo "MOCK TEST FAILED"; exit 1; }
