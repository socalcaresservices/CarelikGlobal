-- ROLLBACK 0048 | CLASS: SAFE AUTOMATED (no tables or records removed). Removes the account-status functions and the accounts.manage permission.
-- Accounts disabled while 0048 was live STAY disabled (memberships suspended, app users disabled): re-enable them BEFORE rolling back if
-- they should have access, because there is no screen to do it afterwards. Audit history (account.disabled / account.enabled) is kept.
drop function if exists ogevia_api.enable_account(uuid, uuid, text);
drop function if exists ogevia_api.prepare_account_enable(uuid, uuid);
drop function if exists ogevia_api.disable_account(uuid, uuid, text);
drop function if exists ogevia_api.list_accounts(uuid);
drop function if exists ogevia.accounts_manage_guard(uuid);
delete from ogevia.role_permissions where permission_key = 'accounts.manage';
delete from ogevia.permissions where key = 'accounts.manage';
