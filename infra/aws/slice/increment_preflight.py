#!/usr/bin/env python3
"""Preflight and post-check helpers for the 1a39dd5 increment (standard library only).

Sub-commands (each prints its result and exits 0 = OK, 1 = not OK):

  routes   LIVE_ROUTES AUTHORIZERS INTEGRATIONS SRC
           Classifies the live API as PILOT-BASE (exactly the pilot route set),
           INCREMENT (exactly the 1a39dd5 set) or UNEXPECTED, and verifies the
           authorisation of every route: the approved public routes have no
           authorizer, every other route uses the API's single JWT authorizer
           (issuer = the Ogevia user pool, audience includes the configured
           app client), and every route targets the single integration.
  schema   LEDGER_VERSION FUNCTIONS COLUMNS EXPECTED_DIR
           Live function bodies (normalised) and columns must equal the
           fingerprints generated from the pinned migrations at that version.
  audit-sql EXPECTED_DIR N
           The fingerprint of the audit rows with id <= N (the rows that existed
           at the baseline), same columns as the snapshot.
  snapshot-sql EXPECTED_DIR
           Prints the SQL that fingerprints the VALUES of every existing row of
           every 0018 table (all 0018 columns, timestamps in UTC), plus the
           full permission rows and the audit-log prefix.
  compare  BEFORE AFTER EXPECTED_DIR
           Every table identical; permissions and role_permissions equal the
           baseline plus exactly the rows 0019-0021 add; audit rows that
           existed before are unchanged (new audit rows are allowed).
  decide   FACTS_JSON
           The recovery decision table; prints FRESH / RESUME / COMPLETE or
           STOP with the reason.
"""
import json
import os
import re
import sys

POOL = "us-west-2_849AYz5J7"
ISSUER = "https://cognito-idp.us-west-2.amazonaws.com/" + POOL


def out(ok, text):
    print(text)
    sys.exit(0 if ok else 1)


def routes(live_path, auth_path, integ_path, src):
    sys.path.insert(0, os.path.join(src, "infra/aws/slice"))
    from increment_diff_gate import NEW_ROUTES  # noqa: E402
    from smoke import APPROVED_PUBLIC_ROUTE_KEYS  # noqa: E402
    live = json.load(open(live_path))
    auths = json.load(open(auth_path))
    integs = json.load(open(integ_path))
    code = set(re.findall(r'^  "((?:GET|POST) /v1/[^"]*)": \{', open(os.path.join(src, "apps/sv-api/src/routes.ts")).read(), re.M))
    pilot = code - set(NEW_ROUTES)
    keys = {r["RouteKey"] for r in live}
    state = "PILOT-BASE" if keys == pilot else "INCREMENT" if keys == code else "UNEXPECTED"
    problems = []
    if len(keys) != len(live):
        problems.append("duplicate route keys")
    client = re.search(r'appClientId:\s*"([a-z0-9]{26})"', open(os.path.join(src, "infra/aws/lib/config.ts")).read())
    jwt = [a for a in auths if a.get("AuthorizerType") == "JWT"]
    if len(auths) != 1 or len(jwt) != 1:
        problems.append("expected exactly one JWT authorizer, found %d authorizers" % len(auths))
    else:
        cfg = jwt[0].get("JwtConfiguration") or {}
        if cfg.get("Issuer") != ISSUER:
            problems.append("authorizer issuer is not the Ogevia user pool")
        aud = cfg.get("Audience") or []
        if not client or client.group(1) not in aud or len(aud) > 2:
            problems.append("authorizer audience is not the configured app clients")
    if len(integs) != 1:
        problems.append("expected exactly one integration, found %d" % len(integs))
    auth_id = jwt[0]["AuthorizerId"] if len(jwt) == 1 else None
    target = "integrations/" + integs[0]["IntegrationId"] if len(integs) == 1 else None
    for r in live:
        k = r["RouteKey"]
        if k in APPROVED_PUBLIC_ROUTE_KEYS:
            if r.get("AuthorizationType", "NONE") != "NONE" or r.get("AuthorizerId"):
                problems.append("%s should be public" % k)
        elif r.get("AuthorizationType") != "JWT" or r.get("AuthorizerId") != auth_id:
            problems.append("%s is not protected by the JWT authorizer" % k)
        if r.get("Target") != target:
            problems.append("%s does not target the single integration" % k)
    detail = "%s: %d live routes (pilot set %d, 1a39dd5 set %d); unknown: %s; missing pilot routes: %s; authorisation: %s" % (
        state, len(keys), len(pilot), len(code), sorted(keys - code) or "none", sorted(pilot - keys) or "none",
        "; ".join(problems[:5]) + (" (+%d more)" % (len(problems) - 5) if len(problems) > 5 else "") if problems else "OK")
    out(not problems and state != "UNEXPECTED", detail)


def schema(version, fn_path, col_path, exp):
    problems = []
    for kind, path in (("functions", fn_path), ("columns", col_path)):
        f = os.path.join(exp, "%s-%s.txt" % (kind, version))
        if not os.path.exists(f):
            out(False, "no expected %s fingerprint for ledger %s" % (kind, version))
        want = set(open(f).read().split("\n")) - {""}
        got = set(open(path).read().split("\n")) - {""}
        if want != got:
            names = sorted({line.split(" ")[0] for line in want ^ got})
            problems.append("%s differ from migrations 0001-%s: %s%s" % (kind, version, ", ".join(names[:6]), " ..." if len(names) > 6 else ""))
    out(not problems, "; ".join(problems) or "functions and columns equal migrations 0001-%s exactly" % version)


def snapshot_sql(exp):
    cols = {}
    for line in open(os.path.join(exp, "columns-0018.txt")).read().split("\n"):
        if line.startswith("ogevia."):
            table, col = line.split(" ")[0].split(".")[1:3]
            cols.setdefault(table, []).append(col)
    special = {"audit_events", "role_permissions", "permissions"}
    parts = []
    for t in sorted(cols):
        if t in special:
            continue
        obj = ", ".join("'%s', t.%s" % (c, c) for c in sorted(cols[t]))
        parts.append("select 'table %s ' || count(*) || ' ' || coalesce(md5(string_agg(h, ',' order by h)), '-') "
                     "from (select md5(jsonb_build_object(%s)::text) h from ogevia.%s t) x" % (t, obj, t))
    a = ", ".join("'%s', t.%s" % (c, c) for c in sorted(cols["audit_events"]))
    parts.append("select 'audit ' || coalesce(max(id), 0) || ' ' || coalesce(md5(string_agg(md5(jsonb_build_object(%s)::text), ',' order by id)), '-') from ogevia.audit_events t" % a)
    parts.append("select 'rp ' || role::text || ' ' || permission_key from ogevia.role_permissions")
    parts.append("select 'perm ' || key from ogevia.permissions")
    print("set timezone to 'UTC';\n" + "\nunion all\n".join(parts) + ";")


def audit_sql(exp, n):
    cols = sorted(line.split(" ")[0].split(".")[2] for line in open(os.path.join(exp, "columns-0018.txt")).read().split("\n")
                  if line.startswith("ogevia.audit_events."))
    a = ", ".join("'%s', t.%s" % (c, c) for c in cols)
    print("set timezone to 'UTC';\nselect coalesce(md5(string_agg(md5(jsonb_build_object(%s)::text), ',' order by id)), '-') "
          "from ogevia.audit_events t where id <= %d;" % (a, int(n)))


def compare(before_path, after_path, exp, audit_after_path=None):
    b = [l for l in open(before_path).read().split("\n") if l]
    a = [l for l in open(after_path).read().split("\n") if l]
    pick = lambda rows, p: sorted(r for r in rows if r.startswith(p))
    problems = []
    tb, ta = dict(r.split(" ", 2)[1:] for r in pick(b, "table ")), dict(r.split(" ", 2)[1:] for r in pick(a, "table "))
    for t in sorted(tb):
        if ta.get(t) != tb[t]:
            problems.append("%s changed (before %s, after %s)" % (t, tb[t].split(" ")[0] + " rows", (ta.get(t) or "missing").split(" ")[0] + " rows"))
    add_rp = {"rp " + l for l in open(os.path.join(exp, "role-permissions-added-0019-0021.txt")).read().split("\n") if l}
    add_pk = {"perm " + l for l in open(os.path.join(exp, "permissions-added-0019-0021.txt")).read().split("\n") if l}
    if set(pick(a, "rp ")) != set(pick(b, "rp ")) | add_rp:
        problems.append("role permissions are not the baseline plus exactly the 0019-0021 additions")
    if set(pick(a, "perm ")) != set(pick(b, "perm ")) | add_pk:
        problems.append("permissions are not the baseline plus exactly the 0019-0021 additions")
    ab = pick(b, "audit ")[0].split(" ")
    if audit_after_path:
        lines = [l for l in open(audit_after_path).read().split("\n") if l and l != "SET"]
        prefix = lines[-1] if lines else ""
        if prefix != ab[2]:
            problems.append("audit rows that existed before (ids 1-%s) changed" % ab[1])
    out(not problems, "; ".join(problems) or
        "every existing row of %d tables unchanged (all columns, by value); permissions = baseline + the %d rows 0019-0021 add; the %s earlier audit rows unchanged" % (
            len(tb), len(add_rp), ab[1]))


# Supported recovery states for a run that already exists (see increment-preflight.sh).
def decide(facts_path):
    f = json.load(open(facts_path))
    pin = f["pin"]
    if f["changed_checksums"]:
        out(False, "STOP: an applied migration differs from the repository (%s)" % f["changed_checksums"])
    if not f["test_database"]:
        out(False, "STOP: the API is not on the TEST database or the database holds other agencies (%s)" % f["test_database_detail"])
    if not f["schema_ok"]:
        out(False, "STOP: database objects differ from the migrations (%s)" % f["schema_detail"])
    if not f["routes_ok"]:
        out(False, "STOP: API routes or their authorisation are not as expected (%s)" % f["routes_detail"])
    if f["lambda"] == "UNKNOWN" or f["web"] == "UNKNOWN":
        out(False, "STOP: Lambda %s, web %s: cannot be verified (%s)" % (f["lambda"], f["web"], f["evidence_detail"]))
    ledger, routes, lam, web, steps = f["ledger"], f["routes"], f["lambda"], f["web"], set(f["steps"])
    base = ledger == "0018" and routes == "PILOT-BASE" and lam == "PILOT" and web == "PILOT"
    if not f["run_exists"]:
        if base:
            out(True, "FRESH: exactly the pilot base (ledger 0001-0018 with matching checksums and functions, the 38 pilot routes "
                      "correctly protected, the pilot Lambda code and the pilot web build on the TEST database)")
        out(False, "STOP: no increment run here, but the live state is not the pilot base (ledger %s, routes %s, Lambda %s, web %s; %s). "
                   "Something changed outside this workflow" % (ledger, routes, lam, web, f["evidence_detail"]))
    if f["approved_commit"] not in ("", pin):
        out(False, "STOP: the existing run was approved for commit %s, not %s" % (f["approved_commit"], pin))
    if not f["baseline"]:
        out(False, "STOP: the existing run has no preflight baseline of the records, so it cannot be verified")
    if "complete" in steps:
        if ledger == "0021" and routes == "INCREMENT" and lam == "BUILD" and web == "BUILD":
            out(True, "COMPLETE: the run finished; live state matches it")
        if ledger == "0021" and routes == "INCREMENT" and lam == "TEMPLATE" and web == "BUILD":
            out(True, "RESUME: the run finished; the build output is not on disk, so the run re-builds and re-verifies it")
        out(False, "STOP: the run says complete but live is ledger %s, routes %s, Lambda %s, web %s" % (ledger, routes, lam, web))
    if "migrate-started" not in steps:
        if base:
            out(True, "RESUME: the run stopped before the database window; live is still exactly the pilot base")
    elif "db-window" not in steps:
        if ledger in ("0018", "0019", "0020", "0021") and routes == "PILOT-BASE" and lam == "PILOT" and web == "PILOT":
            out(True, "RESUME: the run stopped inside the database window at ledger %s; API and web still the pilot base" % ledger)
    elif "api-deployed" not in steps:
        if ledger == "0021" and web == "PILOT" and ((routes == "PILOT-BASE" and lam == "PILOT") or (routes == "INCREMENT" and lam in ("BUILD", "TEMPLATE"))):
            out(True, "RESUME: database at 0021; API %s; web still the pilot build" % ("not yet updated" if lam == "PILOT" else "already updated by CloudFormation"))
    elif "web-deployed" not in steps:
        if ledger == "0021" and routes == "INCREMENT" and lam in ("BUILD", "TEMPLATE") and web in ("PILOT", "BUILD"):
            out(True, "RESUME: database and API done; web %s" % ("not yet updated" if web == "PILOT" else "already updated"))
    elif ledger == "0021" and routes == "INCREMENT" and lam in ("BUILD", "TEMPLATE") and web == "BUILD":
        out(True, "RESUME: everything deployed; the run continues with its live verification")
    out(False, "STOP: the run's completed steps (%s) do not match the live state (ledger %s, routes %s, Lambda %s, web %s); "
               "this is not a supported recovery state" % (" ".join(sorted(steps)) or "none", ledger, routes, lam, web))


if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    {"routes": routes, "schema": schema, "snapshot-sql": snapshot_sql, "audit-sql": audit_sql, "compare": compare, "decide": decide}[cmd](*args)
