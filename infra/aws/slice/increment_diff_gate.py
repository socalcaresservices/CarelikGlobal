#!/usr/bin/env python3
"""Deployment scope gate for the 0019-0021 increment (standard library only). STRICT.

Compares each synthesized template (cdk.out) with the template CloudFormation
has deployed (captured just before the change) and FAILS unless the difference
is exactly the approved increment:

  1. ADD the 22 routes in NEW_ROUTES. Each must be identical to the live
     GET /v1/me route except its RouteKey: same API, JWT authorizer and the
     API's one existing integration (no new integration).
  2. ADD one route-scoped invoke permission per new route (logical id
     <route prefix>HandlerPermission<hash>), identical to the live GET /v1/me
     permission except the path in SourceArn.
  3. MODIFY the existing Handler's code package only (Code.S3Key and Metadata
     aws:asset:path); runtime, memory, timeout, VPC, role, environment, tags
     and everything else identical.
  4. MODIFY HandlerPolicy: exactly the two statements in NEW_STATEMENTS are
     added; every existing statement is unchanged and in the same order.
  5. MODIFY AWS::CDK::Metadata Properties.Analytics only (creates nothing).

Everything else, in every stack, must be identical: nothing removed, no other
resource added or changed, template sections identical, public (no sign-in)
routes exactly the approved list. Tags are compared too, so the build must be
synthesized with the live approval tag value. Exit 1 = stop.
"""
import argparse
import copy
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pilot_diff_gate import STACKS, API_STACK, diff_paths, handler_id, only_cdk_path, public_route_keys, without  # noqa: E402
from smoke import APPROVED_PUBLIC_ROUTE_KEYS  # noqa: E402

BUCKET_ARN = "arn:aws:s3:::ogevia-prod-signature-evidence-300094796789-us-west-2"
SIBLING_ROUTE, SIBLING_PATH = "GET /v1/me", "/v1/me"
NEW_ROUTES = sorted([
    "GET /v1/attention",
    "GET /v1/billing-approvals",
    "GET /v1/branding",
    "GET /v1/branding/logo",
    "GET /v1/clients/directory",
    "GET /v1/document-types",
    "GET /v1/document-versions/{versionId}/file",
    "GET /v1/documents",
    "GET /v1/documents/alerts",
    "GET /v1/documents/people",
    "GET /v1/reports/utilisation",
    "POST /v1/billing-approvals/{approvalId}/void",
    "POST /v1/branding",
    "POST /v1/branding/logo",
    "POST /v1/branding/logo/clear",
    "POST /v1/clients/{clientId}/legal-name",
    "POST /v1/document-types",
    "POST /v1/document-versions/{versionId}/review",
    "POST /v1/documents/requests",
    "POST /v1/documents/{documentId}/versions",
    "POST /v1/me/display-name",
    "POST /v1/visits/{visitId}/billing-approval",
])
OBJECT_ACTIONS = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"]
NEW_STATEMENTS = [
    {"Action": OBJECT_ACTIONS, "Effect": "Allow", "Resource": BUCKET_ARN + "/*/documents/*/*", "Sid": "StaffDocumentObjects"},
    {"Action": OBJECT_ACTIONS, "Effect": "Allow", "Resource": BUCKET_ARN + "/*/branding/logo/*", "Sid": "AgencyLogoObjects"},
]
POLICY_PATH = "Properties.PolicyDocument.Statement"


def routes_by_key(res):
    out = {}
    for lid, r in res.items():
        if r.get("Type") == "AWS::ApiGatewayV2::Route":
            out.setdefault(r.get("Properties", {}).get("RouteKey"), []).append(lid)
    return out


def permission_for(res, route_id):
    """The permission CDK creates next to a route: <prefix>HandlerPermission<8 hex>."""
    prefix = route_id[:-8] + "HandlerPermission"
    hits = [lid for lid, r in res.items() if r.get("Type") == "AWS::Lambda::Permission"
            and lid.startswith(prefix) and len(lid) == len(prefix) + 8]
    return hits[0] if len(hits) == 1 else None


def check_additions(old, new, added, failures, lines):
    old_routes, new_routes = routes_by_key(old), routes_by_key(new)
    sib = old_routes.get(SIBLING_ROUTE, [])
    sib_perm = permission_for(old, sib[0]) if len(sib) == 1 else None
    if not sib_perm:
        failures.append("%s: live %s route/permission not found; cannot verify additions" % (API_STACK, SIBLING_ROUTE))
        return
    integrations = [lid for lid, r in old.items() if r.get("Type") == "AWS::ApiGatewayV2::Integration"]
    expected_ids = set()
    for key in NEW_ROUTES:
        if key in old_routes:
            failures.append("%s: %s is already live; this build expects it to be new" % (API_STACK, key))
            continue
        ids = new_routes.get(key, [])
        if len(ids) != 1:
            failures.append("%s: expected exactly one new route %s, found %d" % (API_STACK, key, len(ids)))
            continue
        rid = ids[0]
        pid = permission_for(new, rid)
        if not pid:
            failures.append("%s: no route-scoped permission for %s" % (API_STACK, key))
            continue
        expected_ids |= {rid, pid}
        want = copy.deepcopy(old[sib[0]])
        want["Properties"]["RouteKey"] = key
        got = new[rid]
        bad = diff_paths(without(want, "Metadata"), without(got, "Metadata"))
        target = json.dumps(got["Properties"].get("Target"))
        on_existing = len(integrations) == 1 and ('"Ref": "%s"' % integrations[0]) in target
        path = key.split(" ", 1)[1]
        want_p = json.loads(json.dumps(old[sib_perm]).replace('/*/*%s"' % SIBLING_PATH, '/*/*%s"' % path))
        bad_p = diff_paths(without(want_p, "Metadata"), without(new[pid], "Metadata"))
        if bad or bad_p or not on_existing or not only_cdk_path(got) or not only_cdk_path(new[pid]):
            failures.append("%s: %s differs from the live %s route/permission beyond its key/path: %s%s" % (
                API_STACK, key, SIBLING_ROUTE, ", ".join(bad + bad_p) or "Metadata",
                "" if on_existing else "; does not target the existing integration"))
        else:
            lines.append("%s: + route %s (JWT, existing integration) + its invoke permission" % (API_STACK, key))
    extra = sorted(set(added) - expected_ids)
    for lid in extra:
        failures.append("%s: would ADD %s (%s), not in the approved list" % (API_STACK, lid, new[lid]["Type"]))
    missing = expected_ids - set(added)
    for lid in sorted(missing):
        failures.append("%s: %s is expected as new but already exists" % (API_STACK, lid))


def check_policy(old_r, new_r):
    """Exactly NEW_STATEMENTS inserted; existing statements unchanged and in order."""
    bad = diff_paths(without(old_r, POLICY_PATH), without(new_r, POLICY_PATH))
    if bad:
        return bad
    old_s = old_r["Properties"]["PolicyDocument"]["Statement"]
    new_s = new_r["Properties"]["PolicyDocument"]["Statement"]
    kept = [s for s in new_s if s not in NEW_STATEMENTS]
    if kept != old_s:
        return ["existing statements changed, removed or reordered"]
    if sorted(json.dumps(s, sort_keys=True) for s in new_s if s in NEW_STATEMENTS) != \
            sorted(json.dumps(s, sort_keys=True) for s in NEW_STATEMENTS):
        return ["the added statements are not exactly StaffDocumentObjects and AgencyLogoObjects"]
    return []


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--cdk-out", required=True, help="synthesized cloud assembly directory")
    p.add_argument("--deployed", required=True, help="directory of <stack>.json deployed templates")
    p.add_argument("--summary", help="write the summary here as well")
    args = p.parse_args()
    lines, failures = [], []

    for stack in STACKS:
        new_t = json.load(open(os.path.join(args.cdk_out, stack + ".template.json")))
        path = os.path.join(args.deployed, stack + ".json")
        if not os.path.exists(path):
            failures.append("%s: not deployed (this workflow never creates stacks)" % stack)
            continue
        old_t = json.load(open(path))
        for s in diff_paths({k: v for k, v in old_t.items() if k != "Resources"},
                            {k: v for k, v in new_t.items() if k != "Resources"}):
            failures.append("%s: template section differs: %s" % (stack, s))
        old, new = old_t.get("Resources", {}), new_t.get("Resources", {})
        added = sorted(set(new) - set(old))
        removed = sorted(set(old) - set(new))
        modified = sorted(lid for lid in set(old) & set(new) if old[lid] != new[lid])
        if not (added or removed or modified):
            lines.append("%s: no changes" % stack)
            continue
        for lid in removed:
            failures.append("%s: would REMOVE %s (%s)" % (stack, lid, old[lid]["Type"]))
        if stack == API_STACK:
            check_additions(old, new, added, failures, lines)
        else:
            for lid in added:
                failures.append("%s: would ADD %s (%s)" % (stack, lid, new[lid]["Type"]))
        h = handler_id(old) if stack == API_STACK else None
        for lid in modified:
            t = new[lid]["Type"]
            if t != old[lid].get("Type"):
                bad = ["Type"]
            elif t == "AWS::CDK::Metadata":
                bad = diff_paths(without(old[lid], "Properties.Analytics"), without(new[lid], "Properties.Analytics"))
                if not bad:
                    lines.append("%s: ~ CDK metadata Analytics only (creates nothing in AWS)" % stack)
                    continue
            elif lid == h:
                bad = diff_paths(without(old[lid], "Properties.Code.S3Key", "Metadata.aws:asset:path"),
                                 without(new[lid], "Properties.Code.S3Key", "Metadata.aws:asset:path"))
                if not bad:
                    lines.append("%s: ~ %s (the existing Handler) code package only: Code.S3Key" % (stack, lid))
                    continue
            elif stack == API_STACK and t == "AWS::IAM::ManagedPolicy" and lid.startswith("HandlerPolicy"):
                bad = check_policy(old[lid], new[lid])
                if not bad:
                    for s in NEW_STATEMENTS:
                        lines.append("%s: ~ %s + statement %s: %s on %s" % (
                            stack, lid, s["Sid"], ", ".join(s["Action"]), s["Resource"]))
                    continue
            else:
                bad = diff_paths(old[lid], new[lid])
            failures.append("%s: would MODIFY %s (%s): %s" % (stack, lid, t, ", ".join(bad)))

    api_new = json.load(open(os.path.join(args.cdk_out, API_STACK + ".template.json")))
    pub = public_route_keys(api_new)
    if pub == APPROVED_PUBLIC_ROUTE_KEYS:
        lines.append("Public (no sign-in) API routes: %d, exactly the approved list (none added)" % len(pub))
    else:
        failures.append("Public API routes differ from the approved list: extra %s, missing %s" % (
            sorted(set(pub) - set(APPROVED_PUBLIC_ROUTE_KEYS)), sorted(set(APPROVED_PUBLIC_ROUTE_KEYS) - set(pub))))

    out = ["Deployment scope gate, increment 0019-0021 (strict)"] + ["  " + line for line in lines]
    out += (["STOP - outside the approved change:"] + ["  " + f for f in failures]) if failures else ["Scope gate: PASS"]
    text = "\n".join(out)
    print(text)
    if args.summary:
        with open(args.summary, "w") as f:
            f.write(text + "\n")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
