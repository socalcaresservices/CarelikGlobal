#!/usr/bin/env python3
"""Read-only live checks for release 0027-0036 (standard library only).

Each sub-command reads files captured by release-0036-deploy.sh and prints
"ok" or "no". It never calls AWS itself.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from release_0036_gate import NEW_PUBLIC_ROUTES, NEW_ROUTES  # noqa: E402


def routes(before_path, after_path):
    before = dict(map(tuple, json.load(open(before_path))))
    after = dict(map(tuple, json.load(open(after_path))))
    return (len(after) == len(before) + len(NEW_ROUTES) + len(NEW_PUBLIC_ROUTES) and all(after.get(k) == a for k, a in before.items())
            and all(after.get(k) == "JWT" for k in NEW_ROUTES) and all(after.get(k) == "NONE" for k in NEW_PUBLIC_ROUTES))


def same_json(a_path, b_path):
    norm = lambda d: json.dumps(d, sort_keys=True)
    return norm(json.load(open(a_path))) == norm(json.load(open(b_path)))


def same_config(before_path, after_path):
    """Lambda configuration unchanged except its code (and its timestamps)."""
    keep = lambda c: {k: v for k, v in c.items() if k not in ("CodeSha256", "LastModified", "Version", "RevisionId", "LastUpdateStatus", "State")}
    return json.dumps(keep(json.load(open(before_path))), sort_keys=True) == json.dumps(keep(json.load(open(after_path))), sort_keys=True)


CHECKS = {"routes": routes, "same-json": same_json, "same-config": same_config}

if __name__ == "__main__":
    try:
        print("ok" if CHECKS[sys.argv[1]](*sys.argv[2:]) else "no")
    except Exception:  # a missing or malformed capture is a failed check, never a crash
        print("no")
