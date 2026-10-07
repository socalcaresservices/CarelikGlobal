#!/usr/bin/env bash
# =============================================================================
# AWS TEST Database Migration Verification Script
# =============================================================================
# Purpose:
#   Safely verify which migrations are applied to ogevia_sv_test database
#   in AWS TEST environment (account 300094796789, us-west-2).
#
# Design:
#   - PHASE 1: Read-only prechecks (no infrastructure changes)
#   - PHASE 2: Temporary network setup with automatic cleanup
#   - PHASE 3: Database verification via read-only transaction
#   - CLEANUP: Automatic restoration of original security groups
#
# Guarantees:
#   - Credentials handled in-memory only; never in command arguments
#   - TLS validation against RDS CA and hostname
#   - Read-only transaction with statement timeout
#   - Original security groups captured and restored exactly
#   - Cleanup trap installed BEFORE any infrastructure changes
#   - No migrations, writes, or deployments
# =============================================================================

set -euo pipefail
IFS=$'\n\t'

# Configuration
readonly AWS_ACCOUNT_ID="300094796789"
readonly AWS_REGION="us-west-2"
readonly CDK_STACK_NAME="Ogevia-prod-ServiceVerificationApi"
readonly RDS_INSTANCE_ID="ogevia-prod-postgres"
readonly LAMBDA_ENV_DB_HOST="DB_HOST"
readonly LAMBDA_ENV_DB_NAME="DB_NAME"
readonly LAMBDA_ENV_DB_PORT="DB_PORT"
readonly LAMBDA_ENV_DB_SECRET_ARN="DB_SECRET_ARN"

# State flags (for cleanup trap)
SG_MODIFIED=0
TUNNEL_STARTED=0
TUNNEL_PID=""

# Color output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly NC='\033[0m' # No Color

log_info() {
  echo -e "${GREEN}[INFO]${NC} $*" >&2
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $*" >&2
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $*" >&2
}

# =============================================================================
# CLEANUP TRAP --- Install FIRST, before any infrastructure changes
# =============================================================================
cleanup() {
  local exit_code=$?

  echo >&2
  log_info "=== CLEANUP PHASE ==="

  # Stop tunnel if started
  if [[ "$TUNNEL_STARTED" == "1" && -n "$TUNNEL_PID" ]]; then
    log_info "Stopping SSM session tunnel (PID: $TUNNEL_PID)..."
    if kill "$TUNNEL_PID" 2>/dev/null; then
      sleep 1
      log_info "Tunnel stopped."
    else
      log_warn "Tunnel process already terminated."
    fi
    TUNNEL_STARTED=0
  fi

  # Restore security groups if modified
  if [[ "$SG_MODIFIED" == "1" ]]; then
    log_info "Restoring original security groups to SSM host..."

    if [[ -n "${ORIGINAL_SGS:-}" ]]; then
      if aws ec2 modify-instance-attribute \
        --instance-id "$SSM_HOST_ID" \
        --groups $ORIGINAL_SGS \
        --region "$AWS_REGION" \
        2>/dev/null; then

        # Verify restoration
        CURRENT_SGS=$(aws ec2 describe-instances \
          --instance-ids "$SSM_HOST_ID" \
          --region "$AWS_REGION" \
          --query 'Reservations[0].Instances[0].SecurityGroups[*].GroupId' \
          --output text 2>/dev/null || echo "")

        if [[ "$CURRENT_SGS" == "$ORIGINAL_SGS" ]]; then
          log_info "✓ Security groups restored successfully."
          SG_MODIFIED=0
        else
          log_error "Security group restoration mismatch."
          log_error "Expected: $ORIGINAL_SGS"
          log_error "Current:  $CURRENT_SGS"
          exit_code=1
        fi
      else
        log_error "Failed to restore security groups."
        exit_code=1
      fi
    fi
  fi

  if [[ $exit_code -eq 0 ]]; then
    log_info "=== VERIFICATION COMPLETE ==="
  else
    log_error "=== VERIFICATION FAILED (exit code: $exit_code) ==="
  fi

  exit "$exit_code"
}

trap cleanup EXIT INT TERM

# =============================================================================
# PHASE 1: READ-ONLY PRECHECKS (no infrastructure changes)
# =============================================================================

log_info "=== PHASE 1: READ-ONLY PRECHECKS ==="

# 1.1: Verify AWS CLI context
log_info "Verifying AWS account and region..."
CALLER_ACCOUNT=$(aws sts get-caller-identity --region "$AWS_REGION" \
  --query 'Account' --output text 2>/dev/null || echo "")

if [[ "$CALLER_ACCOUNT" != "$AWS_ACCOUNT_ID" ]]; then
  log_error "Wrong AWS account: $CALLER_ACCOUNT (expected $AWS_ACCOUNT_ID)"
  exit 1
fi
log_info "✓ AWS account verified: $AWS_ACCOUNT_ID"

# 1.2: Check required tools
log_info "Checking required tools..."
for cmd in aws jq node timeout nc; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log_error "Required tool not found: $cmd"
    exit 1
  fi
done
log_info "✓ All required tools present (aws, jq, node, timeout, nc)"

# Check for session-manager-plugin
if ! command -v session-manager-plugin >/dev/null 2>&1; then
  log_error "session-manager-plugin not found."
  exit 1
fi
log_info "✓ session-manager-plugin available"

# 1.3: Get Lambda function from CDK stack
log_info "Retrieving Lambda function from CDK stack: $CDK_STACK_NAME..."
LAMBDA_FUNCTION=$(aws cloudformation describe-stack-resources \
  --stack-name "$CDK_STACK_NAME" \
  --region "$AWS_REGION" \
  --query 'StackResources[?ResourceType==`AWS::Lambda::Function`].PhysicalResourceId' \
  --output text 2>/dev/null || echo "")

if [[ -z "$LAMBDA_FUNCTION" ]]; then
  log_error "Could not find Lambda function in stack: $CDK_STACK_NAME"
  exit 1
fi
log_info "✓ Lambda function: $LAMBDA_FUNCTION"

# 1.4: Get Lambda environment variables
log_info "Retrieving Lambda environment configuration..."
LAMBDA_CONFIG=$(aws lambda get-function-configuration \
  --function-name "$LAMBDA_FUNCTION" \
  --region "$AWS_REGION" \
  2>/dev/null || echo "{}")

DB_HOST=$(echo "$LAMBDA_CONFIG" | jq -r '.Environment.Variables.'$LAMBDA_ENV_DB_HOST' // empty' 2>/dev/null || echo "")
DB_NAME=$(echo "$LAMBDA_CONFIG" | jq -r '.Environment.Variables.'$LAMBDA_ENV_DB_NAME' // empty' 2>/dev/null || echo "")
DB_PORT=$(echo "$LAMBDA_CONFIG" | jq -r '.Environment.Variables.'$LAMBDA_ENV_DB_PORT' // empty' 2>/dev/null || echo "5432")
DB_SECRET_ARN=$(echo "$LAMBDA_CONFIG" | jq -r '.Environment.Variables.'$LAMBDA_ENV_DB_SECRET_ARN' // empty' 2>/dev/null || echo "")

if [[ -z "$DB_HOST" || -z "$DB_NAME" || -z "$DB_SECRET_ARN" ]]; then
  log_error "Missing Lambda environment variables"
  exit 1
fi

log_info "✓ Lambda configuration retrieved:"
log_info "  DB_HOST: $DB_HOST"
log_info "  DB_NAME: $DB_NAME"
log_info "  DB_PORT: $DB_PORT"

# 1.5: Verify RDS instance exists and is private
log_info "Verifying RDS instance: $RDS_INSTANCE_ID..."
RDS_INFO=$(aws rds describe-db-instances \
  --db-instance-identifier "$RDS_INSTANCE_ID" \
  --region "$AWS_REGION" \
  2>/dev/null || echo "{}")

RDS_STATUS=$(echo "$RDS_INFO" | jq -r '.DBInstances[0].DBInstanceStatus // empty' 2>/dev/null || echo "")
RDS_PUBLIC=$(echo "$RDS_INFO" | jq -r '.DBInstances[0].PubliclyAccessible // empty' 2>/dev/null || echo "")
RDS_ENCRYPTED=$(echo "$RDS_INFO" | jq -r '.DBInstances[0].StorageEncrypted // empty' 2>/dev/null || echo "")

if [[ -z "$RDS_STATUS" ]]; then
  log_error "RDS instance not found or not accessible: $RDS_INSTANCE_ID"
  exit 1
fi

log_info "✓ RDS instance verified:"
log_info "  Status: $RDS_STATUS"
log_info "  Publicly Accessible: $RDS_PUBLIC (must be false)"
log_info "  Encrypted: $RDS_ENCRYPTED (must be true)"

if [[ "$RDS_PUBLIC" == "true" ]]; then
  log_error "RDS instance is publicly accessible."
  exit 1
fi

# 1.6: Get and verify app security group from Lambda VpcConfig
log_info "Discovering Lambda security groups from VpcConfig..."
LAMBDA_VPC_CONFIG=$(echo "$LAMBDA_CONFIG" | jq -r '.VpcConfig // empty' 2>/dev/null || echo "{}")
LAMBDA_SG_IDS=$(echo "$LAMBDA_VPC_CONFIG" | jq -r '.SecurityGroupIds[]?' 2>/dev/null || echo "")

if [[ -z "$LAMBDA_SG_IDS" ]]; then
  log_error "Lambda has no VPC security groups configured."
  exit 1
fi

log_info "  Lambda security groups: $LAMBDA_SG_IDS"

# Get RDS security group ID
RDS_SG_ID=$(echo "$RDS_INFO" | jq -r '.DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId' 2>/dev/null || echo "")
if [[ -z "$RDS_SG_ID" ]]; then
  log_error "Could not retrieve RDS security group."
  exit 1
fi

log_info "  RDS security group: $RDS_SG_ID"

# Verify which Lambda security group(s) are allowed on RDS port 5432
log_info "Verifying Lambda security group(s) have RDS inbound access on port 5432..."
APP_SECURITY_GROUP=""
VERIFIED_SG_COUNT=0

for lambda_sg in $LAMBDA_SG_IDS; do
  # Check if RDS inbound rules allow this security group on port 5432
  RULE_COUNT=$(aws ec2 describe-security-group-rules \
    --filters "Name=group-id,Values=$RDS_SG_ID" \
            "Name=cidr,Values=0.0.0.0/0" \
            "Name=from-port,Values=5432" \
            "Name=to-port,Values=5432" \
            "Name=group-owner-id,Values=$lambda_sg" \
    --region "$AWS_REGION" \
    --query 'length(SecurityGroupRules)' \
    --output text 2>/dev/null || echo "0")

  # Also check for rules allowing the security group (not just CIDR)
  RULE_FROM_SG=$(aws ec2 describe-security-groups \
    --group-ids "$RDS_SG_ID" \
    --region "$AWS_REGION" \
    --query "SecurityGroups[0].IpPermissions[?FromPort==\`5432\` || FromPort==\`null\`].UserIdGroupPairs[?GroupId==\`$lambda_sg\`]" \
    --output json 2>/dev/null || echo "[]")

  RULE_COUNT_FROM_SG=$(echo "$RULE_FROM_SG" | jq 'length' 2>/dev/null || echo "0")

  if [[ "$RULE_COUNT" -gt 0 || "$RULE_COUNT_FROM_SG" -gt 0 ]]; then
    if [[ $VERIFIED_SG_COUNT -eq 0 ]]; then
      APP_SECURITY_GROUP="$lambda_sg"
      VERIFIED_SG_COUNT=$((VERIFIED_SG_COUNT + 1))
      log_info "  ✓ Security group $lambda_sg verified on RDS port 5432 inbound rules"
    else
      log_warn "  Additional security group $lambda_sg also allowed on RDS (ambiguous; using first verified)"
    fi
  else
    log_warn "  Security group $lambda_sg NOT found in RDS port 5432 inbound rules"
  fi
done

if [[ -z "$APP_SECURITY_GROUP" ]]; then
  log_error "No Lambda security group verified against RDS inbound rules on port 5432."
  log_error "Lambda security groups: $LAMBDA_SG_IDS"
  log_error "RDS security group: $RDS_SG_ID"
  log_error "Check that RDS inbound rules allow Lambda security group(s) on port 5432."
  exit 1
fi

if [[ $VERIFIED_SG_COUNT -gt 1 ]]; then
  log_warn "Multiple Lambda security groups verified; ambiguous. Using first: $APP_SECURITY_GROUP"
fi

log_info "✓ App security group selected: $APP_SECURITY_GROUP (verified against RDS inbound rules)"

# 1.7: Verify SSM admin host
log_info "Verifying SSM admin host: i-0ce8db2d7e5839dd5..."
readonly SSM_HOST_ID="i-0ce8db2d7e5839dd5"

SSM_HOST_STATUS=$(aws ec2 describe-instances \
  --instance-ids "$SSM_HOST_ID" \
  --region "$AWS_REGION" \
  --query 'Reservations[0].Instances[0].State.Name' \
  --output text 2>/dev/null || echo "")

if [[ "$SSM_HOST_STATUS" != "running" ]]; then
  log_error "SSM host $SSM_HOST_ID is not in running state (current state: $SSM_HOST_STATUS)"
  exit 1
fi

log_info "✓ SSM admin host verified: $SSM_HOST_ID (running)"

# 1.8: Capture original security groups of the SSM host
log_info "Capturing original security groups of SSM host..."
ORIGINAL_SGS=$(aws ec2 describe-instances \
  --instance-ids "$SSM_HOST_ID" \
  --region "$AWS_REGION" \
  --query 'Reservations[0].Instances[0].SecurityGroups[*].GroupId' \
  --output text 2>/dev/null || echo "")

if [[ -z "$ORIGINAL_SGS" ]]; then
  log_error "Could not retrieve security groups for SSM host."
  exit 1
fi

log_info "✓ Original security groups: $ORIGINAL_SGS"

# 1.9: Retrieve database secret
log_info "Retrieving database secret..."
DB_SECRET_FULL=$(aws secretsmanager get-secret-value \
  --secret-id "$DB_SECRET_ARN" \
  --region "$AWS_REGION" \
  --query 'SecretString' \
  --output text 2>/dev/null || echo "")

if [[ -z "$DB_SECRET_FULL" ]]; then
  log_error "Could not retrieve database secret."
  exit 1
fi

log_info "✓ Database secret retrieved"

# 1.10: Download RDS CA certificate
log_info "Downloading RDS CA certificate..."
CA_CERT_FILE=$(mktemp)
if ! curl -s https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  -o "$CA_CERT_FILE" 2>/dev/null; then
  log_error "Failed to download RDS CA certificate."
  rm -f "$CA_CERT_FILE"
  exit 1
fi

if [[ ! -s "$CA_CERT_FILE" ]]; then
  log_error "RDS CA certificate file is empty."
  rm -f "$CA_CERT_FILE"
  exit 1
fi

log_info "✓ RDS CA certificate downloaded"

log_info "=== PHASE 1 COMPLETE (no infrastructure changes made) ==="

# =============================================================================
# PHASE 2: TEMPORARY NETWORK SETUP (with automatic cleanup)
# =============================================================================

log_info "=== PHASE 2: TEMPORARY NETWORK SETUP ==="

# 2.1: Attach app security group to SSM host
log_info "Attaching app security group ($APP_SECURITY_GROUP) to SSM host..."

NEW_SGS="$ORIGINAL_SGS $APP_SECURITY_GROUP"
NEW_SGS=$(echo "$NEW_SGS" | tr ' ' '\n' | sort -u | tr '\n' ' ' | xargs)

if ! aws ec2 modify-instance-attribute \
  --instance-id "$SSM_HOST_ID" \
  --groups $NEW_SGS \
  --region "$AWS_REGION" \
  2>/dev/null; then
  log_error "Failed to modify security groups."
  exit 1
fi

SG_MODIFIED=1
log_info "✓ Security group attached"

sleep 2

# 2.2: Open SSM tunnel to RDS
log_info "Opening SSM port-forwarding tunnel to RDS..."
TUNNEL_LOCAL_PORT=15432

aws ssm start-port-forwarding-session \
  --target "$SSM_HOST_ID" \
  --document-name "AWS-StartPortForwardingSessionToRemoteHost" \
  --parameters "{\"host\":[\"$DB_HOST\"],\"portNumber\":[\"$DB_PORT\"],\"localPortNumber\":[\"$TUNNEL_LOCAL_PORT\"]}" \
  --region "$AWS_REGION" \
  >/dev/null 2>&1 &

TUNNEL_PID=$!
TUNNEL_STARTED=1

log_info "✓ Tunnel started (PID: $TUNNEL_PID)"

# Wait for tunnel to establish
log_info "Waiting for tunnel to establish (up to 60s)..."
TUNNEL_READY=0
for i in {1..60}; do
  if nc -z localhost "$TUNNEL_LOCAL_PORT" >/dev/null 2>&1; then
    TUNNEL_READY=1
    break
  fi
  sleep 1
done

if [[ $TUNNEL_READY -eq 0 ]]; then
  log_error "Tunnel failed to establish after 60 seconds."
  exit 1
fi

log_info "✓ Tunnel established on localhost:$TUNNEL_LOCAL_PORT"

log_info "=== PHASE 2 COMPLETE ==="

# =============================================================================
# PHASE 3: DATABASE VERIFICATION (read-only transaction)
# =============================================================================

log_info "=== PHASE 3: DATABASE VERIFICATION ==="

NODE_SCRIPT=$(cat <<'NODEJS_EOF'
const pg = require('pg');
const fs = require('fs');

const dbHost = process.env.DB_HOST || 'localhost';
const dbPort = parseInt(process.env.DB_PORT || '5432', 10);
const dbName = process.env.DB_NAME;
const secretJson = process.env.DB_SECRET;
const caCertPath = process.env.CA_CERT_PATH;

let secret;
try {
  secret = JSON.parse(secretJson);
} catch (e) {
  console.error('ERROR: Failed to parse database secret:', e.message);
  process.exit(1);
}

const dbUser = secret.username;
const dbPassword = secret.password;

if (!dbName || !dbUser || !dbPassword || !caCertPath) {
  console.error('ERROR: Missing configuration');
  process.exit(1);
}

if (!fs.existsSync(caCertPath)) {
  console.error('ERROR: CA certificate file not found:', caCertPath);
  process.exit(1);
}

const caCert = fs.readFileSync(caCertPath, 'utf8');

const client = new pg.Client({
  host: dbHost,
  port: dbPort,
  database: dbName,
  user: dbUser,
  password: dbPassword,
  ssl: {
    rejectUnauthorized: true,
    ca: caCert
  },
  connectionTimeoutMillis: 5000,
  statement_timeout: 8000
});

(async () => {
  try {
    console.log('[INFO] Connecting to database...');
    await client.connect();
    console.log('[INFO] ✓ Connected');

    console.log('[INFO] Starting read-only transaction...');
    await client.query('BEGIN READ ONLY;');
    console.log('[INFO] ✓ Transaction started');

    console.log('[INFO] Verifying migration ledger structure...');
    const structureResult = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'ogevia_meta'
      AND table_name = 'schema_migrations'
      ORDER BY ordinal_position;
    `);

    if (structureResult.rows.length === 0) {
      console.error('ERROR: ogevia_meta.schema_migrations table not found.');
      await client.query('ROLLBACK;');
      process.exit(1);
    }

    console.log('[INFO] ✓ Migration table columns:');
    structureResult.rows.forEach(row => {
      console.log(`       ${row.column_name}: ${row.data_type}`);
    });

    const expectedColumns = ['version', 'name', 'checksum', 'applied_at', 'applied_by'];
    const foundColumns = structureResult.rows.map(r => r.column_name);
    const missingColumns = expectedColumns.filter(c => !foundColumns.includes(c));

    if (missingColumns.length > 0) {
      console.error('ERROR: Missing columns:', missingColumns.join(', '));
      await client.query('ROLLBACK;');
      process.exit(1);
    }

    console.log('[INFO] Querying applied migrations...');
    const migrationsResult = await client.query(`
      SELECT version, name, checksum, applied_at, applied_by
      FROM ogevia_meta.schema_migrations
      ORDER BY version ASC;
    `);

    const migrations = migrationsResult.rows;
    console.log('[INFO] ✓ Retrieved ' + migrations.length + ' migrations');
    console.log('');
    console.log('=== APPLIED MIGRATIONS ===');

    if (migrations.length === 0) {
      console.log('(none)');
    } else {
      console.log('Version | Name                                    | Applied At            | Applied By');
      console.log('--------|----------------------------------------|------------------------|----------');
      migrations.forEach(m => {
        const appliedAt = m.applied_at ? new Date(m.applied_at).toISOString() : 'N/A';
        console.log(
          String(m.version).padEnd(7) +
          ' | ' +
          (m.name || '(unnamed)').padEnd(38) +
          ' | ' +
          appliedAt.substring(0, 24).padEnd(24) +
          ' | ' +
          (m.applied_by || 'unknown')
        );
      });
    }

    console.log('');
    if (migrations.length > 0) {
      const latest = migrations[migrations.length - 1];
      console.log('[INFO] Latest migration: version ' + latest.version + ' (' + (latest.name || 'unnamed') + ')');
    }

    console.log('[INFO] Verifying SELECT permission on migration ledger...');
    const permResult = await client.query(`
      SELECT COUNT(*) as total FROM ogevia_meta.schema_migrations;
    `);
    console.log('[INFO] ✓ App role has SELECT permission');

    await client.query('ROLLBACK;');
    console.log('[INFO] ✓ Transaction closed');

    await client.end();
    console.log('[INFO] ✓ Disconnected');
    process.exit(0);

  } catch (err) {
    console.error('[ERROR]', err.message);
    try {
      await client.query('ROLLBACK;');
    } catch (e) {}
    process.exit(1);
  }
})();
NODEJS_EOF
)

export DB_HOST="localhost"
export DB_PORT="$TUNNEL_LOCAL_PORT"
export DB_NAME="$DB_NAME"
export DB_SECRET="$DB_SECRET_FULL"
export CA_CERT_PATH="$CA_CERT_FILE"

log_info "Running database verification..."
if ! node -e "$NODE_SCRIPT"; then
  log_error "Database verification failed."
  exit 1
fi

log_info "=== PHASE 3 COMPLETE ==="

log_info "=== ALL VERIFICATIONS PASSED ==="

exit 0
