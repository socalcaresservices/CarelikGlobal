-- Rollback of 0119: the 0117 key (always with the round suffix) and its text keys. Run in one transaction as ogevia_owner.
create or replace function ogevia.cover_key(p_shift ogevia.shifts)
returns text language sql stable set search_path = ogevia, pg_temp as $$
  select 'cover:' || p_shift.id::text || ':' || floor(extract(epoch from p_shift.starts_at))::bigint::text || ':r' || ogevia.cover_round(p_shift.id)::text;
$$;
update ogevia.sms_messages set dedupe_key = regexp_replace(dedupe_key, '^(sms:cover:[0-9a-f-]{36}:[0-9]+):([0-9a-f-]{36})$', '\1:r0:\2')
 where dedupe_key ~ '^sms:cover:[0-9a-f-]{36}:[0-9]+:[0-9a-f-]{36}$';
