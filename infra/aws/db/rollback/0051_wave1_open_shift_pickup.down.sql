-- ROLLBACK 0051_wave1_open_shift_pickup | CLASS: SAFE AUTOMATED (functions only; no tables or records removed)
-- Drops pickup_open_shift and list_open_shifts. Shifts already picked up keep their caregiver; their coverage events and audit
-- entries stay (they are ordinary reassignment events). Nothing is released or changed in any reservation.
drop function ogevia_api.pickup_open_shift(uuid, uuid, uuid);
drop function ogevia_api.list_open_shifts(uuid);
