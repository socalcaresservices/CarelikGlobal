#!/usr/bin/env python3
"""Checks the sanitized TEST inventory (TEST_INVENTORY.sh output directory) against what this release was prepared for. Read-only; no AWS.
   python3 check_inventory.py <inventory-dir>     exit 0 only if every check passes. Each line: PASS or FAIL name: detail."""
import json, pathlib, sys

TEST_HOST = "ogevia-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com"      # ISOLATED_TEST_TARGET in infra/aws/lib/config.ts
PROD_HOST = "ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com"
EXPECT_ROUTES = 259          # TEST today (switch OFF); verified by CDK synthesis for the isolated TEST configuration
NEW_ROUTES = {"POST /v1/care-notifications/read", "POST /v1/documents/{documentId}/cancel", "POST /v1/document-types/{documentTypeId}/retire"}
SETTLED = {"CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"}


def load(d, name):
    p = pathlib.Path(d) / name
    return json.loads(p.read_text()) if p.is_file() else None


def routes_of(template):
    return sorted((r.get("Properties") or {}).get("RouteKey") for r in template["Resources"].values() if r.get("Type") == "AWS::ApiGatewayV2::Route")


def main(d):
    out = []
    def check(name, ok, detail=""):
        out.append((bool(ok), name, detail))
    ident = load(d, "identity.json") or {}
    check("account is 300094796789 in us-west-2", ident.get("account") == "300094796789" and ident.get("region") == "us-west-2", str(ident))
    for label, shown, db, host in (("test", "TEST", "ogevia_sv_test", TEST_HOST), ("production", "production", "ogevia_prd", PROD_HOST)):
        st = load(d, f"{label}-api-stack.json") or {}
        check(f"{shown} API stack settled", st.get("status") in SETTLED, str(st))
        h = load(d, f"{label}-handler.json") or {}
        check(f"{shown} Handler targets {db}", h.get("dbName") == db, f"DB_NAME={h.get('dbName')}")
        check(f"{shown} Handler targets the expected database server", h.get("dbHost") == host, f"DB_HOST={h.get('dbHost')}")
    t, p = load(d, "test-handler.json") or {}, load(d, "production-handler.json") or {}
    check("TEST and production use different databases and servers", t.get("dbName") != p.get("dbName") and t.get("dbHost") != p.get("dbHost"))
    tmpl = load(d, "test-api-template.json")
    if tmpl:
        keys = routes_of(tmpl)
        check(f"TEST template has {EXPECT_ROUTES} routes (switch OFF)", len(keys) == EXPECT_ROUTES, f"{len(keys)} routes")
        check("TEST template has none of the three request-cleanup routes", not (NEW_ROUTES & set(keys)), str(sorted(NEW_ROUTES & set(keys))))
    else:
        check("TEST API template captured", False)
    live = load(d, "test-live-routes.json")
    check(f"TEST live API has {EXPECT_ROUTES} routes", isinstance(live, list) and len(live) >= EXPECT_ROUTES and not (NEW_ROUTES & set(live)),
          f"{len(live) if isinstance(live, list) else 'unreadable'} live route keys (the API also carries the default route)")
    rds = {r["instance"]: r for r in (load(d, "rds.json") or [])}
    for inst in ("ogevia-postgres", "ogevia-prod-postgres"):
        r = rds.get(inst)
        check(f"RDS {inst} exists, available, private", bool(r) and r.get("status") == "available" and r.get("public") is False, str(r))
        check(f"RDS {inst} has backups and encryption", bool(r) and (r.get("backupDays") or 0) >= 1 and r.get("encrypted") is True, str(r and {k: r[k] for k in ("backupDays", "encrypted")}))
    web = load(d, "test-web.json") or {}
    check("TEST site answers 200", web.get("httpCode") == "200", str(web))
    dbi = load(d, "test-db.json") or {}
    if dbi.get("probe") == "not-run":
        check("TEST ledger is 107/0107 and 0109 is absent (database not read)", False, "run again with the PG* variables set through the operator's tunnel")
    else:
        check("TEST ledger is 107/0107", dbi.get("ledger") == "107/0107", str(dbi.get("ledger")))
        check("migration 0109 probe passed (baseline, no 0109 objects)", dbi.get("probe") == "ok", str(dbi.get("probe")))
    for ok, name, detail in out:
        print(("PASS " if ok else "FAIL ") + name + ((": " + detail) if detail and not ok else ""))
    bad = [n for ok, n, _ in out if not ok]
    print(f"{len(out) - len(bad)} of {len(out)} checks pass" + ("" if not bad else "; STOP: the live state is not what this release was prepared for"))
    return 0 if not bad else 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: check_inventory.py <inventory-dir>")
    sys.exit(main(sys.argv[1]))
