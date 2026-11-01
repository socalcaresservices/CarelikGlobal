#!/usr/bin/env python3
"""Local test of diff_gate_prd0088.py against a synthesized PRODUCTION assembly (no AWS):  python3 test_gate_prd0088.py /path/to/cdk.out
Builds a simulated 'live' template (the assembly minus the 22 release routes, with the previous Handler asset key and another approval tag) and checks that the gate accepts exactly the release's difference and refuses anything else."""
import copy, json, os, subprocess, sys, tempfile
asm = sys.argv[1]; here = os.path.dirname(os.path.abspath(__file__)); gate = os.path.join(here, "diff_gate_prd0088.py")
new = json.load(open(os.path.join(asm, "Ogevia-prd-ServiceVerificationApi.template.json")))
import re
exec(re.search(r"NEW_ROUTES = \{.*?\n\}\n", open(gate).read(), re.S).group(0), globals())   # NEW_ROUTES
assert len(NEW_ROUTES) == 22
tmp = tempfile.mkdtemp(); bad = 0
def run(live, expect="pre", newt=None, extra=()):
    lp, np = os.path.join(tmp, "live.json"), os.path.join(tmp, "new.json")
    json.dump(live, open(lp, "w")); json.dump(newt or new, open(np, "w"))
    r = subprocess.run([sys.executable, "-I", "-B", gate, "--live", lp, "--new", np, "--expect", expect, *extra], capture_output=True, text=True)
    return r.returncode, (r.stdout + r.stderr)
def ck(label, got, want_ok, text=""):
    global bad
    ok = (got == 0) == want_ok
    print(("PASS " if ok else "FAIL ") + label + ("" if ok else "  -> " + text.strip().splitlines()[-1][:160]))
    bad += 0 if ok else 1
def simulated_live():
    live = copy.deepcopy(new); res = live["Resources"]
    for k in [k for k, v in res.items() if v["Type"] == "AWS::ApiGatewayV2::Route" and v["Properties"]["RouteKey"] in NEW_ROUTES]: del res[k]
    hk = next(k for k, v in res.items() if v["Type"] == "AWS::Lambda::Function" and k.startswith("Handler"))
    res[hk]["Properties"]["Code"]["S3Key"] = "debd1d43" + "0" * 56 + ".zip"
    if "Metadata" in res[hk] and "aws:asset:path" in res[hk]["Metadata"]: res[hk]["Metadata"]["aws:asset:path"] = "asset.debd1d43"
    return live
rc, t = run(new, "post"); ck("post-deployment: assembly equals itself", rc, True, t)
live = simulated_live(); rc, t = run(live, "pre"); ck("pre-deployment: exactly the 22 routes and the Handler asset differ", rc, True, t); print("     " + [l for l in t.splitlines() if l.startswith("added:")][0])
rc, t = run(live, "post"); ck("pre-deployment difference is refused when 'post' (nothing may differ) is expected", rc, False, t)
l2 = copy.deepcopy(live)
rk = next(k for k, v in new["Resources"].items() if v["Type"] == "AWS::ApiGatewayV2::Route" and v["Properties"]["RouteKey"] in NEW_ROUTES); l2["Resources"][rk] = new["Resources"][rk]
rc, t = run(l2, "pre"); ck("one of the 22 routes already live: refused (the live state is not the expected before-state)", rc, False, t)
l3 = copy.deepcopy(live); extra = next(k for k, v in l3["Resources"].items() if v["Type"] == "AWS::ApiGatewayV2::Route" and v["Properties"]["RouteKey"] not in NEW_ROUTES)
del l3["Resources"][extra]; rc, t = run(l3, "pre"); ck("a 23rd route missing from live (an unexpected added route): refused", rc, False, t)
l4 = copy.deepcopy(live); pol = next(k for k, v in l4["Resources"].items() if v["Type"] == "AWS::IAM::ManagedPolicy" or v["Type"] == "AWS::IAM::Policy")
l4["Resources"][pol]["Properties"]["PolicyDocument"]["Statement"].append({"Effect": "Allow", "Action": "s3:GetObject", "Resource": "*"})
rc, t = run(l4, "pre"); ck("an IAM policy difference: refused", rc, False, t)
l5 = copy.deepcopy(live); hk = next(k for k, v in l5["Resources"].items() if v["Type"] == "AWS::Lambda::Function" and k.startswith("Handler")); l5["Resources"][hk]["Properties"]["Timeout"] = 1
rc, t = run(l5, "pre"); ck("another Handler property (Timeout) differs: refused", rc, False, t)
l6 = copy.deepcopy(live); l6["Outputs"] = dict(l6.get("Outputs", {})); l6["Outputs"]["Extra"] = {"Value": "x"}
rc, t = run(l6, "pre"); ck("an output differs: refused", rc, False, t)
l7 = copy.deepcopy(live)
for v in l7["Resources"].values():
    tags = v.get("Properties", {}).get("Tags")
    if isinstance(tags, list):
        for tg in tags:
            if isinstance(tg, dict) and tg.get("Key") == "ogevia:deployment-status": tg["Value"] = "approved-SOMETHING-ELSE"
rc, t = run(l7, "pre"); ck("only the approval tag value differs besides the release change: accepted", rc, True, t)

# the verdict output names WHAT changed on a changed resource (the dry run of 2026-11-01 hid it)
l8 = copy.deepcopy(live); api = next(k for k, v in l8["Resources"].items() if v["Type"] == "AWS::ApiGatewayV2::Api")
l8["Resources"][api]["Properties"]["CorsConfiguration"]["AllowOrigins"] = ["https://only-one.example"]
rc, t = run(l8, "pre"); ck("a changed Api resource is refused", rc, False, t)
print("PASS the output names the changed property" if "AllowOrigins" in t and "https://only-one.example" in t else "FAIL the output does not name the changed property"); bad += 0 if ("AllowOrigins" in t and "https://only-one.example" in t) else 1

# ---- the narrow CORS allowance found by the production dry run of 2026-11-01: the live template lacks admin.ogevia.com and has app.ogevia.com once; the new build has [app, cloudfront, app, admin]
CORS = ["--allow-cors-add", "https://app.ogevia.com,https://admin.ogevia.com"]
def api_of(t): return next(k for k, v in t["Resources"].items() if v["Type"] == "AWS::ApiGatewayV2::Api")
def real_live():
    lv = simulated_live(); o = lv["Resources"][api_of(lv)]["Properties"]["CorsConfiguration"]["AllowOrigins"]
    assert o[0] == "https://app.ogevia.com" and isinstance(o[1], dict) and o[2:] == ["https://app.ogevia.com", "https://admin.ogevia.com"], o
    lv["Resources"][api_of(lv)]["Properties"]["CorsConfiguration"]["AllowOrigins"] = o[:2]; return lv
rl = real_live()
rc, t = run(rl, "pre"); ck("production's real difference (two origins) is refused WITHOUT the allowance", rc, False, t)
print("     " + "; ".join(l.strip() for l in t.splitlines() if l.strip().startswith(("+", "-", "~")))[:200])
rc, t = run(rl, "pre", extra=CORS); ck("the same difference is accepted WITH the allowance (exactly those two additions)", rc, True, t); print("     " + [l for l in t.splitlines() if l.startswith("Allowed CORS")][0][:160])
n3 = copy.deepcopy(new); n3["Resources"][api_of(n3)]["Properties"]["CorsConfiguration"]["AllowOrigins"].append("https://evil.example")
rc, t = run(rl, "pre", newt=n3, extra=CORS); ck("a third, unexpected origin is refused even with the allowance", rc, False, t)
l_nocf = copy.deepcopy(rl); l_nocf["Resources"][api_of(l_nocf)]["Properties"]["CorsConfiguration"]["AllowOrigins"] = ["https://app.ogevia.com"]
rc, t = run(l_nocf, "pre", extra=CORS); ck("a live origin missing (the build would ADD more than the two): refused", rc, False, t)
n4 = copy.deepcopy(new); n4["Resources"][api_of(n4)]["Properties"]["CorsConfiguration"]["AllowOrigins"] = [x for x in n4["Resources"][api_of(n4)]["Properties"]["CorsConfiguration"]["AllowOrigins"] if x != "https://admin.ogevia.com"]
rc, t = run(rl, "pre", newt=n4, extra=CORS); ck("the build adding only one of the two origins: refused", rc, False, t)
l_m = copy.deepcopy(rl); l_m["Resources"][api_of(l_m)]["Properties"]["CorsConfiguration"]["AllowMethods"] = ["GET"]
rc, t = run(l_m, "pre", extra=CORS); ck("CORS methods differ besides the origins: refused", rc, False, t)
l_h = copy.deepcopy(rl); l_h["Resources"][api_of(l_h)]["Properties"]["CorsConfiguration"]["AllowHeaders"] = ["authorization"]
rc, t = run(l_h, "pre", extra=CORS); ck("CORS headers differ besides the origins: refused", rc, False, t)
l_t = copy.deepcopy(rl); l_t["Resources"][api_of(l_t)]["Properties"]["Tags"]["environment"] = "prod"
rc, t = run(l_t, "pre", extra=CORS); ck("another property of the Api resource (a tag) differs besides the origins: refused", rc, False, t)
rc, t = run(rl, "post", extra=CORS); ck("after the deployment ('post') the allowance does not apply: a CORS difference is refused", rc, False, t)
print("GATE TEST PASSED" if bad == 0 else "GATE TEST FAILED"); sys.exit(1 if bad else 0)
