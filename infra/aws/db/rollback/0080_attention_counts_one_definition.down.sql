-- ROLLBACK 0080 | CLASS: SAFE AUTOMATED (functions only; nothing stored changes)
drop function ogevia_api.get_attention_counts(uuid);
drop function ogevia.shift_attention_class(timestamptz, timestamptz);
