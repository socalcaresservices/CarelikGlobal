begin;

-- Add 'pending_approval' status to support_access_status enum
-- This status represents a support access request pending org owner approval
alter type public.support_access_status add value 'pending_approval';

commit;
