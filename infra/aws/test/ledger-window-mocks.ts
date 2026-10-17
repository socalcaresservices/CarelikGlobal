// A fake AWS CLI, psql and session-manager-plugin for rehearsing slice/ledger-check-temp-access.sh WITHOUT AWS. The fake keeps the
// RDS security group's rules in a JSON file, so "authorize" and "revoke" really change state the test can compare. SYNTHETIC only.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const INITIAL_SG = {
  i: [{ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, UserIdGroupPairs: [{ GroupId: "sg-064ffce3bcbe8eb3b", UserId: "300094796789" }], IpRanges: [], Ipv6Ranges: [], PrefixListIds: [] }],
  e: [{ IpProtocol: "-1", UserIdGroupPairs: [], IpRanges: [{ CidrIp: "0.0.0.0/0" }], Ipv6Ranges: [], PrefixListIds: [] }],
};

const AWS = `#!/usr/bin/env bash
# fake aws
D="$MOCK_DIR"; echo "$*" >> "$D/aws-calls.log"
svc="$1"; verb="$2"; shift 2
SG="$D/sg.json"
has() { [[ " $* " == *" $HAS "* ]]; }
case "$svc $verb" in
  "sts get-caller-identity") echo '{"Account":"300094796789","Arn":"arn:aws:sts::300094796789:assumed-role/AdministratorAccess/operator"}' ;;
  "cloudformation describe-stacks") echo UPDATE_COMPLETE ;;
  "cloudformation list-stack-resources") echo '{"StackResourceSummaries":[{"ResourceType":"AWS::Lambda::Function","LogicalResourceId":"HandlerAB12","PhysicalResourceId":"fn-handler"}]}' ;;
  "lambda get-function-configuration") echo "{\\"Environment\\":{\\"Variables\\":{\\"DB_NAME\\":\\"\${MOCK_LAMBDA_DB:-ogevia_sv_test}\\",\\"OGEVIA_ENV\\":\\"\${MOCK_LAMBDA_ENV:-test}\\"}}}" ;;
  "rds describe-db-instances") echo "{\\"DBInstanceStatus\\":\\"available\\",\\"PubliclyAccessible\\":false,\\"Endpoint\\":{\\"Address\\":\\"db.example.internal\\"},\\"VpcSecurityGroups\\":[{\\"VpcSecurityGroupId\\":\\"\${MOCK_RDS_SG:-sg-00530a1f4f7648e65}\\"}],\\"MasterUserSecret\\":{\\"SecretArn\\":\\"arn:aws:secretsmanager:us-west-2:300094796789:secret:rds-master\\"}}" ;;
  "ec2 describe-instances") echo "[\\"i-0ce8db2d7e5839dd5\\",[\\"\${MOCK_HOST_SG:-sg-00e01e2ca80442c1f}\\"]]" ;;
  "ec2 describe-network-interfaces") if [[ -n "\${MOCK_SHARED_ENI:-}" ]]; then echo '[["eni-1","i-0ce8db2d7e5839dd5"],["eni-2","i-other"]]'; else echo '[["eni-1","i-0ce8db2d7e5839dd5"]]'; fi ;;
  "ec2 describe-security-groups")
    if [[ "$*" == *"{i:IpPermissions"* ]]; then cat "$SG"
    else jq -r '.i[] | select(.IpProtocol=="tcp" and .FromPort==5432 and .ToPort==5432) | .UserIdGroupPairs[].GroupId' "$SG" | tr '\\n' '\\t'; echo; fi ;;
  "ec2 authorize-security-group-ingress")
    [[ -n "\${MOCK_FAIL_AUTHORIZE:-}" ]] && { echo "An error occurred (UnauthorizedOperation)" >&2; exit 254; }
    g=$(grep -o 'GroupId=sg-[0-9a-f]*' <<<"$*" | head -1 | cut -d= -f2)
    jq --arg g "$g" '.i |= map(if (.IpProtocol=="tcp" and .FromPort==5432 and .ToPort==5432) then .UserIdGroupPairs += [{GroupId:$g,UserId:"300094796789"}] else . end)' "$SG" > "$SG.tmp" && mv "$SG.tmp" "$SG" ;;
  "ec2 revoke-security-group-ingress")
    n=$(cat "$D/revoke-count" 2>/dev/null || echo 0); echo $((n+1)) > "$D/revoke-count"
    if [[ -n "\${MOCK_REVOKE_ALWAYS_FAILS:-}" ]] || (( n < \${MOCK_REVOKE_FAILS:-0} )); then echo "An error occurred (RequestLimitExceeded)" >&2; exit 254; fi
    g=$(grep -o 'GroupId=sg-[0-9a-f]*' <<<"$*" | head -1 | cut -d= -f2)
    jq --arg g "$g" '.i |= map(if (.IpProtocol=="tcp" and .FromPort==5432 and .ToPort==5432) then .UserIdGroupPairs |= map(select(.GroupId != $g)) else . end)' "$SG" > "$SG.tmp" && mv "$SG.tmp" "$SG" ;;
  "ssm start-session")
    port=$(grep -o 'localPortNumber=[0-9]*' <<<"$*" | cut -d= -f2)
    exec python3 -c "import socket,time,sys
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('127.0.0.1', int(sys.argv[1]))); s.listen(5); time.sleep(600)" "$port" ;;
  "secretsmanager get-secret-value") echo '{"username":"mockadmin","password":"SECRET-PW-CANARY"}' ;;
  *) echo "mock aws: unexpected call: $svc $verb $*" >&2; echo "UNEXPECTED $svc $verb" >> "$D/aws-calls.log"; exit 99 ;;
esac
`;

const PSQL = `#!/usr/bin/env bash
# fake psql
D="$MOCK_DIR"
[[ "\${PGOPTIONS:-}" == *"default_transaction_read_only=on"* ]] || { echo "psql without the read-only option" >> "$D/psql-violations.log"; }
args="$*"; echo "$args" >> "$D/psql-calls.log"
[[ -n "\${MOCK_PSQL_SLEEP:-}" ]] && { touch "$D/psql-started"; sleep "$MOCK_PSQL_SLEEP"; }
[[ -n "\${MOCK_PSQL_FAIL:-}" ]] && { echo "psql: connection failed" >&2; exit 2; }
case "$args" in
  *pg_database*) echo "${"$"}{MOCK_DBS:-ogevia_sv_test,ogevia_prd}" ;;
  *current_database*) echo "${"$"}{MOCK_CURRENT_DB:-ogevia_sv_test} | read_only=on" ;;
  *"count(*) ||"*) echo "52 migrations applied, latest 0052" ;;
  *"version >= '0053'"*) if [[ -n "\${MOCK_LEDGER_ROWS:-}" ]]; then printf '%s\\n' "$MOCK_LEDGER_ROWS"; fi ;;
  *) echo "mock psql: unexpected: $args" >&2; exit 98 ;;
esac
`;

export function installMocks(dir: string) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "aws"), AWS.replace(/\$\{"\$"\}/g, "$"));
  writeFileSync(join(bin, "psql"), PSQL.replace(/\$\{"\$"\}/g, "$"));
  writeFileSync(join(bin, "session-manager-plugin"), "#!/usr/bin/env bash\nexit 0\n");
  for (const f of ["aws", "psql", "session-manager-plugin"]) chmodSync(join(bin, f), 0o755);
  writeFileSync(join(dir, "sg.json"), JSON.stringify(INITIAL_SG));
  return bin;
}
