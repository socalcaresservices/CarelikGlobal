-- 0075 The schedule says what happened to a shift (Board 3 requirement 15): verification pending, in review, partial, missed, not delivered, delivered but not verified.
--
-- list_shifts gains: visit_status, visit_worked_minutes, scheduled_minutes, display_state and reconciliation_outcome. display_state is decided here, once:
--   cancelled / no_show                 the shift's own status
--   in_progress                         a visit exists and is still open
--   verification_pending                the visit ended and awaits the client or representative
--   in_review                           the visit is in administrator review
--   partial                             a signed visit whose worked minutes are shorter than the scheduled minutes by MORE than the agency's schedule rule
--                                       (the same rule the visit review uses; 15 minutes until the agency sets its own)
--   completed                           any other signed visit
--   missed                              the shift ended, has no visit record and nobody has decided what happened (it is also listed to reconcile; nothing is released)
--   not_delivered / delivered_not_verified / awaiting_record   what a person decided for an ended shift with no visit (0067, 0071)
--   covered / needs_coverage            a shift still to come
-- 'missed' means "no visit record and no decision yet". It does not say the caregiver failed to go; Ogevia cannot know that, and Board 5 rule 6 keeps a missed-VISITS metric
-- unpublished until the owner defines it. No stored value changes; the existing columns are returned exactly as before.
-- Rollback restores the 0053 function.

drop function ogevia_api.list_shifts(uuid, date, date, uuid);
create function ogevia_api.list_shifts(p_organization_id uuid, p_from date, p_to date, p_client_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(shift_id uuid, starts_at timestamp with time zone, ends_at timestamp with time zone, local_date date, coverage_state text, shift_status text, client_id uuid, client_code text, client_name text, service_id uuid, service_code text, service_name text, caregiver_record_id uuid, caregiver_code text, caregiver_name text, has_sign_in boolean, reserved_minutes integer, from_care_request boolean, has_visit boolean, last_callout_reason text, series_id uuid, availability_override boolean, availability_override_reason text, makeup_for_shift_id uuid, visit_status text, visit_worked_minutes integer, scheduled_minutes integer, display_state text, reconciliation_outcome text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $$
  with ctx as (
    select ogevia.require_actor() as actor,
           ogevia.is_active_member(p_organization_id)
             and (ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'visits.manage')) as can_list,
           ogevia.has_permission(p_organization_id, 'clients.names.read') as can_names,
           o.timezone as tz
    from ogevia.organizations o where o.id = p_organization_id
  )
  select s.id, s.starts_at, s.ends_at, (s.starts_at at time zone ctx.tz)::date, ogevia.shift_coverage_state(s), s.status::text,
         c.id, c.client_code,
         case when ctx.can_names then nullif(btrim(coalesce(n.legal_first_name, '') || ' ' || coalesce(n.legal_last_name, '')), '') end,
         sv.id, sv.code, sv.name,
         cr.id, cr.caregiver_code, case when cr.id is not null then coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name end,
         cr.linked_user_id is not null,
         r.reserved_minutes, ogevia.shift_is_care_request(s.id),
         exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected')),
         (select e.reason from ogevia.shift_coverage_events e where e.shift_id = s.id and e.event_type = 'called_out' order by e.created_at desc limit 1),
         s.series_id, (ov.id is not null), ov.reason, s.makeup_for_shift_id,
         vv.vstatus, vv.worked, (extract(epoch from (s.ends_at - s.starts_at)) / 60)::integer,
         case
           when s.status::text = 'cancelled' then 'cancelled'
           when s.status::text = 'no_show' then 'no_show'
           when vv.vstatus is not null then
             case vv.vstatus
               when 'draft' then 'in_progress'
               when 'awaiting_signature' then 'verification_pending'
               when 'administrator_review' then 'in_review'
               else case when vv.worked is not null and vv.worked < (extract(epoch from (s.ends_at - s.starts_at)) / 60)::integer
                              - (select x.minutes from ogevia.effective_visit_variance_rule(p_organization_id, (s.starts_at at time zone ctx.tz)::date) x limit 1)
                         then 'partial' else 'completed' end
             end
           when s.ends_at < now() then
             case rc.outcome when 'no_service_delivered' then 'not_delivered'
                             when 'delivered_unverified' then 'delivered_not_verified'
                             when 'hold_service_may_have_occurred' then 'awaiting_record'
                             else 'missed' end
           else ogevia.shift_coverage_state(s)
         end,
         rc.outcome
  from ctx
  join ogevia.shifts s on s.organization_id = p_organization_id
  join ogevia.clients c on c.id = s.client_id
  left join ogevia.services sv on sv.id = s.service_id
  left join ogevia.caregiver_records cr on cr.organization_id = s.organization_id and cr.deleted_at is null
    and (cr.id = s.caregiver_record_id or (s.caregiver_record_id is null and cr.linked_user_id = s.caregiver_user_id))
  left join ogevia.client_private_names n on n.client_id = c.id
  -- 0047: the Admin availability override this shift was assigned under, if any (staff who can list shifts see that it happened and why).
  left join lateral (select o.id, o.reason from ogevia.availability_overrides o
                     where o.shift_id = s.id and o.consumed_at is not null order by o.consumed_at desc limit 1) ov on true
  -- 0032: only a reservation still held (a cancelled shift, or one whose visit was signed, holds nothing).
  left join ogevia.authorization_reservations r on r.shift_id = s.id and r.released_at is null
  -- 0075: the visit on this shift (never a voided or corrected one) and the latest reconciliation decision, so a past shift says what happened
  left join lateral (select v.status::text as vstatus, v.worked_minutes as worked from ogevia.service_visits v
                     where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected') order by v.created_at desc limit 1) vv on true
  left join lateral (select x.outcome from ogevia.shift_reconciliations x where x.shift_id = s.id order by x.decided_at desc limit 1) rc on true
  where ctx.actor is not null and ctx.can_list
    and p_from is not null and p_to is not null and p_to >= p_from and p_to - p_from <= 62
    and (s.starts_at at time zone ctx.tz)::date between p_from and p_to
    and (p_client_id is null or s.client_id = p_client_id)
  order by s.starts_at, c.client_code;
$$;
revoke all on function ogevia_api.list_shifts(uuid, date, date, uuid) from public;
grant execute on function ogevia_api.list_shifts(uuid, date, date, uuid) to ogevia_app;
