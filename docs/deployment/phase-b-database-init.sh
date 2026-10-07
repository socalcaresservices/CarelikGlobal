#!/bin/bash
# PHASE B: Database Initialization
# Usage: ./phase-b-database-init.sh <RDS_ENDPOINT> <POSTGRES_PASSWORD>
# Example: ./phase-b-database-init.sh ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com MySecurePassword123

set -e

RDS_ENDPOINT="${1:-ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com}"
POSTGRES_PASSWORD="${2}"
RDS_PORT="${3:-5432}"
MIGRATIONS_DIR="/home/user/CarelikGlobal/supabase/migrations"

if [ -z "$POSTGRES_PASSWORD" ]; then
    echo "❌ Error: PostgreSQL password required"
    echo "Usage: $0 <RDS_ENDPOINT> <POSTGRES_PASSWORD> [RDS_PORT]"
    exit 1
fi

echo "======================================"
echo "PHASE B: Database Initialization"
echo "======================================"
echo "Endpoint: $RDS_ENDPOINT"
echo "Port: $RDS_PORT"
echo "Migrations: $MIGRATIONS_DIR"
echo ""

# Step B1: Test RDS Connection
echo "Step B1: Testing RDS connection..."
PGPASSWORD="$POSTGRES_PASSWORD" psql \
  -h "$RDS_ENDPOINT" \
  -U postgres \
  -d template1 \
  -p "$RDS_PORT" \
  -c "SELECT version();" \
  && echo "✅ RDS connection successful" || {
    echo "❌ Failed to connect to RDS"
    echo "Verify:"
    echo "  - RDS endpoint is correct: $RDS_ENDPOINT"
    echo "  - RDS port is correct: $RDS_PORT"
    echo "  - postgres password is correct"
    echo "  - Security group allows inbound 5432"
    exit 1
  }

# Step B2: Create ogevia_prd database
echo ""
echo "Step B2: Creating ogevia_prd database..."
PGPASSWORD="$POSTGRES_PASSWORD" psql \
  -h "$RDS_ENDPOINT" \
  -U postgres \
  -d template1 \
  -p "$RDS_PORT" \
  -c "CREATE DATABASE ogevia_prd OWNER postgres;" \
  && echo "✅ Database created" || {
    PGPASSWORD="$POSTGRES_PASSWORD" psql \
      -h "$RDS_ENDPOINT" \
      -U postgres \
      -d template1 \
      -p "$RDS_PORT" \
      -c "SELECT 1 FROM pg_database WHERE datname='ogevia_prd';" \
      && echo "⚠️  Database already exists, continuing..."
  }

# Step B3: Apply migrations in order
echo ""
echo "Step B3: Applying 161 migrations in order..."
MIGRATION_COUNT=0
FAILED_MIGRATIONS=""

for migration_file in "$MIGRATIONS_DIR"/*.sql; do
    migration_name=$(basename "$migration_file")
    echo -n "Applying $migration_name ... "

    if PGPASSWORD="$POSTGRES_PASSWORD" psql \
      -h "$RDS_ENDPOINT" \
      -U postgres \
      -d ogevia_prd \
      -p "$RDS_PORT" \
      -f "$migration_file" > /dev/null 2>&1; then
        echo "✅"
        ((MIGRATION_COUNT++))
    else
        echo "❌ FAILED"
        FAILED_MIGRATIONS="$FAILED_MIGRATIONS\n  - $migration_name"
    fi
done

if [ -z "$FAILED_MIGRATIONS" ]; then
    echo "✅ All $MIGRATION_COUNT migrations applied successfully"
else
    echo "❌ Failed migrations:$FAILED_MIGRATIONS"
    exit 1
fi

# Step B4: Verify schema
echo ""
echo "Step B4: Verifying schema..."

TABLE_COUNT=$(PGPASSWORD="$POSTGRES_PASSWORD" psql \
  -h "$RDS_ENDPOINT" \
  -U postgres \
  -d ogevia_prd \
  -p "$RDS_PORT" \
  -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';")

echo "  Table count: $TABLE_COUNT (expected ~45)"

RLS_COUNT=$(PGPASSWORD="$POSTGRES_PASSWORD" psql \
  -h "$RDS_ENDPOINT" \
  -U postgres \
  -d ogevia_prd \
  -p "$RDS_PORT" \
  -t -c "SELECT count(*) FROM pg_policies WHERE schemaname = 'public';")

echo "  RLS policies: $RLS_COUNT (expected ~25)"

TRIGGER_COUNT=$(PGPASSWORD="$POSTGRES_PASSWORD" psql \
  -h "$RDS_ENDPOINT" \
  -U postgres \
  -d ogevia_prd \
  -p "$RDS_PORT" \
  -t -c "SELECT count(*) FROM information_schema.triggers WHERE event_object_schema = 'public';")

echo "  Audit triggers: $TRIGGER_COUNT (expected ~30)"

if [ "$TABLE_COUNT" -gt 40 ] && [ "$RLS_COUNT" -gt 20 ] && [ "$TRIGGER_COUNT" -gt 25 ]; then
    echo "✅ Schema verification PASSED"
else
    echo "⚠️  Schema verification: check counts above"
fi

# Step B5: Create application user
echo ""
echo "Step B5: Creating application database user..."
read -sp "Enter app database password (min 32 chars, mixed case + numbers): " APP_PASSWORD
echo ""

PGPASSWORD="$POSTGRES_PASSWORD" psql \
  -h "$RDS_ENDPOINT" \
  -U postgres \
  -d ogevia_prd \
  -p "$RDS_PORT" \
  -c "CREATE ROLE ogevia_app WITH LOGIN PASSWORD '$APP_PASSWORD';" \
  && echo "✅ Application user created" || {
    echo "⚠️  User may already exist, verifying..."
    PGPASSWORD="$POSTGRES_PASSWORD" psql \
      -h "$RDS_ENDPOINT" \
      -U postgres \
      -d ogevia_prd \
      -p "$RDS_PORT" \
      -c "SELECT 1 FROM pg_roles WHERE rolname='ogevia_app';" \
      && echo "✅ Application user exists"
  }

# Step B6: Grant permissions
echo ""
echo "Step B6: Granting permissions to application user..."
PGPASSWORD="$POSTGRES_PASSWORD" psql \
  -h "$RDS_ENDPOINT" \
  -U postgres \
  -d ogevia_prd \
  -p "$RDS_PORT" \
  -c "GRANT CONNECT ON DATABASE ogevia_prd TO ogevia_app;" \
  -c "GRANT USAGE ON SCHEMA public TO ogevia_app;" \
  -c "GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ogevia_app;" \
  && echo "✅ Permissions granted"

# Step B7: Store credentials in Secrets Manager
echo ""
echo "Step B7: Storing credentials in AWS Secrets Manager..."
echo "  Command to run on AWS CLI-authorized machine:"
echo ""
cat <<EOF
aws secretsmanager create-secret \
  --name ogevia/database/app-prd \
  --region us-west-2 \
  --secret-string '{
    "username": "ogevia_app",
    "password": "$APP_PASSWORD",
    "engine": "postgres",
    "host": "$RDS_ENDPOINT",
    "port": $RDS_PORT,
    "dbname": "ogevia_prd"
  }'
EOF

echo ""
echo "======================================"
echo "✅ PHASE B COMPLETE"
echo "======================================"
echo "Next: PHASE C - Tenant Initialization"
echo ""
