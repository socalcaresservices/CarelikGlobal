-- ROLLBACK 0019_billing_approval | CLASS: BACKUP REQUIRED
-- Removes human billing approval. Refuses while any approval row exists:
-- approvals are financial records (who approved what, when) and must be
-- exported and owner-approved before removal. Visits are not touched.
do $$ begin
  if to_regclass('ogevia.billing_approvals') is not null
     and exists (select 1 from ogevia.billing_approvals) then
    raise exception 'Refusing: billing approvals exist. Snapshot + owner approval + forward fix required.';
  end if;
end $$;
drop function if exists ogevia_api.list_billing_approvals(uuid, date, date);
drop function if exists ogevia_api.void_billing_approval(uuid, text, uuid);
drop function if exists ogevia_api.approve_visit_for_billing(uuid, integer, text, uuid);
drop trigger if exists service_visits_billing_approval_guard on ogevia.service_visits;
drop function if exists ogevia.service_visits_billing_approval_guard();
drop table if exists ogevia.billing_approvals;
drop function if exists ogevia.billing_approvals_guard_update();
delete from ogevia.role_permissions where permission_key = 'billing.read';
delete from ogevia.permissions where key = 'billing.read';
