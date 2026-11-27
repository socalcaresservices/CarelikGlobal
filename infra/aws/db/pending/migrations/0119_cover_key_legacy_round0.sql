-- 0119 Alert key compatibility: round 0 keeps the ORIGINAL key format.
-- Found on TEST after 0117 (2026-11-24): 0117 gave the open-shift alert key a round suffix (":r0"). Shifts that had already been alerted before 0117 (notifications ON since stage 1) have a notification
-- under the original key "cover:<shift>:<start epoch>", so the first sweep after 0117 alerted them a SECOND time under "...:r0" (two in-app notifications and two queued emails per person and shift).
-- Fix: round 0 uses the original key (so an already-alerted shift is recognised); a replacement call-out (round 1, 2, ...) still gets ":r<n>", so a fresh coverage round still alerts again.
-- Also: text-message dedupe keys are built from the alert key, so existing round-0 text rows ("sms:cover:<shift>:<epoch>:r0:<user>") are re-keyed in step (no live text exists; this only keeps one text per person, shift and round).
-- Not touched: duplicates that already exist (they are history; clean-up, if wanted, is a separate reviewed script). The escalation check (alerts whose key starts with the alert key) matches both old and new alerts.
-- Needs 0117.
create or replace function ogevia.cover_key(p_shift ogevia.shifts)
returns text language sql stable set search_path = ogevia, pg_temp as $$
  -- 0119 legacy key for round 0
  select 'cover:' || p_shift.id::text || ':' || floor(extract(epoch from p_shift.starts_at))::bigint::text
         || case when ogevia.cover_round(p_shift.id) = 0 then '' else ':r' || ogevia.cover_round(p_shift.id)::text end;
$$;
update ogevia.sms_messages set dedupe_key = regexp_replace(dedupe_key, '^(sms:cover:[0-9a-f-]{36}:[0-9]+):r0:', '\1:')
 where dedupe_key ~ '^sms:cover:[0-9a-f-]{36}:[0-9]+:r0:';
