#!/usr/bin/env bash
# LOCAL rehearsal of the SQL part of SNAPSHOT_RESTORE_ISOLATED_3159e52.md (steps E-H) on two throwaway PostgreSQL clusters.
# Cluster LIVE stands for ogevia-prod-postgres (two databases: ogevia_prd and ogevia_sv_test); cluster SNAP stands for the instance restored from the
# snapshot (a physical copy taken before the damage). Nothing here touches AWS or any real database. Run as root (uses runuser -u postgres).
set -uo pipefail
B=/usr/lib/postgresql/16/bin
W=$(mktemp -d /tmp/pgrehearsal.XXXXXX); chown postgres "$W"
LIVE=$W/live; SNAP=$W/snap; LP=54331; SP=54332
pg() { runuser -u postgres -- "$@"; }
fail=0; ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; fail=1; }
q()  { pg "$B/psql" -X -qAt -h "$W" -p "$1" -d "$2" -v ON_ERROR_STOP=1 -c "$3"; }
cleanup() { pg "$B/pg_ctl" -D "$LIVE" -m immediate stop >/dev/null 2>&1; pg "$B/pg_ctl" -D "$SNAP" -m immediate stop >/dev/null 2>&1; rm -rf "$W"; }
trap cleanup EXIT

pg "$B/initdb" -D "$LIVE" -A trust >/dev/null && pg "$B/pg_ctl" -D "$LIVE" -o "-p $LP -k $W -c listen_addresses=''" -w -l "$W/live.log" start >/dev/null || { echo "cannot start LIVE"; exit 2; }
q $LP postgres "create role ogevia_owner nologin; create role app_rw nologin" >/dev/null
q $LP postgres "create database ogevia_prd" >/dev/null
q $LP postgres "create database ogevia_sv_test owner ogevia_owner" >/dev/null
q $LP ogevia_prd "create table donors(id int primary key, v text); insert into donors select g,'prd-'||g from generate_series(1,1000) g;" >/dev/null
q $LP ogevia_sv_test "create table schema_migrations(version text primary key); insert into schema_migrations select lpad(g::text,4,'0') from generate_series(1,52) g; create table visits(id int primary key, v text); insert into visits select g,'v'||g from generate_series(1,200) g; alter table visits owner to ogevia_owner; grant select on visits to app_rw;" >/dev/null
# the "snapshot": a physical copy of the whole cluster taken now (both databases), like an RDS snapshot
pg "$B/pg_basebackup" -h "$W" -p $LP -D "$SNAP" -X stream -c fast >/dev/null 2>&1 || { echo "cannot take base backup"; exit 2; }
# damage after the snapshot: the failed release changes sv_test, and production keeps writing (a restore in place would LOSE these rows)
q $LP ogevia_sv_test "insert into schema_migrations select lpad(g::text,4,'0') from generate_series(53,77) g; drop table visits;" >/dev/null
q $LP ogevia_prd "insert into donors select g,'prd-late-'||g from generate_series(1001,1500) g;" >/dev/null
# restored copy ("new instance"): different port, read-only access
pg "$B/pg_ctl" -D "$SNAP" -o "-p $SP -k $W -c listen_addresses=''" -w -l "$W/snap.log" start >/dev/null || { echo "cannot start SNAP"; exit 2; }

echo "== step D: restored copy ledger (expect 52)"
[[ "$(q $SP ogevia_sv_test 'select count(*) from schema_migrations')" == 52 ]] && ok "restored copy ledger 52" || bad "restored copy ledger"

FP_SQL="select oid, datname, datdba, datacl, datallowconn, datconnlimit, encoding, datcollate from pg_database where datname='ogevia_prd'"
PRD_BEFORE=$(q $LP postgres "$FP_SQL"); ROLES_BEFORE=$(q $LP postgres "select rolname, rolsuper, rolcanlogin from pg_roles where rolname not like 'pg_%' order by 1")
PRD_ROWS_BEFORE=$(q $LP ogevia_prd 'select count(*) from donors')

echo "== step E: dump ONLY ogevia_sv_test from the restored copy"
DUMP=$W/sv_test.dump
pg "$B/pg_dump" -h "$W" -p $SP -d ogevia_sv_test -Fc -f "$DUMP" && ok "dump written" || bad "dump"
pg "$B/pg_restore" -l "$DUMP" | grep -q "dbname: ogevia_sv_test" && ok "dump TOC names ogevia_sv_test" || bad "dump TOC database name"
pg "$B/pg_restore" -l "$DUMP" | grep -q donors && bad "dump contains prd data" || ok "dump contains no ogevia_prd table"
pg "$B/pg_dump" -h "$W" -p $LP -d ogevia_sv_test -Fc -f "$W/damaged.dump" && ok "forensic dump of the damaged live ogevia_sv_test"

swap() { # $1 = dump file, $2 = stamp ; returns non-zero on any failure after restoring the original
  local D=ogevia_sv_test_damaged_$2
  q $LP postgres "alter database ogevia_sv_test allow_connections false" >/dev/null || return 10
  q $LP postgres "select count(pg_terminate_backend(pid)) from pg_stat_activity where datname='ogevia_sv_test' and pid<>pg_backend_pid()" >/dev/null
  q $LP postgres "alter database ogevia_sv_test rename to $D" >/dev/null || return 11
  q $LP postgres "create database ogevia_sv_test owner ogevia_owner template template0" >/dev/null || { q $LP postgres "alter database $D rename to ogevia_sv_test" >/dev/null; q $LP postgres "alter database ogevia_sv_test allow_connections true" >/dev/null; return 12; }
  if ! pg "$B/pg_restore" -h "$W" -p $LP -d ogevia_sv_test --exit-on-error --single-transaction "$1" >"$W/restore.out" 2>&1; then
    q $LP postgres "drop database ogevia_sv_test" >/dev/null
    q $LP postgres "alter database $D rename to ogevia_sv_test" >/dev/null
    q $LP postgres "alter database ogevia_sv_test allow_connections true" >/dev/null
    return 13
  fi
  return 0
}

echo "== failure rehearsal: a restore that fails midway puts the original back"
# emulate a failing pg_restore with a truncated archive
head -c 2000 "$DUMP" > "$W/trunc.dump"
swap "$W/trunc.dump" fail1; rc=$?
[[ $rc == 13 ]] && ok "failing restore refused (rc 13)" || bad "failing restore rc=$rc"
[[ "$(q $LP ogevia_sv_test 'select count(*) from schema_migrations')" == 77 ]] && ok "original (damaged) ogevia_sv_test is back and intact (ledger 77)" || bad "original not restored"
[[ "$(q $LP postgres "select datallowconn from pg_database where datname='ogevia_sv_test'")" == t ]] && ok "connections re-enabled on the original" || bad "connections not re-enabled"
[[ "$(q $LP postgres "select count(*) from pg_database where datname like 'ogevia_sv_test_damaged%'")" == 0 ]] && ok "no leftover databases" || bad "leftover databases"

echo "== steps G-H: the real swap"
swap "$DUMP" 202610180000; rc=$?
[[ $rc == 0 ]] && ok "swap completed" || bad "swap rc=$rc"
[[ "$(q $LP ogevia_sv_test 'select count(*) from schema_migrations')" == 52 && "$(q $LP ogevia_sv_test 'select max(version) from schema_migrations')" == 0052 ]] && ok "ogevia_sv_test ledger is 52 / 0052" || bad "ledger after swap"
[[ "$(q $LP ogevia_sv_test 'select count(*) from visits')" == 200 ]] && ok "visits table restored (200 rows)" || bad "visits"
[[ "$(q $LP ogevia_sv_test "select relowner::regrole from pg_class where relname='visits'")" == ogevia_owner ]] && ok "object owner preserved" || bad "owner"
[[ "$(q $LP ogevia_sv_test "select has_table_privilege('app_rw','visits','select')")" == t ]] && ok "grant preserved" || bad "grant"
[[ "$(q $LP postgres "select datallowconn from pg_database where datname='ogevia_sv_test'")" == t ]] && ok "new ogevia_sv_test accepts connections" || bad "new database not connectable"
[[ "$(q $LP postgres "select datallowconn from pg_database where datname='ogevia_sv_test_damaged_202610180000'")" == f ]] && ok "damaged copy retained, connections disabled (not dropped)" || bad "damaged copy state"
echo "== ogevia_prd protection (catalog-only checks from the postgres database; ogevia_prd is never connected to by the swap)"
[[ "$(q $LP postgres "$FP_SQL")" == "$PRD_BEFORE" ]] && ok "pg_database row for ogevia_prd identical before and after" || bad "ogevia_prd catalog row changed"
[[ "$(q $LP postgres "select rolname, rolsuper, rolcanlogin from pg_roles where rolname not like 'pg_%' order by 1")" == "$ROLES_BEFORE" ]] && ok "cluster roles identical" || bad "roles changed"
PRD_ROWS_AFTER=$(q $LP ogevia_prd 'select count(*) from donors')
[[ "$PRD_ROWS_AFTER" == 1500 && "$PRD_ROWS_AFTER" == "$PRD_ROWS_BEFORE" ]] && ok "ogevia_prd keeps its post-snapshot rows (1500; an in-place restore would have reverted it to 1000)" || bad "ogevia_prd rows $PRD_ROWS_BEFORE -> $PRD_ROWS_AFTER"
[[ "$(q $SP ogevia_prd 'select count(*) from donors')" == 1000 ]] && ok "the restored copy holds the OLD ogevia_prd (1000 rows): proof that the snapshot must never be restored in place" || bad "snap prd"
echo; [[ $fail == 0 ]] && echo "REHEARSAL PASSED (local, PostgreSQL 16, two throwaway clusters)" || echo "REHEARSAL FAILED"
exit $fail
