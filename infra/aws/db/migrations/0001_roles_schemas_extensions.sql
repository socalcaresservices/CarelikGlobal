-- ogevia:run-as=admin
-- 0001 - Roles, schemas, extensions.
--
-- Runs as the connecting administrator (RDS master user locally: the test
-- superuser). Every later migration runs as ogevia_owner (see scripts/migrate.ts),
-- so every schema object is owned by a NOLOGIN owner role, never by a login.
--
-- Roles (cluster-wide, created once, never given passwords here):
--   ogevia_owner    NOLOGIN. Owns all objects. SECURITY DEFINER functions run as it.
--   ogevia_app      NOLOGIN here. Application runtime. EXECUTE on ogevia_api only;
--                   no table privileges. LOGIN + credential/IAM auth are granted at
--                   deploy time, outside Git (docs/aws/PHASE_2_POSTGRES_ARCHITECTURE.md).
--   ogevia_readonly NOLOGIN. Read-only support/verification. SELECT only.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ogevia_owner') then
    create role ogevia_owner nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'ogevia_app') then
    create role ogevia_app nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'ogevia_readonly') then
    create role ogevia_readonly nologin;
  end if;
end
$$;

-- The migrating administrator must be able to SET ROLE ogevia_owner.
do $$
begin
  if not pg_has_role(current_user, 'ogevia_owner', 'MEMBER') then
    execute format('grant ogevia_owner to %I', current_user);
  end if;
end
$$;

-- Extensions are created by the administrator (rds_superuser on RDS).
-- btree_gist: the exclusion constraint that forbids overlapping CURRENT
-- authorizations. (Random values use core gen_random_uuid(); no pgcrypto.)
create extension if not exists btree_gist;

create schema if not exists ogevia authorization ogevia_owner;
create schema if not exists ogevia_api authorization ogevia_owner;

-- Nothing is reachable through PUBLIC.
revoke all on schema ogevia from public;
revoke all on schema ogevia_api from public;
revoke create on schema public from public;

-- Functions are EXECUTE-able by PUBLIC by default in PostgreSQL. Turn that off
-- for everything ogevia_owner creates; 0008 grants EXECUTE explicitly.
alter default privileges for role ogevia_owner revoke execute on functions from public;
