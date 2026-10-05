#!/usr/bin/env python3
"""Record-value checks for release 0027-0034 (standard library only).

  snapshot-sql EXPECTED_DIR
      SQL fingerprinting the VALUES of every existing row of every table that
      exists at 0026, over every 0026 column (timestamps in UTC; columns that
      0027-0034 add are not part of it), plus every permission and
      role-permission row and the audit log (count, max id, hash).
  audit-sql EXPECTED_DIR N
      Fingerprint of the audit rows with id <= N (the rows before the release).
  compare BEFORE AFTER EXPECTED_DIR AUDIT_PREFIX
      Every table identical by value; permissions and role permissions equal the
      baseline plus EXACTLY the rows 0027-0034 add; the earlier audit rows are
      unchanged (new audit rows are allowed). Exit 0 = unchanged, 1 = changed.
"""
import os
import sys


def cols(exp):
    out = {}
    for line in open(os.path.join(exp, "columns-0026.txt")).read().split("\n"):
        if line.startswith("ogevia."):
            t, c = line.split(" ")[0].split(".")[1:3]
            out.setdefault(t, []).append(c)
    return out


def snapshot_sql(exp):
    c = cols(exp)
    parts = []
    for t in sorted(c):
        if t in ("audit_events", "role_permissions", "permissions"):
            continue
        obj = ", ".join("'%s', t.%s" % (x, x) for x in sorted(c[t]))
        parts.append("select 'table %s ' || count(*) || ' ' || coalesce(md5(string_agg(h, ',' order by h)), '-') "
                     "from (select md5(jsonb_build_object(%s)::text) h from ogevia.%s t) x" % (t, obj, t))
    a = ", ".join("'%s', t.%s" % (x, x) for x in sorted(c["audit_events"]))
    parts.append("select 'audit ' || coalesce(max(id), 0) || ' ' || coalesce(md5(string_agg(md5(jsonb_build_object(%s)::text), ',' order by id)), '-') "
                 "from ogevia.audit_events t" % a)
    parts.append("select 'rp ' || role::text || ' ' || permission_key from ogevia.role_permissions")
    parts.append("select 'perm ' || key from ogevia.permissions")
    print("set timezone to 'UTC';\n" + "\nunion all\n".join(parts) + ";")


def audit_sql(exp, n):
    a = ", ".join("'%s', t.%s" % (x, x) for x in sorted(cols(exp)["audit_events"]))
    print("set timezone to 'UTC';\nselect coalesce(md5(string_agg(md5(jsonb_build_object(%s)::text), ',' order by id)), '-') "
          "from ogevia.audit_events t where id <= %d;" % (a, int(n)))


def compare(before, after, exp, audit_prefix):
    lines = lambda p: [l for l in open(p).read().split("\n") if l and l != "SET"]
    b, a = lines(before), lines(after)
    pick = lambda rows, p: sorted(r for r in rows if r.startswith(p))
    tb = dict(r.split(" ", 2)[1:] for r in pick(b, "table "))
    ta = dict(r.split(" ", 2)[1:] for r in pick(a, "table "))
    problems = ["%s changed (rows %s -> %s)" % (t, tb[t].split(" ")[0], (ta.get(t) or "missing").split(" ")[0])
                for t in sorted(tb) if ta.get(t) != tb[t]]
    read = lambda f, p: {p + l for l in open(os.path.join(exp, f)).read().split("\n") if l}
    add_rp = read("role-permissions-added-0027-0034.txt", "rp ")
    add_pk = read("permissions-added-0027-0034.txt", "perm ")
    if set(pick(a, "rp ")) != set(pick(b, "rp ")) | add_rp:
        problems.append("role permissions are not the baseline plus exactly the 0027-0034 additions")
    if set(pick(a, "perm ")) != set(pick(b, "perm ")) | add_pk:
        problems.append("permissions are not the baseline plus exactly the 0027-0034 additions")
    ab = pick(b, "audit ")[0].split(" ")
    pref = lines(audit_prefix)
    if not pref or pref[-1] != ab[2]:
        problems.append("audit rows that existed before (ids 1-%s) changed" % ab[1])
    print("; ".join(problems) if problems else
          "every existing row of %d tables unchanged (all 0026 columns, by value); permissions = baseline + the %d role and %d "
          "permission rows 0027-0034 add; the %s earlier audit rows unchanged" % (len(tb), len(add_rp), len(add_pk), ab[1]))
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    {"snapshot-sql": snapshot_sql, "audit-sql": audit_sql, "compare": compare}[cmd](*args)
