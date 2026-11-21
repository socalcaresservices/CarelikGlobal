-- ROLLBACK 0093 | CLASS: BACKUP REQUIRED (drops staff_merge_links with its rows). Profiles that were marked as duplicates stay INACTIVE (set them active again in Staff if needed);
-- the audit events stay. Run only after a verified backup.
drop function if exists ogevia_api.merge_staff_profiles(uuid, uuid, uuid, text);
drop function if exists ogevia_api.list_possible_duplicate_staff(uuid);
drop table if exists ogevia.staff_merge_links;
