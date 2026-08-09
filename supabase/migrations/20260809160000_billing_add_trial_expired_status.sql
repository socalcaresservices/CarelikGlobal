begin;

-- New value for an existing enum, its own migration/transaction on
-- purpose - Postgres won't let a newly added enum value be used later
-- in the same transaction it was added in, and the next migration
-- (subscription plans and enforcement) needs to reference
-- 'trial_expired' immediately.
alter type public.subscription_status add value if not exists 'trial_expired';

commit;
