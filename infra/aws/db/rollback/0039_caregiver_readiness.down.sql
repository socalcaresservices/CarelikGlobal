-- ROLLBACK 0039_caregiver_readiness | CLASS: SAFE AUTOMATED (refuses while any readiness record exists)
-- Removes the readiness gates, functions and tables. Refuses while any service approval, readiness setting,
-- document-verification revocation, approved document validity or required-document marking exists: those are
-- records, not disposable structure. To stop ENFORCING without losing anything, use the switches instead:
-- Settings turn service checks and required availability off, and a required document type can be un-marked.
do $$ begin
  if exists (select 1 from ogevia.caregiver_service_approvals)
     or exists (select 1 from ogevia.agency_readiness_settings)
     or exists (select 1 from ogevia.document_version_revocations)
     or exists (select 1 from ogevia.document_types where required_for_work)
     or exists (select 1 from ogevia.document_versions
                 where approved_valid_from is not null or approved_valid_through is not null or approved_review_due_on is not null) then
    raise exception 'ROLLBACK REFUSED: service approvals, readiness settings, revocations, required-document markings or approved document dates exist; they are kept. Switch enforcement off instead.';
  end if;
end $$;

drop trigger visits_start_gate on ogevia.service_visits;
drop trigger assignments_readiness_gate on ogevia.caregiver_assignments;
drop trigger shifts_readiness_gate on ogevia.shifts;
drop function ogevia.visits_start_gate();
drop function ogevia.assignments_readiness_gate();
drop function ogevia.shifts_readiness_gate();

drop function ogevia_api.list_readiness_flags(uuid, integer);
drop function ogevia_api.list_document_compliance(uuid);
drop function ogevia_api.list_my_service_approvals(uuid);
drop function ogevia_api.list_caregiver_service_approvals(uuid, uuid);
drop function ogevia_api.change_caregiver_service_approval(uuid, date, date, text, uuid);
drop function ogevia_api.revoke_caregiver_service_approval(uuid, text, uuid);
drop function ogevia_api.set_caregiver_service_approval(uuid, uuid, uuid, date, date, text, uuid);
drop function ogevia_api.revoke_document_verification(uuid, text, uuid);
drop function ogevia_api.verify_document_version(uuid, date, date, date, text, uuid);
drop function ogevia_api.set_document_type_required(uuid, uuid, boolean, text);
drop function ogevia_api.set_readiness_settings(uuid, boolean, boolean, integer, text);
drop function ogevia_api.get_readiness_settings(uuid);
drop function ogevia_api.begin_availability_override(uuid, text);
drop function ogevia_api.get_assignment_readiness(uuid, uuid, uuid, uuid, timestamptz, timestamptz, uuid);

drop function ogevia.assert_assignment_ready(uuid, uuid, uuid, uuid, timestamptz, timestamptz, uuid, text, boolean, boolean, text);
drop function ogevia.assignment_readiness(uuid, uuid, uuid, uuid, timestamptz, timestamptz, uuid, text, boolean, boolean);
drop function ogevia.document_state_label(text, text);
drop function ogevia.document_has_pending(uuid, uuid, uuid);
drop function ogevia.document_requirement_state(uuid, uuid, uuid, date, date);
drop function ogevia.lock_caregiver_schedule(uuid);

drop table ogevia.caregiver_service_approvals;
drop function ogevia.service_approvals_guard_update();
drop table ogevia.document_version_revocations;

alter table ogevia.document_versions
  drop constraint document_versions_approved_dates,
  drop constraint document_versions_approved_shape,
  drop column approved_review_due_on,
  drop column approved_valid_through,
  drop column approved_valid_from;
create or replace function ogevia.document_versions_guard_update()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  if old.review_status <> 'awaiting_review' then
    raise exception 'This document version has already been reviewed' using errcode = 'OGC09';
  end if;
  if (to_jsonb(new) - array['review_status', 'reviewed_by', 'reviewed_at', 'rejection_reason'])
     is distinct from (to_jsonb(old) - array['review_status', 'reviewed_by', 'reviewed_at', 'rejection_reason']) then
    raise exception 'Document versions are append-only; upload a new version instead' using errcode = 'OGC09';
  end if;
  return new;
end;
$$;
alter table ogevia.document_types drop column required_for_work;

drop function ogevia.readiness_settings(uuid);
drop table ogevia.agency_readiness_settings;

delete from ogevia.role_permissions where permission_key in ('readiness.manage', 'readiness.override_availability', 'service_approvals.manage');
delete from ogevia.permissions where key in ('readiness.manage', 'readiness.override_availability', 'service_approvals.manage');
