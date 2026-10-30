#!/usr/bin/env python3
"""Read-only check that a synthesized CDK assembly IS the approved PRODUCTION release (staff management; Handler build of 7870a04).

  python3 assembly_check_prd.py --assembly DIR --release-templates DIR [--approval REF]
      DIR = the assembly the operator is about to deploy from (cdk synth -c env=prd -c mode=deploy -o DIR);
      --release-templates = the bundled templates synthesized when the package was built (plan mode).

PASS requires: exactly the six Ogevia-prd-* templates (no Ogevia-prod-* and no other stack); each equal to the bundled release template after ignoring CDK metadata,
resource metadata, the BootstrapVersion parameter and the VALUE of the `ogevia:deployment-status` tag; the Handler code asset is the release's build and the Identity
asset is unchanged; 242 API routes of which the 14 staff routes each exactly once; exactly one ENABLED EventBridge rule and two Lambda invoke permissions; with --approval,
every `ogevia:deployment-status` tag carries approved-<ref>; both Lambda asset directories and manifest.json exist.
Exit 0 = all checks passed; 1 = a check failed; 2 = unreadable input.
"""
import argparse, json, os, sys

STACKS = ["Ogevia-prd-Auth", "Ogevia-prd-DatabaseSecret", "Ogevia-prd-EvidenceStorage", "Ogevia-prd-Observability", "Ogevia-prd-ServiceVerificationApi", "Ogevia-prd-WebHosting"]
API = "Ogevia-prd-ServiceVerificationApi"
RELEASE_HANDLER_KEY = "2871b03d6be42b0b8c85bac6feea12de75b3d05ca4636610259b6a18e1d00ed7.zip"
IDENTITY_HANDLER_KEY = "7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759.zip"
ROUTES = 242  # 228 earlier routes + the 14 staff routes
NEW_ROUTE_KEYS = [
    "GET /v1/staff-types", "POST /v1/staff-types", "POST /v1/staff-types/{staffTypeId}/rename", "POST /v1/staff-types/{staffTypeId}/active",
    "GET /v1/staff", "POST /v1/staff", "POST /v1/staff/{profileId}", "POST /v1/staff-members/{userId}/profile",
    "POST /v1/staff/{profileId}/invitation", "POST /v1/staff/{profileId}/invitation/resend", "POST /v1/staff-roles/{userId}",
    "GET /v1/role-permissions", "GET /v1/staff-audit", "POST /v1/me/staff-invitations/{organizationId}/accept",
]
SECTIONS = ["Description", "Outputs", "Conditions", "Mappings", "Transform", "AWSTemplateFormatVersion"]


def load(path):
    with open(path, encoding="utf-8") as fh:
        t = json.load(fh)
    if isinstance(t, dict) and "TemplateBody" in t:
        t = t["TemplateBody"]
    if not isinstance(t, dict) or "Resources" not in t:
        raise ValueError("%s is not a CloudFormation template" % path)
    return t


def norm(x):
    if isinstance(x, dict):
        if x.get("Key") == "ogevia:deployment-status" and "Value" in x:
            return {"Key": x["Key"], "Value": "<APPROVAL>"}
        return {k: ("<APPROVAL>" if k == "ogevia:deployment-status" else norm(v)) for k, v in x.items()}
    if isinstance(x, list):
        out = [norm(i) for i in x]
        if out and all(isinstance(i, dict) and "Key" in i for i in out):
            out.sort(key=lambda i: json.dumps(i, sort_keys=True))
        return out
    return x


def prep(t):
    t = norm(t)
    res = {k: {a: b for a, b in v.items() if a != "Metadata"} for k, v in t["Resources"].items() if v.get("Type") != "AWS::CDK::Metadata"}
    params = {k: v for k, v in (t.get("Parameters") or {}).items() if k != "BootstrapVersion"}
    return res, {**{s: t.get(s) for s in SECTIONS}, "Parameters": params or None}


def lambda_keys(template):
    return {k: v.get("Properties", {}).get("Code", {}).get("S3Key") for k, v in template["Resources"].items() if v.get("Type") == "AWS::Lambda::Function"}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--assembly", required=True)
    ap.add_argument("--release-templates", required=True)
    ap.add_argument("--approval", default=None)
    a = ap.parse_args(argv)
    problems = []

    def need(ok, text):
        print(("PASS " if ok else "FAIL ") + text)
        if not ok:
            problems.append(text)

    try:
        found = sorted(f[:-len(".template.json")] for f in os.listdir(a.assembly) if f.endswith(".template.json"))
        templates = {s: load(os.path.join(a.assembly, s + ".template.json")) for s in STACKS}
        releases = {s: load(os.path.join(a.release_templates, s + ".json")) for s in STACKS}
    except (OSError, ValueError, KeyError) as e:
        print("FAIL cannot read the assembly or the release templates (%s)" % e)
        return 2
    need(found == sorted(STACKS), "the assembly holds exactly the six production stacks and no Ogevia-prod-* stack (found %s)" % found)
    for s in STACKS:
        need(prep(templates[s]) == prep(releases[s]), "%s equals the bundled release template" % s)
    api = templates[API]
    keys = lambda_keys(api)
    handler = [v for k, v in keys.items() if k.startswith("Handler")]
    ident = [v for k, v in keys.items() if k.startswith("IdentityHandler")]
    need(handler == [RELEASE_HANDLER_KEY], "Handler code asset is the release's build (%s...), found %s" % (RELEASE_HANDLER_KEY[:12], [h[:12] if h else h for h in handler]))
    need(ident == [IDENTITY_HANDLER_KEY], "IdentityHandler code asset is unchanged (%s...), found %s" % (IDENTITY_HANDLER_KEY[:12], [h[:12] if h else h for h in ident]))
    for h in (RELEASE_HANDLER_KEY, IDENTITY_HANDLER_KEY):
        need(os.path.isdir(os.path.join(a.assembly, "asset." + h[:-4])), "asset directory asset.%s... is present" % h[:12])
    routes = [v for v in api["Resources"].values() if v["Type"] == "AWS::ApiGatewayV2::Route"]
    need(len(routes) == ROUTES, "%d API routes (found %d)" % (ROUTES, len(routes)))
    route_keys = [r["Properties"].get("RouteKey") for r in routes]
    need(all(route_keys.count(k) == 1 for k in NEW_ROUTE_KEYS), "each of the 14 staff routes is present exactly once")
    types = [v["Type"] for v in api["Resources"].values()]
    rules = [v for v in api["Resources"].values() if v["Type"] == "AWS::Events::Rule"]
    need(len(rules) == 1 and rules[0]["Properties"].get("State") == "ENABLED", "exactly one EventBridge rule (ComplianceSweep), State ENABLED (found %s)" % [r["Properties"].get("State") for r in rules])
    need(types.count("AWS::Lambda::Permission") == 2, "exactly two Lambda invoke permissions (found %d)" % types.count("AWS::Lambda::Permission"))
    if a.approval:
        n = 0
        wrong = set()
        for s in STACKS:
            for r in templates[s].get("Resources", {}).values():
                tg = r.get("Properties", {}).get("Tags")
                vals = []
                if isinstance(tg, list):
                    vals = [x.get("Value") for x in tg if isinstance(x, dict) and x.get("Key") == "ogevia:deployment-status"]
                elif isinstance(tg, dict) and "ogevia:deployment-status" in tg:
                    vals = [tg["ogevia:deployment-status"]]
                n += len(vals)
                wrong |= {str(x) for x in vals if x != "approved-%s" % a.approval}
        need(n > 0 and not wrong, "every ogevia:deployment-status tag (%d) carries approved-%s%s" % (n, a.approval, "" if not wrong else " (found %s)" % sorted(wrong)))
    need(os.path.isfile(os.path.join(a.assembly, "manifest.json")), "manifest.json is present")
    print("PASS all checks" if not problems else "STOP: %d check(s) failed" % len(problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
