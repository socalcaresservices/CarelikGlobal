#!/usr/bin/env python3
"""Self-test of increment_preflight.py decide and lambda-policy (standard library only).

Every supported state must be accepted with the expected decision; every listed
deviation from it must STOP. Run: python3 increment_preflight_selftest.py
"""
import copy
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = [sys.executable, os.path.join(HERE, "increment_preflight.py")]
PIN, ORIG = "69e8799c7a39405d551fa49e1e9cd4a025ae7ea0", "1a39dd59fddd48d5c4e57a815331487a979e4b0b"
OLD_STEPS = ["approved", "db-window", "migrate-started", "rollback-captured", "snapshot", "tests-" + ORIG]

# The state the failed 1a39dd5 run is known to leave.
RECOVERY = dict(pin=PIN, changed_checksums="", test_database=True, test_database_detail="", schema_ok=True, schema_detail="",
                routes_ok=True, routes_detail="", ledger="0021", routes="PILOT-BASE", **{"lambda": "PILOT"}, web="PILOT",
                evidence_detail="", run_exists=False, steps=[], approved_commit="", baseline=True, policy="ROUTE-SCOPED",
                policy_detail="", api_status="UPDATE_ROLLBACK_COMPLETE", admin_ok=True, admin_detail="", old_run_exists=True,
                old_steps=OLD_STEPS, old_approved_commit=ORIG, old_snapshot_ok=True, records_ok=True, records_detail="ok",
                orig_pin=ORIG, recovery=False)


def decide(facts):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(facts, f)
    r = subprocess.run(TOOL + ["decide", f.name], capture_output=True, text=True)
    os.unlink(f.name)
    return r.returncode, r.stdout.strip()


def v(base, **kw):
    f = copy.deepcopy(base)
    f.update(kw)
    return f


ACCEPT = [
    ("recovery state", RECOVERY, "RECOVER"),
    ("fresh pilot base", v(RECOVERY, old_run_exists=False, old_steps=[], old_approved_commit="", ledger="0018",
                           api_status="UPDATE_COMPLETE", records_ok=False), "FRESH"),
]
V2 = v(RECOVERY, run_exists=True, recovery=True, approved_commit=PIN)
ACCEPT += [
    ("v2 before DB window", v(V2, steps=["approved", "snapshot"]), "RESUME"),
    ("v2 inside DB window", v(V2, steps=["approved", "migrate-started"]), "RESUME"),
    ("v2 DB done, API failed", v(V2, steps=["approved", "migrate-started", "db-window"]), "RESUME"),
    ("v2 DB done, API updated", v(V2, steps=["migrate-started", "db-window"], routes="INCREMENT", policy="SINGLE",
                                  api_status="UPDATE_COMPLETE", **{"lambda": "BUILD"}), "RESUME"),
    ("v2 API done, web pending", v(V2, steps=["migrate-started", "db-window", "api-deployed"], routes="INCREMENT",
                                   policy="SINGLE", api_status="UPDATE_COMPLETE", **{"lambda": "BUILD"}), "RESUME"),
    ("v2 complete", v(V2, steps=["migrate-started", "db-window", "api-deployed", "web-deployed", "complete"],
                      routes="INCREMENT", policy="SINGLE", api_status="UPDATE_COMPLETE", web="BUILD", **{"lambda": "BUILD"}), "COMPLETE"),
]
REFUSE = [
    ("checksum changed", v(RECOVERY, changed_checksums="0020")),
    ("not the TEST database", v(RECOVERY, test_database=False)),
    ("objects differ", v(RECOVERY, schema_ok=False)),
    ("route authorisation", v(RECOVERY, routes_ok=False)),
    ("Lambda unknown", v(RECOVERY, **{"lambda": "UNKNOWN"})),
    ("web unknown", v(RECOVERY, web="UNKNOWN")),
    ("stack rollback failed", v(RECOVERY, api_status="UPDATE_ROLLBACK_FAILED")),
    ("stack in progress", v(RECOVERY, api_status="UPDATE_IN_PROGRESS")),
    ("stack not rolled back", v(RECOVERY, api_status="UPDATE_COMPLETE")),
    ("policy other", v(RECOVERY, policy="OTHER")),
    ("policy already single", v(RECOVERY, policy="SINGLE")),
    ("admin groups", v(RECOVERY, admin_ok=False)),
    ("ledger 0020", v(RECOVERY, ledger="0020")),
    ("ledger 0018", v(RECOVERY, ledger="0018")),
    ("routes increment", v(RECOVERY, routes="INCREMENT")),
    ("Lambda other", v(RECOVERY, **{"lambda": "OTHER"})),
    ("web other", v(RECOVERY, web="OTHER")),
    ("old run other commit", v(RECOVERY, old_approved_commit="0" * 40)),
    ("old run API deployed", v(RECOVERY, old_steps=OLD_STEPS + ["api-deployed"])),
    ("old run before DB window", v(RECOVERY, old_steps=["approved", "snapshot"])),
    ("snapshot missing", v(RECOVERY, old_snapshot_ok=False)),
    ("no baseline", v(RECOVERY, baseline=False)),
    ("records differ", v(RECOVERY, records_ok=False)),
    ("v2 other commit", v(V2, approved_commit="0" * 40, steps=["approved"])),
    ("v2 marker without old run", v(V2, old_approved_commit="", steps=["approved"])),
    ("v2 non-recovery at 0021 before window", v(V2, recovery=False, steps=["approved"])),
    ("v2 API done but pilot policy", v(V2, steps=["migrate-started", "db-window", "api-deployed"], routes="INCREMENT",
                                       policy="ROUTE-SCOPED", **{"lambda": "BUILD"})),
    ("v2 complete, web pilot", v(V2, steps=["migrate-started", "db-window", "api-deployed", "web-deployed", "complete"],
                                 routes="INCREMENT", policy="SINGLE", **{"lambda": "BUILD"})),
]


def policy_cases(tmp):
    api, prefix = "abc123", "arn:aws:execute-api:us-west-2:300094796789:abc123/"
    join = lambda path: {"Fn::Join": ["", ["arn:", {"Ref": "AWS::Partition"}, ":execute-api:us-west-2:300094796789:",
                                           {"Ref": "ApiF70053CD"}, path]]}
    paths = ["/*/*/v1/me", "/*/*/v1/visits", "/*/*/v1/visits"]   # GET and POST share a path
    tpl = {"Resources": {"P%d" % i: {"Type": "AWS::Lambda::Permission", "Properties": {"SourceArn": join(p)}} for i, p in enumerate(paths)}}
    stmt = lambda arn, **kw: dict({"Sid": "s", "Effect": "Allow", "Principal": {"Service": "apigateway.amazonaws.com"},
                                   "Action": "lambda:InvokeFunction", "Condition": {"ArnLike": {"AWS:SourceArn": arn}}}, **kw)
    route = [stmt(prefix + p[1:]) for p in paths]
    cases = [
        ("route-scoped", route, "ROUTE-SCOPED", 0),
        ("single", [stmt(prefix + "*/*/*")], "SINGLE", 0),
        ("one route missing", route[:-1], "OTHER", 1),
        ("one extra", route + [stmt(prefix + "*/*/v1/x")], "OTHER", 1),
        ("public principal", [stmt(prefix + "*/*/*", Principal="*")], "OTHER", 1),
        ("other API", [stmt("arn:aws:execute-api:us-west-2:300094796789:zzz999/*/*/*")], "OTHER", 1),
        ("any API", [stmt("arn:aws:execute-api:us-west-2:300094796789:*")], "OTHER", 1),
        ("single plus route", [stmt(prefix + "*/*/*"), route[0]], "OTHER", 1),
        ("empty", [], "OTHER", 1),
    ]
    tp = os.path.join(tmp, "t.json")
    json.dump(tpl, open(tp, "w"))
    bad = []
    for name, st, want, rc in cases:
        pp = os.path.join(tmp, "p.json")
        json.dump({"Version": "2012-10-17", "Statement": st}, open(pp, "w"))
        r = subprocess.run(TOOL + ["lambda-policy", pp, tp, api, "300094796789", "us-west-2"], capture_output=True, text=True)
        if not r.stdout.startswith(want + ":") or r.returncode != rc:
            bad.append("lambda-policy %s: got rc %d %s" % (name, r.returncode, r.stdout.strip()[:120]))
    return bad, len(cases)


def main():
    bad = []
    for name, facts, want in ACCEPT:
        rc, out = decide(facts)
        if rc != 0 or not out.startswith(want):
            bad.append("accept %s: %s" % (name, out[:160]))
    for name, facts in REFUSE:
        rc, out = decide(facts)
        if rc == 0 or not out.startswith("STOP"):
            bad.append("refuse %s: %s" % (name, out[:160]))
    with tempfile.TemporaryDirectory() as tmp:
        pbad, n = policy_cases(tmp)
    bad += pbad
    for b in bad:
        print("FAIL " + b)
    print("Preflight self-test: %s (%d accepted states, %d refused deviations, %d policy cases)" % (
        "FAIL" if bad else "PASS", len(ACCEPT), len(REFUSE), n))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
