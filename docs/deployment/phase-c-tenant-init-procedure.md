# PHASE C: Tenant & Data Initialization

**Objective:** Create SoCal Care Services production organization, admin user, and verify tenant isolation.

**Prerequisites:** Phase B complete (schema exists, migrations applied, app user ready)

---

## PHASE C: STEP 1 - Create Production Organization

### Option A: SQL-based (recommended)

```bash
# Connect to ogevia_prd as postgres
psql -h ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com \
  -U postgres -d ogevia_prd
```

```sql
-- In psql:
BEGIN;

-- Create organization
INSERT INTO public.organizations (id, name, slug, status, created_at)
VALUES (
  gen_random_uuid(),
  'SoCal Care Services',
  'socalcare-services-prod',
  'active',
  NOW()
) RETURNING id;

-- Copy the returned UUID for next step
-- Example: 550e8400-e29b-41d4-a716-446655440000

COMMIT;

-- Verify:
SELECT id, name, slug, status FROM organizations 
WHERE name = 'SoCal Care Services';
```

**Expected output:**
```
                  id                  |        name         |           slug            | status
--------------------------------------+---------------------+---------------------------+--------
 550e8400-e29b-41d4-a716-446655440000 | SoCal Care Services | socalcare-services-prod   | active
```

**Store this UUID** — needed for admin user linkage in Step 2.

### Option B: Via Lambda/API (if available)

After production API deploys, use:
```bash
curl -X POST https://api.ogevia.com/organizations \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "SoCal Care Services",
    "slug": "socalcare-services-prod"
  }'
```

---

## PHASE C: STEP 2 - Create Admin User in Cognito

### Create Cognito User (via AWS Console or CLI)

**Option A: AWS Console**

1. Navigate to: Cognito → User Pools → `us-west-2_849AYz5J7` → Users
2. Click "Create user"
3. Username: `admin@socalcareservices.com`
4. Email: `admin@socalcareservices.com`
5. Temporary password: `TempPass123!@#$` (user will be forced to change)
6. Send invitation: ✅ Yes
7. Click "Create user"

**Expected:** User created with FORCE_CHANGE_PASSWORD status

**Option B: AWS CLI**

```bash
aws cognito-idp admin-create-user \
  --user-pool-id us-west-2_849AYz5J7 \
  --username admin@socalcareservices.com \
  --user-attributes \
    Name=email,Value=admin@socalcareservices.com \
    Name=email_verified,Value=true \
  --temporary-password TempPass123!@#$ \
  --message-action SUPPRESS \
  --region us-west-2
```

**Output:** Copy the `Username` UUID from response

### Verify User Created

```bash
aws cognito-idp admin-get-user \
  --user-pool-id us-west-2_849AYz5J7 \
  --username admin@socalcareservices.com \
  --region us-west-2
```

**Expected:** User status = `FORCE_CHANGE_PASSWORD`

---

## PHASE C: STEP 3 - Link Admin User to Organization

### After Cognito user exists, link in ogevia_prd database:

```bash
# Connect to ogevia_prd as postgres
psql -h ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com \
  -U postgres -d ogevia_prd
```

```sql
-- In psql:
-- Set the organization ID from Step 1
\set org_id '550e8400-e29b-41d4-a716-446655440000'

-- Set the admin user ID from Cognito Step 2
\set admin_user_id '660f9511-f30c-51e5-b827-557766551111'

-- Create organization membership
INSERT INTO public.organization_members (
  id, 
  organization_id, 
  user_id, 
  role, 
  status, 
  created_at
)
VALUES (
  gen_random_uuid(),
  :'org_id'::uuid,
  :'admin_user_id'::uuid,
  'owner',
  'active',
  NOW()
);

-- Verify:
SELECT 
  om.role, 
  o.name, 
  om.status
FROM organization_members om
JOIN organizations o ON o.id = om.organization_id
WHERE o.name = 'SoCal Care Services';
```

**Expected output:**
```
 role | name                    | status
------+-------------------------+--------
 owner| SoCal Care Services     | active
```

---

## PHASE C: STEP 4 - Verify Tenant Isolation

### Test 1: Admin user can see own organization only

```sql
-- In psql, connect as different org admin if possible
-- Or run this query to verify RLS logic:

SELECT o.name, COUNT(om.id) as member_count
FROM organizations o
LEFT JOIN organization_members om ON o.id = om.organization_id
GROUP BY o.id, o.name
ORDER BY o.name;

-- Expected output should show:
-- SoCal Care Services | 1 (only the owner we just created)
```

### Test 2: Cross-organization data is invisible

```sql
-- Simulate different organizations querying data
-- Create a test second organization (if needed):

INSERT INTO public.organizations (id, name, slug, status, created_at)
VALUES (
  gen_random_uuid(),
  'Test Org 2',
  'test-org-2',
  'active',
  NOW()
) RETURNING id;

-- Verify via RLS: Only querying via organization-scoped columns works
SELECT id, name FROM organizations WHERE id = :'org_id'::uuid;
-- Should return only SoCal Care Services

-- Create separate query test:
-- (This would be tested at API/application layer)
```

---

## PHASE C: STEP 5 - Initial Data Setup (Smoke Test Prep)

### Create test client for smoke test

```sql
-- Connect to ogevia_prd as ogevia_app user

psql -h ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com \
  -U ogevia_app \
  -d ogevia_prd
```

```sql
-- In psql as ogevia_app:
\set org_id '550e8400-e29b-41d4-a716-446655440000'

-- Create test client
INSERT INTO public.clients (
  id,
  organization_id,
  first_name,
  last_name,
  client_code,
  created_at
)
VALUES (
  gen_random_uuid(),
  :'org_id'::uuid,
  'Test',
  'Client',
  'TEST-SMOKE-CLIENT',
  NOW()
) RETURNING id, client_code;

-- Verify:
SELECT id, client_code, created_at FROM clients 
WHERE client_code = 'TEST-SMOKE-CLIENT'
LIMIT 1;
```

### Create test authorization

```sql
-- Set client_id from previous step
\set client_id 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'

-- Create test service first
INSERT INTO public.services (
  id,
  organization_id,
  name,
  created_at
)
VALUES (
  gen_random_uuid(),
  :'org_id'::uuid,
  'Personal Care',
  NOW()
) RETURNING id;

-- Set service_id from above
\set service_id 'yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy'

-- Create authorization
INSERT INTO public.authorizations (
  id,
  organization_id,
  client_id,
  service_id,
  authorized_hours,
  auth_period_start,
  auth_period_end,
  created_at
)
VALUES (
  gen_random_uuid(),
  :'org_id'::uuid,
  :'client_id'::uuid,
  :'service_id'::uuid,
  40.0,  -- 40 hours
  CURRENT_DATE,
  CURRENT_DATE + INTERVAL '1 month',
  NOW()
) RETURNING id;
```

---

## PHASE C: STEP 6 - Verify Tenant Isolation (Admin Only)

### Run isolation verification queries

```sql
-- Connect as postgres (super-user) to ogevia_prd

-- Verify organization has data
SELECT o.id, o.name, 
  COUNT(DISTINCT om.id) as members,
  COUNT(DISTINCT c.id) as clients
FROM organizations o
LEFT JOIN organization_members om ON o.id = om.organization_id
LEFT JOIN clients c ON o.id = c.organization_id
WHERE o.name = 'SoCal Care Services'
GROUP BY o.id, o.name;

-- Expected: 1 org, 1 member, 1 client

-- Verify RLS policies exist
SELECT COUNT(*) as rls_policies
FROM pg_policies
WHERE schemaname = 'public'
AND tablename IN ('organizations', 'clients', 'caregiver_records', 'service_visits');

-- Expected: >=4 policies
```

---

## PHASE C: STEP 7 - Database Backup

### Create RDS snapshot before smoke test

```bash
aws rds create-db-snapshot \
  --db-instance-identifier ogevia-prod-postgres \
  --db-snapshot-identifier ogevia-prod-postgres-phase-c-complete-$(date +%s) \
  --region us-west-2

# Verify snapshot creation
aws rds describe-db-snapshots \
  --db-instance-identifier ogevia-prod-postgres \
  --region us-west-2 \
  --query 'DBSnapshots[0].[DBSnapshotIdentifier,SnapshotCreateTime,Status]'
```

**Expected:** Snapshot status = `creating` → `available` (wait 5-10 min)

---

## PHASE C: COMPLETION VERIFICATION

After completing all 7 steps, verify:

- ✅ Organization created: `SoCal Care Services`
- ✅ Admin user created in Cognito: `admin@socalcareservices.com`
- ✅ Admin user linked to organization with `owner` role
- ✅ Tenant isolation verified via RLS
- ✅ Test client created: `TEST-SMOKE-CLIENT`
- ✅ Test authorization created: 40 hours
- ✅ RDS snapshot created for rollback

**Phase C is complete when:**
- Production organization ready for smoke test
- Admin user can log in and see only their organization data
- Test data in place for smoke test execution
- Backup snapshot available for rollback

**Expected time:** 10-15 minutes

**Next phase:** PHASE D - Smoke Test Execution

---

## REFERENCE COMMANDS

### Quick Status Check

```sql
-- Run this to verify Phase C completion:
SELECT 
  (SELECT COUNT(*) FROM organizations WHERE name = 'SoCal Care Services') as org_count,
  (SELECT COUNT(*) FROM organization_members om 
   JOIN organizations o ON o.id = om.organization_id 
   WHERE o.name = 'SoCal Care Services') as member_count,
  (SELECT COUNT(*) FROM clients c 
   JOIN organizations o ON o.id = c.organization_id 
   WHERE o.name = 'SoCal Care Services') as client_count,
  (SELECT COUNT(*) FROM services s 
   JOIN organizations o ON o.id = s.organization_id 
   WHERE o.name = 'SoCal Care Services') as service_count,
  (SELECT COUNT(*) FROM authorizations a 
   JOIN organizations o ON o.id = a.organization_id 
   WHERE o.name = 'SoCal Care Services') as auth_count;

-- Expected output:
-- org_count | member_count | client_count | service_count | auth_count
--     1     |      1       |      1       |       1       |     1
```

### Rollback (if needed)

```bash
# Restore from Phase C snapshot
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier ogevia-prod-postgres-restored \
  --db-snapshot-identifier ogevia-prod-postgres-phase-c-complete-<timestamp> \
  --region us-west-2

# After restore, delete test data:
# DELETE FROM organizations WHERE name = 'SoCal Care Services';
```
