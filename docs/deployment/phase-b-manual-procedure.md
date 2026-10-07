# PHASE B: Database Initialization (Manual Procedure)

If using AWS Systems Manager Session Manager or direct psql connection, follow these steps:

## Prerequisites

- AWS Systems Manager Session Manager access to EC2 instance with psql installed
- OR: Direct network access to RDS endpoint (via bastion or VPN)
- RDS endpoint: `ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com`
- RDS port: `5432`
- postgres master password: (from Secrets Manager or AWS team)

## Step B1: Connect to RDS via SSM Session Manager

**Option A: Using AWS CLI (from local machine with credentials)**

```bash
# Terminal 1: Start port forwarding
aws ssm start-session \
  --target i-1234567890abcdef0 \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["5432"]}' \
  --region us-west-2

# Terminal 2: Connect via psql
psql -h localhost -U postgres -d template1 -p 5432
# Prompt will ask for password
```

**Option B: Direct connection (if authorized via security group)**

```bash
psql -h ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com \
  -U postgres \
  -d template1 \
  -p 5432
```

## Step B2: Create Production Database

```sql
-- In psql, run:
CREATE DATABASE ogevia_prd OWNER postgres;

-- Verify:
\l ogevia_prd
-- Should show: ogevia_prd | postgres | UTF8 | en_US.UTF-8 | en_US.UTF-8 | ...
```

## Step B3: Apply All 161 Migrations

**Automated approach (if psql has file access):**

```bash
# From the machine with RDS access:
cd /home/user/CarelikGlobal/supabase/migrations

# Apply all migrations in order
for migration in *.sql; do
    echo "Applying $migration..."
    psql -h ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com \
      -U postgres \
      -d ogevia_prd \
      -f "$migration"
done
```

**Manual approach (if copying/pasting):**

```bash
# Open each migration file and copy its content
# In psql connected to ogevia_prd:
\i 20260715000100_platform_foundation.sql
\i 20260719120000_membership_invitation_acceptance.sql
... (repeat for all 161 files in order)
\i 20260826090000_manager_close_missed_visit.sql
```

## Step B4: Verify Schema

```sql
-- Count tables (expected ~45)
SELECT count(*) FROM information_schema.tables 
  WHERE table_schema = 'public' 
  AND table_type = 'BASE TABLE';

-- Count RLS policies (expected ~25)
SELECT count(*) FROM pg_policies 
  WHERE schemaname = 'public';

-- Count audit triggers (expected ~30)
SELECT count(*) FROM information_schema.triggers 
  WHERE event_object_schema = 'public';

-- List all tables
SELECT tablename FROM pg_tables 
  WHERE schemaname = 'public' 
  ORDER BY tablename;
```

## Step B5: Create Application Database User

```sql
-- In psql connected to ogevia_prd:
CREATE ROLE ogevia_app WITH LOGIN PASSWORD 'YourSecurePassword123!@#$%^&*()';

-- Verify user created
SELECT rolname FROM pg_roles WHERE rolname = 'ogevia_app';
```

## Step B6: Grant Permissions

```sql
-- In psql, run as postgres:
GRANT CONNECT ON DATABASE ogevia_prd TO ogevia_app;
GRANT USAGE ON SCHEMA public TO ogevia_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ogevia_app;

-- Verify permissions
SELECT grantee, privilege_type 
  FROM information_schema.table_privileges 
  WHERE table_schema = 'public' 
  LIMIT 20;
```

## Step B7: Test Application User Connection

```bash
# In a new terminal, test the app user can connect:
psql -h ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com \
  -U ogevia_app \
  -d ogevia_prd \
  -c "SELECT count(*) FROM organizations;"
# Should succeed and return a count
```

## Step B8: Store Credentials in Secrets Manager

**Run on a machine with AWS CLI credentials:**

```bash
aws secretsmanager create-secret \
  --name ogevia/database/app-prd \
  --region us-west-2 \
  --secret-string '{
    "username": "ogevia_app",
    "password": "YourSecurePassword123!@#$%^&*()",
    "engine": "postgres",
    "host": "ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com",
    "port": 5432,
    "dbname": "ogevia_prd"
  }'

# Verify:
aws secretsmanager get-secret-value \
  --secret-id ogevia/database/app-prd \
  --region us-west-2
```

## Verification Queries

Run these to confirm successful initialization:

```sql
-- Connected as postgres to ogevia_prd:

-- 1. Check all required tables exist
SELECT count(*) as table_count FROM pg_tables WHERE schemaname = 'public';
-- Expected: ~45

-- 2. Verify organizations table (core tenant table)
SELECT column_name, data_type FROM information_schema.columns 
  WHERE table_name = 'organizations' ORDER BY ordinal_position;

-- 3. Check RLS is enabled on key tables
SELECT tablename FROM pg_tables WHERE schemaname = 'public' 
  AND tablename IN ('organizations', 'clients', 'caregiver_records', 'service_visits')
  ORDER BY tablename;

-- 4. Verify audit table exists
SELECT 1 FROM information_schema.tables 
  WHERE table_schema = 'audit' AND table_name = 'events';

-- 5. Test RLS policy (should be visible)
SELECT polname, tablename FROM pg_policies 
  WHERE schemaname = 'public' 
  ORDER BY tablename 
  LIMIT 5;

-- 6. Check application user permissions
\du ogevia_app
```

## Rollback (if needed)

```sql
-- If migrations fail partway through, options:

-- Option 1: Restore from RDS snapshot (best)
-- Use AWS Console: RDS → Snapshots → Restore

-- Option 2: Drop and recreate (if safe)
DROP DATABASE ogevia_prd;
CREATE DATABASE ogevia_prd OWNER postgres;
-- Then re-apply migrations from scratch

-- Option 3: Investigate failed migration
-- Check logs for the specific migration that failed
-- Fix it manually or contact engineering team
```

## Troubleshooting

| Issue | Check | Solution |
|-------|-------|----------|
| `psql: error: could not translate host name` | RDS endpoint typo | Verify: `ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com` |
| `psql: error: FATAL: password authentication failed` | Wrong postgres password | Retrieve from Secrets Manager: `rds!db-ogevia-prod-postgres` |
| `psql: error: FATAL: remaining connection slot reserved` | Too many connections | Wait 30 seconds, retry |
| `ERROR: relation "x" already exists` | Migration run twice | Safe to re-run; idempotent |
| `ERROR: role "ogevia_app" already exists` | User already created | Drop and recreate: `DROP ROLE ogevia_app;` then CREATE |
| Migrations hang | Network issue | Check security group inbound port 5432 |

---

## Success Criteria

After Phase B, verify:

- ✅ 161 migrations applied without errors
- ✅ ~45 tables created
- ✅ ~25 RLS policies active
- ✅ ~30 audit triggers registered
- ✅ ogevia_app user can connect to ogevia_prd
- ✅ Credentials stored in Secrets Manager (`ogevia/database/app-prd`)
- ✅ No production data in ogevia_prd (schema only)

**Next Phase:** PHASE C - Tenant Initialization
