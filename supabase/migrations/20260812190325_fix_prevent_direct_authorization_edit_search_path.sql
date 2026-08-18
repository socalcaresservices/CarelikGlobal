create or replace function public.prevent_direct_authorization_edit()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if NEW.max_monthly_hours is distinct from OLD.max_monthly_hours
     or NEW.period_start is distinct from OLD.period_start
     or NEW.period_end is distinct from OLD.period_end
     or NEW.payer is distinct from OLD.payer
     or NEW.authorization_number is distinct from OLD.authorization_number
     or NEW.notes is distinct from OLD.notes
     or NEW.client_id is distinct from OLD.client_id
     or NEW.service_id is distinct from OLD.service_id
  then
    raise exception 'Authorization terms cannot be edited directly - use amend_client_authorization() to record a new version';
  end if;
  return NEW;
end;
$$;
