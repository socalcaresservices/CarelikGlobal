-- ROLLBACK 0028_outage_visit_records | CLASS: SAFE AUTOMATED (refuses when records would be lost)
-- Refuses while any outage visit record (entered or marked not used) exists:
-- the link between paper record numbers and visits must not be lost. The visits
-- themselves are ordinary visits and are never touched by this rollback.
do $$ begin
  if exists (select 1 from ogevia.outage_visit_records) then
    raise exception 'ROLLBACK REFUSED: outage visit records exist; export them first (they would be lost)';
  end if;
end $$;
drop function if exists ogevia_api.list_outage_reconciliation(uuid, boolean);
drop function if exists ogevia_api.mark_outage_number_unused(uuid, integer, text, uuid);
drop function if exists ogevia_api.record_outage_visit(uuid, integer, uuid, uuid, uuid, date, time, time, text, text, text, uuid);
drop function if exists ogevia.outage_number_check(uuid, integer);
drop function if exists ogevia.outage_guard(uuid);
drop table if exists ogevia.outage_visit_records;
