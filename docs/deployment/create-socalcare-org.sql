-- SoCal Care Services Production Organization Setup
-- Execute after all migrations complete on ogevia_prd database

BEGIN;

-- 1. Create organization
INSERT INTO public.organizations (id, name, slug, status, created_at)
VALUES (
  gen_random_uuid(),
  'SoCal Care Services',
  'socalcare-services-' || to_char(NOW(), 'YYYYMMDD'),
  'active',
  NOW()
) RETURNING id AS org_id;

-- Store org_id from result above for next steps
-- Set as @org_id in psql: \set org_id 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'

-- 2. Create admin user in Cognito (via app, not SQL)
-- Use Cognito User Pool: us-west-2_849AYz5J7
-- Email: admin@ogevia.com
-- Temporary password: (will be sent via invite)
-- Note: Do NOT insert into auth.users directly; use Cognito + auth.users triggers

-- 3. Link user to organization as owner (after user created in auth.users)
INSERT INTO public.organization_members (id, organization_id, user_id, role, created_at)
VALUES (
  gen_random_uuid(),
  @org_id,
  @admin_user_id,  -- Set after creating user in Cognito
  'owner',
  NOW()
);

COMMIT;

-- 4. Verify organization created
SELECT id, name, slug, status, created_at FROM organizations 
WHERE name = 'SoCal Care Services' LIMIT 1;

-- 5. Verify member relationship
SELECT m.role, u.email, o.name 
FROM organization_members m
JOIN organizations o ON o.id = m.organization_id
JOIN auth.users u ON u.id = m.user_id
WHERE o.name = 'SoCal Care Services';
