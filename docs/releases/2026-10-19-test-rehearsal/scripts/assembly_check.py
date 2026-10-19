#!/usr/bin/env python3
"""Read-only check that a synthesized CDK assembly IS the approved TEST rehearsal release (commit f6dd9b7) and, optionally, that the LIVE TEST stacks are the recorded
baseline (the earlier candidate d89327600f3fc55ab9c59af0d0eaea8675d77535, deployed to TEST on 2026-10-18).

  python3 assembly_check.py --assembly DIR           # the assembly the operator is about to deploy from (cdk synth -o DIR)
  python3 assembly_check.py --live-dir DIR           # DIR holds <Stack>.json = `aws cloudformation get-template --template-stage Original` of each live TEST stack
  python3 assembly_check.py --print-fingerprints DIR # maintenance: print the fingerprints of an assembly (used to refresh the pins below)

Fingerprint = sha256 of the canonical template with CDK::Metadata removed, the VALUE of the `ogevia:deployment-status` tag normalised (it carries the approval
reference, which differs between deployments) and, for the API stack, the Handler's Code and asset Metadata removed (checked separately by key).
Exit 0 = all checks passed; 1 = a check failed; 2 = usage or unreadable input.
"""
import argparse, hashlib, json, os, sys

STACKS = ["Ogevia-prod-EvidenceStorage", "Ogevia-prod-NetworkEgress", "Ogevia-prod-WebHosting", "Ogevia-prod-ServiceVerificationApi", "Ogevia-prod-Observability"]
API = "Ogevia-prod-ServiceVerificationApi"
RELEASE_COMMIT = "f6dd9b7"
BASELINE_COMMIT = "d89327600f3fc55ab9c59af0d0eaea8675d77535"
BASELINE_HANDLER_KEY = "929cdb1bde9bbf18025dc36f5cc61210246ca048efa6d6b51147cf4c22b24ab0.zip"
RELEASE_HANDLER_KEY = "162b7a43d10dbded0cd0222c1f2603c21725e6a5cd9a192477d7b36d3320f01f.zip"
IDENTITY_HANDLER_KEY = "7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759.zip"
ROUTES = 228
# fingerprints of the five stacks as synthesized from the baseline commit and from the release commit (local synthesis in deploy mode)
BASELINE_FP = {
    "Ogevia-prod-EvidenceStorage": "3e14cbbd245b9d65fc535fb80e77f314b951f86173073e32c6a1e5590657b98b",
    "Ogevia-prod-NetworkEgress": "4afc54866a2a80e46edc4fdab5980a780c20873dd41075ab0ccbc6156dff7aad",
    "Ogevia-prod-WebHosting": "11715b842b9813a2d10b60c87716778845057ce2eadd1d4d45233e42f769955f",
    "Ogevia-prod-ServiceVerificationApi": "fdf83092f1fbcbc876d4afe76cc4205c671c540e8a2b0bf6c1302d7be8dcff7c",
    "Ogevia-prod-Observability": "bf4f7f323a38d6b9abb4ee8b6553087df3f06db6f958a8845305bf20c44b1014",
}
RELEASE_FP = {
    "Ogevia-prod-EvidenceStorage": "3e14cbbd245b9d65fc535fb80e77f314b951f86173073e32c6a1e5590657b98b",
    "Ogevia-prod-NetworkEgress": "6009b20c0ffd92b515cb7211c59b9336676ffb2a6fef66ad3ea44d80e1f0e731",
    "Ogevia-prod-WebHosting": "11715b842b9813a2d10b60c87716778845057ce2eadd1d4d45233e42f769955f",
    "Ogevia-prod-ServiceVerificationApi": "4b463942ebbd17ddece001c11e5950f1ad686adb820441f1ff847556d0df24a5",
    "Ogevia-prod-Observability": "bf4f7f323a38d6b9abb4ee8b6553087df3f06db6f958a8845305bf20c44b1014",
}
CHANGED = {"Ogevia-prod-NetworkEgress", API}


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
    ap.add_argument("--live-dir")
    ap.add_argument("--print-fingerprints")
    a = ap.parse_args(argv)
    if a.print_fingerprints:
        for s in STACKS:
            print('    "%s": "%s",' % (s, fingerprint(load(os.path.join(a.print_fingerprints, s + ".template.json")), s)))
        return 0
    if not a.assembly and not a.live_dir:
        ap.print_usage(sys.stderr); return 2
    problems = []

    def need(ok, text):
        print(("PASS " if ok else "FAIL ") + text)
        if not ok:
            problems.append(text)

    if a.assembly:
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
        types = [v["Type"] for v in api["Resources"].values()]
        need(types.count("AWS::ApiGatewayV2::Route") == ROUTES, "%d API routes (found %d)" % (ROUTES, types.count("AWS::ApiGatewayV2::Route")))
        rules = [v for v in api["Resources"].values() if v["Type"] == "AWS::Events::Rule"]
        need(len(rules) == 1 and rules[0]["Properties"].get("State") == "ENABLED", "exactly one EventBridge rule (ComplianceSweep), State ENABLED (found %s)" % [r["Properties"].get("State") for r in rules])
        need(types.count("AWS::Lambda::Permission") == 2, "exactly two Lambda invoke permissions (found %d)" % types.count("AWS::Lambda::Permission"))
        for s in STACKS:
            fp = fingerprint(templates[s], s)
            need(fp == RELEASE_FP.get(s), "%s equals the release %s synthesis (fingerprint %s...)" % (s, RELEASE_COMMIT, fp[:12]))
    if a.live_dir:
        for s in STACKS:
            p = os.path.join(a.live_dir, s + ".json")
            deployed = s in CHANGED  # only the two stacks this procedure deploys must equal the baseline; the others are reported (they are not touched)
            try:
                live = load(p)
            except (OSError, ValueError) as e:
                if deployed: need(False, "cannot read the live template %s (%s)" % (p, e))
                else: print("WARN cannot read the live template %s (%s); this stack is not deployed by the procedure" % (p, e))
                continue
            fp = fingerprint(live, s)
            if deployed or fp == BASELINE_FP.get(s):
                need(fp == BASELINE_FP.get(s), "LIVE %s equals the recorded baseline %s (fingerprint %s...)" % (s, BASELINE_COMMIT[:7], fp[:12]))
            else:
                print("WARN LIVE %s differs from the recorded baseline (fingerprint %s...); the procedure does not deploy this stack, so it is reported, not a stop" % (s, fp[:12]))
        try:
            keys = lambda_keys(load(os.path.join(a.live_dir, API + ".json")))
            handler = [v for k, v in keys.items() if k.startswith("Handler")]
            need(handler == [BASELINE_HANDLER_KEY], "LIVE Handler code asset is the baseline build (%s...), found %s" % (BASELINE_HANDLER_KEY[:12], [h[:12] if h else h for h in handler]))
        except (OSError, ValueError):
            pass
        if problems:
            print("NOTE the live stacks are not the recorded baseline. Do NOT proceed; rely on the captured live artifacts (procedure, Recovery) and report.")
    print("PASS all checks" if not problems else "STOP: %d check(s) failed" % len(problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
