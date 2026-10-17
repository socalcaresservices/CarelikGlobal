-- ROLLBACK 0054_attention_streams_appearance | CLASS: BACKUP REQUIRED (drops the two appearance tables; saved appearance choices are lost)
-- Removes the attention-overview, authorizations-missing-rate and appearance functions and tables. No visit, shift, authorization,
-- document, billing or compliance record is touched. Export organization_appearance and user_appearance first if the choices matter.
drop function ogevia_api.list_authorizations_missing_rate(uuid, date);
drop function ogevia_api.get_attention_overview(uuid, integer);
drop function ogevia_api.set_my_appearance(uuid, text, text, text, text, text);
drop function ogevia_api.set_organization_appearance(uuid, text, text, text, text, text);
drop function ogevia_api.get_appearance(uuid);
drop function ogevia.appearance_json(text, text, text, text, text);
drop function ogevia.appearance_system_defaults();
drop table ogevia.user_appearance;
drop table ogevia.organization_appearance;
