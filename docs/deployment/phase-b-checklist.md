# PHASE B EXECUTION CHECKLIST
**Database Initialization: ogevia_prd Schema**

---

## PRE-EXECUTION VERIFICATION

- [ ] **RDS Instance Status**
  ```bash
  aws rds describe-db-instances \
    --db-instance-identifier ogevia-prod-postgres \
    --region us-west-2
  ```
  Expected: DBInstanceStatus = `available`, AvailabilityZone = `us-west-2a` or `us-west-2b`

- [ ] **RDS Security Group**
  ```bash
  aws ec2 describe-security-groups \
    --group-ids sg-00530a1f4f7648e65 \
    --region us-west-2
  ```
  Expected: Inbound rule allows port 5432 from prodApp SG (sg-064ffce3bcbe8eb3b)

- [ ] **Network Access Path**
  - [ ] EC2 instance (ogevia-db-admin-temp) exists in private subnet
  - [ ] Can reach RDS endpoint via private IP
  - [ ] Systems Manager Session Manager configured on EC2 instance

- [ ] **Migration Files**
  ```bash
  ls -1 /home/user/CarelikGlobal/supabase/migrations/ | wc -l
  ```
  Expected: 161 files in sequential order (20260715000100 → 20260826090000)

- [ ] **Credentials Available**
  - [ ] postgres master password (from `rds!db-ogevia-prod-postgres`)
  - [ ] EC2 instance access via Systems Manager Session Manager

---

## EXECUTION STEPS

### STEP B1: Connect to RDS

**Choose one connection method:**

**Method A: Systems Manager Session Manager (Recommended - no bastion)**

```bash
# Terminal 1: Start port forwarding session
aws ssm start-session \
  --target i-1234567890abcdef0 \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{
    "host":["ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com"],
    "portNumber":["5432"],
    "localPortNumber":["5432"]
  }' \
  --region us-west-2

# Terminal 2: Connect via psql
psql -h localhost -U postgres -d template1 -p 5432
# Password: [postgres master password]
```

**Method B: Direct connection (if security group allows)**

```bash
psql -h ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com \
  -U postgres \
  -d template1 \
  -p 5432
```

**Expected output:**
```
psql (15.x)
Type "help" for help.

postgres=> 
```

### STEP B2: Verify RDS Connection

```sql
-- In psql prompt:
SELECT version();
-- Expected: PostgreSQL 15.3 on ... (or current version)

SELECT current_database();
-- Expected: template1
```

**Checkpoint:** ✅ Connected to RDS

### STEP B3: Create Production Database

```sql
-- In psql prompt:
CREATE DATABASE ogevia_prd OWNER postgres;

-- Verify:
\l ogevia_prd
-- Expected: ogevia_prd | postgres | UTF8 | ... | ...
```

**Checkpoint:** ✅ Database created

### STEP B4: Connect to Production Database

```sql
-- In psql prompt:
\c ogevia_prd
-- Expected: You are now connected to database "ogevia_prd" as user "postgres".
```

### STEP B5: Apply All 161 Migrations

**Automated (if shell access available):**

```bash
#!/bin/bash
# Save as apply-migrations.sh

MIGRATIONS_DIR="/home/user/CarelikGlobal/supabase/migrations"
DB_HOST="ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com"
DB_USER="postgres"
DB_NAME="ogevia_prd"
DB_PORT="5432"

MIGRATION_COUNT=0
FAILED=""

for migration in "$MIGRATIONS_DIR"/*.sql; do
    name=$(basename "$migration")
    echo -n "[$((++MIGRATION_COUNT))/161] $name ... "
    
    if PGPASSWORD="$POSTGRES_PASSWORD" psql \
      -h "$DB_HOST" \
      -U "$DB_USER" \
      -d "$DB_NAME" \
      -p "$DB_PORT" \
      -f "$migration" > /dev/null 2>&1; then
        echo "✅"
    else
        echo "❌"
        FAILED="$FAILED\n  - $name"
    fi
done

if [ -z "$FAILED" ]; then
    echo "✅ All migrations applied"
else
    echo "❌ Failed migrations:$FAILED"
fi
```

**Manual (copy-paste in psql):**

Open each migration file from `/home/user/CarelikGlobal/supabase/migrations/` in order and paste into psql:

```sql
-- For each migration file (161 total):
\i /absolute/path/to/20260715000100_platform_foundation.sql
\i /absolute/path/to/20260719120000_membership_invitation_acceptance.sql
... repeat for all files ...
\i /absolute/path/to/20260826090000_manager_close_missed_visit.sql
```

**Progress tracking:**
- After ~40 migrations: Core tenant/user/caregiver tables should exist
- After ~80 migrations: Service Verification tables should exist
- After ~120 migrations: Corrections and audit tables should exist
- After 161 migrations: All tables, RLS policies, and triggers in place

**Checkpoint:** ✅ All 161 migrations applied

### STEP B6: Verify Schema

```sql
-- In psql connected to ogevia_prd:

-- Count tables (expected ~45)
SELECT count(*) as table_count 
FROM information_schema.tables 
WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

-- Count RLS policies (expected ~25)
SELECT count(*) as rls_policies
FROM pg_policies 
WHERE schemaname = 'public';

-- Count audit triggers (expected ~30)
SELECT count(*) as audit_triggers
FROM information_schema.triggers 
WHERE event_object_schema = 'public';

-- List all tables
SELECT tablename FROM pg_tables 
WHERE schemaname = 'public' 
ORDER BY tablename;
```

**Expected verification output:**
```
table_count    | 45+ ✅
rls_policies   | 25+ ✅
audit_triggers | 30+ ✅
```

**Checkpoint:** ✅ Schema verified

### STEP B7: Create Application Database User

```sql
-- In psql connected to ogevia_prd:
CREATE ROLE ogevia_app WITH LOGIN PASSWORD 'YourSecurePassword123!@#$%';

-- Verify:
SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = 'ogevia_app';
-- Expected: ogevia_app | t
```

**Password requirements:**
- Minimum 32 characters
- Mix of uppercase, lowercase, numbers, special chars
- Store securely; will be placed in Secrets Manager

**Checkpoint:** ✅ Application user created

### STEP B8: Grant Permissions

```sql
-- In psql connected to ogevia_prd:
GRANT CONNECT ON DATABASE ogevia_prd TO ogevia_app;
GRANT USAGE ON SCHEMA public TO ogevia_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ogevia_app;

-- Verify permissions:
SELECT grantee, privilege_type 
FROM information_schema.table_privileges 
WHERE table_schema = 'public' AND grantee = 'ogevia_app'
LIMIT 10;
-- Expected: Multiple rows showing SELECT, INSERT, UPDATE for ogevia_app
```

**Checkpoint:** ✅ Permissions granted

### STEP B9: Test Application User Connection

```bash
# In a new terminal (with RDS access):
psql -h ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com \
  -U ogevia_app \
  -d ogevia_prd \
  -c "SELECT count(*) FROM organizations;"
# Password: [app password from Step B7]

# Expected output: count
#          0
# (empty table is expected - no data yet)
```

**Checkpoint:** ✅ Application user can connect and query

### STEP B10: Store Credentials in Secrets Manager

**Execute on a machine with AWS CLI credentials:**

```bash
# Save credentials to JSON file
cat > /tmp/ogevia-prd-app-secret.json <<'EOF'
{
  "username": "ogevia_app",
  "password": "YourSecurePassword123!@#$%",
  "engine": "postgres",
  "host": "ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com",
  "port": 5432,
  "dbname": "ogevia_prd"
}
EOF

# Create secret in Secrets Manager
aws secretsmanager create-secret \
  --name ogevia/database/app-prd \
  --region us-west-2 \
  --secret-string file:///tmp/ogevia-prd-app-secret.json

# Verify:
aws secretsmanager get-secret-value \
  --secret-id ogevia/database/app-prd \
  --region us-west-2

# Clean up
rm /tmp/ogevia-prd-app-secret.json
```

**Checkpoint:** ✅ Credentials stored securely

---

## ERROR HANDLING

| Error | Cause | Solution |
|-------|-------|----------|
| `psql: error: could not translate host name` | Network unreachable | Verify security group allows outbound to RDS |
| `FATAL: password authentication failed` | Wrong password | Retrieve from `rds!db-ogevia-prod-postgres` secret |
| `ERROR: relation "x" already exists` | Re-ran migration | Safe; continue - migrations are idempotent |
| `ERROR: role "ogevia_app" already exists` | User already created | Drop and recreate: `DROP ROLE ogevia_app;` |
| Migration hangs (>5 min) | Network/lock issue | Ctrl+C to cancel; check RDS status and restart migration |
| `FATAL: remaining connection slot reserved for replication` | Max connections reached | Wait 30 sec; disconnect other sessions |

**If migration fails partway:**

```bash
# Option 1: Resume from last successful migration
# Edit apply-migrations.sh to skip already-applied migrations and restart

# Option 2: Restore from RDS snapshot and retry
# Use AWS Console: RDS → Snapshots → Restore

# Option 3: Drop schema and restart
# psql: DROP DATABASE ogevia_prd; CREATE DATABASE ogevia_prd OWNER postgres;
# Then re-run all migrations from Step B5
```

---

## FINAL VERIFICATION

After completing all 10 steps, verify:

```sql
-- In psql connected as postgres to ogevia_prd:

-- 1. Core tables exist
SELECT count(*) FROM pg_tables WHERE schemaname = 'public';
-- Expected: >=45

-- 2. Service Verification tables exist
SELECT 1 FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name IN ('service_visits', 'visit_confirmations', 'visit_corrections');
-- Expected: 3 rows (all tables exist)

-- 3. RLS is enabled
SELECT count(*) FROM pg_policies;
-- Expected: >=25

-- 4. Audit table exists
SELECT 1 FROM information_schema.tables 
WHERE table_schema = 'audit' AND table_name = 'events';
-- Expected: 1 row

-- 5. Application user works
\du ogevia_app
-- Expected: Shows user with login ability

-- 6. No data in schema (expected for fresh schema)
SELECT count(*) FROM organizations;
-- Expected: 0
```

---

## SIGN-OFF

**Phase B is complete when:**

- ✅ All 161 migrations applied without errors
- ✅ Schema verified (45+ tables, 25+ RLS policies, 30+ triggers)
- ✅ Application user created and can connect
- ✅ Credentials stored in Secrets Manager (`ogevia/database/app-prd`)
- ✅ No production data in ogevia_prd (schema only)
- ✅ Database is ready for tenant initialization

**Expected time:** 15-30 minutes (depending on network/RDS performance)

**Next phase:** PHASE C - Tenant Initialization

---

## REFERENCE

**Migration file location:** `/home/user/CarelikGlobal/supabase/migrations/`  
**Phase B script:** `/tmp/phase-b-database-init.sh`  
**Phase B manual procedure:** `/tmp/phase-b-manual-procedure.md`  
**Database connection:** `ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com:5432`  
**Postgres user:** `postgres`  
**Application user:** `ogevia_app`  
**Application secret:** `ogevia/database/app-prd` (AWS Secrets Manager)
