#!/usr/bin/env python3
"""Read-only check that a synthesized CDK assembly IS the approved TEST release (code commit 7870a04c43545bacc378ad93ffc6a09d63345b5a).

  python3 assembly_check.py --assembly DIR           # the assembly the operator is about to deploy from (cdk synth -c env=prod -c mode=deploy -o DIR)
  python3 assembly_check.py --print-fingerprints DIR # maintenance: print the fingerprints of an assembly (used to refresh the pins below)

Unlike the earlier package this one does NOT pin what TEST runs today (the live state is not known to the development session): the live stacks are compared with this
assembly by diff_gate.py, which allows exactly the release's difference and nothing else. This script only proves the assembly itself.

Fingerprint = sha256 of the canonical template with CDK::Metadata removed, the VALUE of the `ogevia:deployment-status` tag normalised (it carries the approval reference,
which differs between deployments) and, for the API stack, the Handler's Code and asset Metadata removed (checked separately by key).
Exit 0 = all checks passed; 1 = a check failed; 2 = usage or unreadable input.
"""
import argparse, hashlib, json, os, sys

STACKS = ["Ogevia-prod-EvidenceStorage", "Ogevia-prod-NetworkEgress", "Ogevia-prod-WebHosting", "Ogevia-prod-ServiceVerificationApi", "Ogevia-prod-Observability"]
API = "Ogevia-prod-ServiceVerificationApi"
RELEASE_COMMIT = "7870a04"
RELEASE_HANDLER_KEY = "2871b03d6be42b0b8c85bac6feea12de75b3d05ca4636610259b6a18e1d00ed7.zip"
IDENTITY_HANDLER_KEY = "7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759.zip"
ROUTES = 242  # 228 earlier routes + the 14 staff routes
NEW_ROUTE_KEYS = [
    "GET /v1/staff-types", "POST /v1/staff-types", "POST /v1/staff-types/{staffTypeId}/rename", "POST /v1/staff-types/{staffTypeId}/active",
    "GET /v1/staff", "POST /v1/staff", "POST /v1/staff/{profileId}", "POST /v1/staff-members/{userId}/profile",
    "POST /v1/staff/{profileId}/invitation", "POST /v1/staff/{profileId}/invitation/resend", "POST /v1/staff-roles/{userId}",
    "GET /v1/role-permissions", "GET /v1/staff-audit", "POST /v1/me/staff-invitations/{organizationId}/accept",
]
# fingerprints of the five stacks as synthesized from the release commit (deploy mode)
RELEASE_FP = {
    "Ogevia-prod-EvidenceStorage": "3e14cbbd245b9d65fc535fb80e77f314b951f86173073e32c6a1e5590657b98b",
    "Ogevia-prod-NetworkEgress": "6009b20c0ffd92b515cb7211c59b9336676ffb2a6fef66ad3ea44d80e1f0e731",
    "Ogevia-prod-WebHosting": "5546cc6d0560afc8bb7ff522b8651e6a006587bd90c8dc5735cb3b50737b1783",
    "Ogevia-prod-ServiceVerificationApi": "c2c489aefedde4c8710ad7cdfc403e91bf1a9d43a6d01e0bcee161742233450c",
    "Ogevia-prod-Observability": "bf4f7f323a38d6b9abb4ee8b6553087df3f06db6f958a8845305bf20c44b1014",
}


def _norm(x):
    if isinstance(x, dict):
        out = {}
        for k, v in x.items():
            if k == "ogevia:deployment-status":
                out[k] = "<APPROVAL>"
            elif k == "Tags" and isinstance(v, list):
                out[k] = sorted((_norm_tag(t) for t in v), key=lambda t: json.dumps(t, sort_keys=True))
            else:
                out[k] = _norm(v)
        return out
    if isinstance(x, list):
        return [_norm(i) for i in x]
    return x


def _norm_tag(t):
    if isinstance(t, dict) and t.get("Key") == "ogevia:deployment-status":
        return {"Key": t["Key"], "Value": "<APPROVAL>"}
    return _norm(t)


def fingerprint(template, stack):
    res = {}
    for k, v in template["Resources"].items():
        if v.get("Type") == "AWS::CDK::Metadata":
            continue
        v = json.loads(json.dumps(v))
        if stack == API and v.get("Type") == "AWS::Lambda::Function" and k.startswith("Handler") and not k.startswith("IdentityHandler"):
            v.get("Properties", {}).pop("Code", None)
            v.pop("Metadata", None)
        res[k] = v
    body = _norm({"Description": template.get("Description"), "Parameters": template.get("Parameters"), "Outputs": template.get("Outputs"), "Rules": template.get("Rules"), "Resources": res})
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def lambda_keys(template):
    return {k: v.get("Properties", {}).get("Code", {}).get("S3Key") for k, v in template["Resources"].items() if v.get("Type") == "AWS::Lambda::Function"}


def load(path):
    with open(path) as fh:
        t = json.load(fh)
    return t["TemplateBody"] if isinstance(t, dict) and "TemplateBody" in t else t


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--assembly")
    ap.add_argument("--print-fingerprints")
    a = ap.parse_args(argv)
    if a.print_fingerprints:
        for s in STACKS:
            print('    "%s": "%s",' % (s, fingerprint(load(os.path.join(a.print_fingerprints, s + ".template.json")), s)))
        return 0
    if not a.assembly:
        ap.print_usage(sys.stderr); return 2
    problems = []

    def need(ok, text):
        print(("PASS " if ok else "FAIL ") + text)
        if not ok:
            problems.append(text)

    try:
        found = sorted(f[:-len(".template.json")] for f in os.listdir(a.assembly) if f.endswith(".template.json"))
        templates = {s: load(os.path.join(a.assembly, s + ".template.json")) for s in STACKS}
    except (OSError, ValueError, KeyError) as e:
        print("FAIL cannot read the assembly (%s)" % e); return 2
    need(found == sorted(STACKS), "the assembly holds exactly the five TEST stacks and no Ogevia-prd-* stack (found %s)" % found)
    api = templates[API]
    keys = lambda_keys(api)
    handler = [v for k, v in keys.items() if k.startswith("Handler")]
    ident = [v for k, v in keys.items() if k.startswith("IdentityHandler")]
    need(handler == [RELEASE_HANDLER_KEY], "Handler code asset is the release's build (%s...), found %s" % (RELEASE_HANDLER_KEY[:12], [h[:12] if h else h for h in handler]))
    need(ident == [IDENTITY_HANDLER_KEY], "IdentityHandler code asset is unchanged (%s...), found %s" % (IDENTITY_HANDLER_KEY[:12], [h[:12] if h else h for h in ident]))
    routes = [v for v in api["Resources"].values() if v["Type"] == "AWS::ApiGatewayV2::Route"]
    need(len(routes) == ROUTES, "%d API routes (found %d)" % (ROUTES, len(routes)))
    route_keys = [r["Properties"].get("RouteKey") for r in routes]
    need(all(route_keys.count(k) == 1 for k in NEW_ROUTE_KEYS), "each of the 14 staff routes is present exactly once")
    types = [v["Type"] for v in api["Resources"].values()]
    rules = [v for v in api["Resources"].values() if v["Type"] == "AWS::Events::Rule"]
    need(len(rules) == 1 and rules[0]["Properties"].get("State") == "ENABLED", "exactly one EventBridge rule (ComplianceSweep), State ENABLED (found %s)" % [r["Properties"].get("State") for r in rules])
    need(types.count("AWS::Lambda::Permission") == 2, "exactly two Lambda invoke permissions (found %d)" % types.count("AWS::Lambda::Permission"))
    for s in STACKS:
        fp = fingerprint(templates[s], s)
        need(fp == RELEASE_FP.get(s), "%s equals the release %s synthesis (fingerprint %s...)" % (s, RELEASE_COMMIT, fp[:12]))
    print("PASS all checks" if not problems else "STOP: %d check(s) failed" % len(problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
