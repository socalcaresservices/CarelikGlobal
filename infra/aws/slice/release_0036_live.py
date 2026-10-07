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


# Fields Lambda changes on every update, or reports only while an update runs.
# Their values are checked separately (State/LastUpdateStatus must be final and
# successful; CodeSha256/CodeSize must be the approved package), never ignored.
VOLATILE = ("CodeSha256", "CodeSize", "LastModified", "Version", "RevisionId", "LastUpdateStatus", "State",
            "StateReason", "StateReasonCode", "LastUpdateStatusReason", "LastUpdateStatusReasonCode")


def _flat(value, prefix=""):
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            out.update(_flat(v, prefix + "." + k if prefix else k))
        return out or {prefix: {}}
    if isinstance(value, list):
        out = {}
        for i, v in enumerate(value):
            out.update(_flat(v, "%s[%d]" % (prefix, i)))
        return out or {prefix: []}
    return {prefix: value}


def _shown(path, value):
    """Environment values may be secrets: show only a short hash of the value."""
    if value is None:
        return "(absent)"
    if path.startswith("Environment.Variables."):
        import hashlib
        return "value sha256:" + hashlib.sha256(json.dumps(value).encode()).hexdigest()[:12]
    return json.dumps(value)


def _diff(before, after):
    b, a = _flat(before), _flat(after)
    return [(k, b.get(k), a.get(k)) for k in sorted(set(b) | set(a)) if b.get(k) != a.get(k)]


def config_diff(before_path, after_path):
    """Diagnosis: every differing field (environment values redacted). Prints lines, not ok/no."""
    before, after = json.load(open(before_path)), json.load(open(after_path))
    rows = _diff(before, after)
    print("\n".join("%s: %s -> %s" % (k, _shown(k, b), _shown(k, a)) for k, b, a in rows) or "no differences")
    return None


def handler_config(before_path, after_path, runtime_mode, asset_size, asset_sha256_b64):
    """The API Lambda changed ONLY its code, and the code is exactly the approved package.

    before: the pre-deployment capture; after: the live configuration, as returned.
    - after.State == Active and after.LastUpdateStatus == Successful (no update in flight or failed);
    - after.CodeSha256 / CodeSize == SHA-256 (base64) / size of the S3 object the live template deploys;
    - RuntimeVersionConfig may differ ONLY when the function's runtime update mode is Auto and
      Runtime is unchanged (Lambda's documented two-phase rollout applies the newest runtime
      version to a function when it is updated); the change is reported, never hidden;
    - every other field identical: environment, memory, timeout, role, VPC, layers, logging,
      architectures, ephemeral storage, handler, tracing, package type...
    Prints "ok|<detail>" or "no|<detail>".
    """
    before, after = json.load(open(before_path)), json.load(open(after_path))
    problems, notes = [], []
    if after.get("State") != "Active" or after.get("LastUpdateStatus") != "Successful":
        problems.append("function not settled: State=%s LastUpdateStatus=%s" % (after.get("State"), after.get("LastUpdateStatus")))
    if after.get("CodeSha256") != asset_sha256_b64 or str(after.get("CodeSize")) != str(asset_size):
        problems.append("code is not the approved package (CodeSha256/CodeSize differ from the deployed S3 asset)")
    else:
        notes.append("code = approved package (%s bytes, was %s)" % (asset_size, before.get("CodeSize")))
    b = {k: v for k, v in before.items() if k not in VOLATILE}
    a = {k: v for k, v in after.items() if k not in VOLATILE}
    if b.get("RuntimeVersionConfig") != a.get("RuntimeVersionConfig"):
        if runtime_mode == "Auto" and b.get("Runtime") == a.get("Runtime") and "Error" not in (a.get("RuntimeVersionConfig") or {}):
            notes.append("AWS-managed runtime patch applied with the code update (runtime %s, update mode Auto): %s -> %s" % (
                a.get("Runtime"), (b.get("RuntimeVersionConfig") or {}).get("RuntimeVersionArn"), (a.get("RuntimeVersionConfig") or {}).get("RuntimeVersionArn")))
            b.pop("RuntimeVersionConfig", None)
            a.pop("RuntimeVersionConfig", None)
        else:
            problems.append("runtime version changed outside the Auto rollout (mode %s)" % runtime_mode)
    for k, bv, av in _diff(b, a):
        problems.append("%s: %s -> %s" % (k, _shown(k, bv), _shown(k, av)))
    print(("no|" + "; ".join(problems)) if problems else ("ok|" + "; ".join(notes)))
    return None


CHECKS = {"routes": routes, "same-json": same_json, "same-config": same_config}
RAW = {"config-diff": config_diff, "handler-config": handler_config}

if __name__ == "__main__":
    try:
        if sys.argv[1] in RAW:
            RAW[sys.argv[1]](*sys.argv[2:])
        else:
            print("ok" if CHECKS[sys.argv[1]](*sys.argv[2:]) else "no")
    except Exception as e:  # a missing or malformed capture is a failed check, never a crash
        print("no|could not compare: %s" % type(e).__name__ if sys.argv[1] in RAW else "no")
