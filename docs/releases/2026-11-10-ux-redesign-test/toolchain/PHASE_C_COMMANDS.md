# Exact CloudShell commands — TEST preparation only

**Only section 1 is read-only and ready to run now. Section 2 is a prepared future sequence, not authorization to execute it. Nothing here was run against AWS.** CloudShell: us-west-2, account 300094796789.

## 1. Read-only proof of stack names and shared RDS

```bash
set -euo pipefail
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
aws sts get-caller-identity --query '{account:Account,arn:Arn}' --output json
[[ "$(aws sts get-caller-identity --query Account --output text)" == 300094796789 ]] || { echo 'STOP: wrong account'; exit 2; }
aws cloudformation describe-stacks --query "Stacks[?starts_with(StackName,'Ogevia-')].{stack:StackName,status:StackStatus,tags:Tags}" --output json
aws rds describe-db-instances --query 'DBInstances[].{instance:DBInstanceIdentifier,host:Endpoint.Address,port:Endpoint.Port,public:PubliclyAccessible,backupDays:BackupRetentionPeriod,engine:EngineVersion}' --output json
for env in prod prd; do
  stack="Ogevia-${env}-ServiceVerificationApi"
  fn=$(aws cloudformation describe-stack-resources --stack-name "$stack" --query "StackResources[?ResourceType=='AWS::Lambda::Function' && starts_with(LogicalResourceId,'Handler')].PhysicalResourceId | [0]" --output text)
  [[ -n "$fn" && "$fn" != None ]] || { echo "STOP: no Handler in $stack"; exit 2; }
  echo "$stack"
  aws lambda get-function-configuration --function-name "$fn" --query '{function:FunctionName,host:Environment.Variables.DB_HOST,port:Environment.Variables.DB_PORT,database:Environment.Variables.DB_NAME,environment:Environment.Variables.OGEVIA_ENV}' --output json
  aws cloudformation describe-stacks --stack-name "Ogevia-${env}-WebHosting" --query 'Stacks[0].Outputs' --output json
done
aws cloudfront list-distributions --query 'DistributionList.Items[].{id:Id,aliases:Aliases.Items,origins:Origins.Items[].DomainName}' --output json
aws ec2 describe-instances --filters 'Name=tag:Name,Values=ogevia-db-admin*' --query 'Reservations[].Instances[].{id:InstanceId,state:State.Name,groups:SecurityGroups[].GroupId}' --output json
```

Interpretation: `Ogevia-prod-ServiceVerificationApi` and `Ogevia-prod-WebHosting` are **TEST** despite their names; their database must be `ogevia_sv_test`. `Ogevia-prd-*` is **production**, with `ogevia_prd`. Compare the two Handler `host` values with the RDS `host` list: the same endpoint/instance proves they share a server. Different database names do not mean different servers. Confirm demo.ogevia.com and app.ogevia.com map to different bucket/distribution IDs. Do not infer isolation for all `Ogevia-prod-*` resources: the database/admin-host/network can be shared.

These commands never read secret values, table data, logs, or signed-client records. Send their output with account/user identifiers redacted if desired. One RDS row by itself is not proof of the apps' targets.

## 2. Prepared future sequence — DO NOT RUN now

Recommendation: separate TEST RDS first. If selected, the current hard-coded topology pins must be updated after that infrastructure work; these scripts stop on mismatches. All gates must be green on the final release commit before any future execution. The app commit is `f4316c5f1a9a844dc7749152243271cee003e94c`; the final PR head supplies the updated release tooling. This separation of app checkout and toolchain already existed in this release package.

Setup below uses the existing branch, not a new implementation. `OGEVIA_WINDOW_START`, `OGEVIA_WINDOW_END` and `OGEVIA_DEPLOY_APPROVAL` only come from a future explicit owner deployment instruction; there is no approval in this chat.

```bash
export AWS_REGION=us-west-2 AWS_PAGER=""
git clone --single-branch --branch claude/ogevia-ux-audit-redesign-w36cov https://github.com/socalcaresservices/CarelikGlobal.git ogevia-ux
cd ogevia-ux
export TOOLCHAIN="$HOME/ux-toolchain"
mkdir -p "$TOOLCHAIN"
cp docs/releases/2026-11-10-ux-redesign-test/toolchain/* "$TOOLCHAIN/"
# Check these against PINS.md before using the copies:
sha256sum "$TOOLCHAIN/OPERATOR_TEST_DB.sh" "$TOOLCHAIN/OPERATOR_TEST_DEPLOY.sh" "$TOOLCHAIN/diff_gate_ux.py" "$TOOLCHAIN/VERIFY_0090_0094.sql"
git checkout --detach f4316c5f1a9a844dc7749152243271cee003e94c
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm build
export REPO="$PWD"
# Set the future approved UTC window and reference first; scripts refuse unset values.
bash "$TOOLCHAIN/OPERATOR_TEST_DB.sh" selftest
bash "$TOOLCHAIN/OPERATOR_TEST_DEPLOY.sh" synth
bash "$TOOLCHAIN/OPERATOR_TEST_DEPLOY.sh" selftest
bash "$TOOLCHAIN/OPERATOR_TEST_DEPLOY.sh" capture
bash "$TOOLCHAIN/OPERATOR_TEST_DEPLOY.sh" check
```

`capture` copies the live TEST API template, code asset reference and web files into `~/ogevia-before-ux`; `check` rejects any difference except the Handler asset and exactly 3 new routes (override GET/POST and import POST). There must be 253 routes; duplicate routes are absent. No production stack is deployed. The DB modes below temporarily attach/restore a shared admin-host SG, so **they are not pure read-only AWS operations**, even when their SQL is a probe.

TEST-only logical backup, migrations, API/web deployment, verification (future approved window only):

```bash
bash "$TOOLCHAIN/OPERATOR_TEST_DB.sh" probe
export OGEVIA_TEST_BACKUP="$HOME/ogevia_sv_test-pre-ux-$(date -u +%Y%m%dT%H%M%SZ).dump"
bash "$TOOLCHAIN/OPERATOR_TEST_DB.sh" backup
# Preserve the .dump, .dump.sha256 and .dump.meta files; no RDS instance snapshot.
bash "$TOOLCHAIN/OPERATOR_TEST_DB.sh" apply
bash "$TOOLCHAIN/OPERATOR_TEST_DEPLOY.sh" deploy-api
bash "$TOOLCHAIN/OPERATOR_TEST_DEPLOY.sh" web
bash "$TOOLCHAIN/OPERATOR_TEST_DEPLOY.sh" post-api
bash "$TOOLCHAIN/OPERATOR_TEST_DEPLOY.sh" web-verify
bash "$TOOLCHAIN/OPERATOR_TEST_DB.sh" final
```

`apply` is only `ogevia_sv_test`, 0090→0094, with an atomic checksum ledger entry per migration. After: **93/0094**, all 58 object/ledger checks true. The logical backup is TEST-only; the server's shared load can still affect production. Run the existing authenticated TEST smoke/regression commands in `docs/release-process/PILOT_REGRESSION_RUNNER.md` using synthetic test accounts; credentials are not embedded here. The prepared commands do not seed or alter real people.

Rollback, only following a future stop condition and explicit authorization, newest layer first:

```bash
bash "$TOOLCHAIN/OPERATOR_TEST_DEPLOY.sh" rollback-web
bash "$TOOLCHAIN/OPERATOR_TEST_DEPLOY.sh" rollback-api
bash "$TOOLCHAIN/OPERATOR_TEST_DB.sh" rollback
```

Database rollback checks each recorded checksum, runs its down file and removes its ledger row in the same transaction. Full rollback returns **88/0088**. Imported records stay; merged profiles stay inactive; dropped override/import/merge audit-support tables lose their rows, preserved in the TEST backup. Never restore the shared instance: that would also roll back production. Keep the TEST dump for recovery into an isolated TEST recovery database if required; do not run an unreviewed restore over either live database.
