-- ADMIN PROCEDURE: correct a caregiver's INVITATION email before their first sign-in. One transaction in the Ogevia database; the sign-in account (Cognito) is changed by the operator script around it.
--   psql -X -At -v ON_ERROR_STOP=1 -v org_slug=<optional> -v caregiver_code=<code> -v old_email=<current invited address> -v new_email=<corrected address> -v cognito_sub=<the account's sub> -v reason=<text> -f CORRECT_INVITATION_EMAIL.sql
-- Guards (all must hold or nothing changes): exactly one caregiver has that code; an invitation exists, is for a NEW account (not an existing one), and has never been signed in; the stored invitation email equals old_email;
-- the invitation's user is the one linked to the caregiver and has the stated sub; the new address is valid, differs from the old one, and is not used by another caregiver's invitation or contact.
-- Effects: invitation email replaced (send count +1), the caregiver's contact email set to the same address (through the app's own set_caregiver_contact, acting as the agency's single active owner), and one audit event
-- `caregiver_invitation.email_corrected` with the old and new address and the reason. Nothing else is touched.
\set ON_ERROR_STOP on
begin;
set local lock_timeout = '15s';
set local statement_timeout = '60s';
select pg_advisory_xact_lock(4317112);
select set_config('fix.org_slug', :'org_slug', true), set_config('fix.code', :'caregiver_code', true), set_config('fix.old', :'old_email', true), set_config('fix.new', :'new_email', true),
       set_config('fix.sub', :'cognito_sub', true), set_config('fix.reason', :'reason', true) \gset
do $fix$
declare
  v_org uuid; v_rec uuid; v_inv ogevia.caregiver_invitations%rowtype; v_sub text; v_linked uuid; v_owners int; v_owner_sub text;
  v_old text := lower(btrim(current_setting('fix.old'))); v_new text; v_reason text := btrim(current_setting('fix.reason')); v_n int;
begin
  if length(v_reason) < 5 or length(v_reason) > 500 then raise exception 'Give a reason (5 to 500 characters)'; end if;
  select count(*), min(r.organization_id::text)::uuid, min(r.id::text)::uuid into v_n, v_org, v_rec
    from ogevia.caregiver_records r join ogevia.organizations o on o.id = r.organization_id
   where r.caregiver_code = current_setting('fix.code') and r.deleted_at is null and (nullif(current_setting('fix.org_slug'), '') is null or o.slug = current_setting('fix.org_slug'));
  if v_n <> 1 then raise exception 'Expected exactly one caregiver with that code, found % (pass org_slug if several agencies)', v_n; end if;
  select * into v_inv from ogevia.caregiver_invitations i where i.organization_id = v_org and i.caregiver_record_id = v_rec;
  if v_inv.id is null then raise exception 'This caregiver has not been invited: use Send sign-in link in the app'; end if;
  if v_inv.first_signed_in_at is not null then raise exception 'This caregiver has already signed in: they use Forgot password, not this procedure'; end if;
  if v_inv.existing_account then raise exception 'This caregiver already had a sign-in account: this procedure is only for accounts created by the invitation'; end if;
  if lower(v_inv.email) <> v_old then raise exception 'The stored invitation email is not the one you stated: nothing changed'; end if;
  select u.cognito_sub, r.linked_user_id into v_sub, v_linked from ogevia.app_users u join ogevia.caregiver_records r on r.id = v_rec where u.id = v_inv.user_id;
  if v_linked is distinct from v_inv.user_id then raise exception 'The invitation user is not the one linked to this caregiver: nothing changed'; end if;
  if v_sub is distinct from current_setting('fix.sub') then raise exception 'The sign-in account does not match the one stated: nothing changed'; end if;
  v_new := ogevia.normalize_invitation_email(current_setting('fix.new'));
  if v_new = v_old then raise exception 'The new address is the same as the current one'; end if;
  if exists (select 1 from ogevia.caregiver_invitations i where i.organization_id = v_org and lower(i.email) = v_new and i.caregiver_record_id <> v_rec)
     or exists (select 1 from ogevia.caregiver_contacts c where c.organization_id = v_org and lower(c.contact_email) = v_new and c.caregiver_record_id <> v_rec) then
    raise exception 'That address is already used by another caregiver: nothing changed';
  end if;
  select count(*), min(u.cognito_sub) into v_owners, v_owner_sub from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id
   where m.organization_id = v_org and m.role = 'organization_owner' and m.status = 'active' and u.status = 'active' and u.cognito_sub is not null;
  if v_owners <> 1 then raise exception 'Expected exactly one active agency owner to act as, found %', v_owners; end if;
  perform ogevia_api.begin_request(v_owner_sub, gen_random_uuid());
  update ogevia.caregiver_invitations set email = v_new, last_sent_at = now(), send_count = send_count + 1 where id = v_inv.id;
  perform ogevia_api.set_caregiver_contact(v_org, v_rec, v_new, null, null);
  perform ogevia.write_audit(v_org, 'caregiver_invitation.email_corrected', 'caregiver_invitations', v_inv.id,
    jsonb_build_object('email', v_old), jsonb_build_object('email', v_new), v_reason);
  raise notice 'CORRECTED: the invitation and the contact email for caregiver % now use the corrected address; one audit event written.', current_setting('fix.code');
end
$fix$;
commit;
