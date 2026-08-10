begin;

-- Business rename: CareLik -> Ogevia. Nothing is live/in use on this
-- platform yet (confirmed before this change: 1 client, 0 authorizations,
-- 0 completed visits across all three organizations), so this is the
-- lowest-risk moment to rename the platform's own organization record.
-- billing_email is one of the columns organizations_protect_subscription_fields
-- (20260807133158) locks to platform-staff-only edits - correctly so for
-- app-driven writes, but it also blocks this migration's own service-role
-- update since there's no authenticated platform-owner session here.
-- Disabling the trigger for this single statement, then re-enabling it
-- in the same transaction, is the standard safe way to make a
-- legitimate one-time administrative exception without weakening the
-- guard itself.
-- slug is left as 'carelik' for now - it isn't reached via any
-- {slug}.ogevia.com subdomain in practice (this row is the platform's
-- own administrative organization, not a tenant workspace), and
-- changing it isn't needed for the rename to be complete. Revisit only
-- if something is later found to depend on the literal slug value.
alter table public.organizations disable trigger organizations_protect_subscription_fields;

update public.organizations
set legal_name = 'Ogevia',
    display_name = 'Ogevia',
    billing_email = 'admin.ogevia@gmail.com'
where slug = 'carelik';

alter table public.organizations enable trigger organizations_protect_subscription_fields;

commit;
