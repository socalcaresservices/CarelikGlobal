#!/usr/bin/env python3
"""Read-only check that a synthesized CDK assembly IS the approved candidate's TEST API stack, and (optionally) that the LIVE stack template equals the recorded baseline.

  python3 candidate_assembly_check.py --assembly DIR                          # the assembly the operator is about to deploy
  python3 candidate_assembly_check.py --live-template FILE                    # `aws cloudformation get-template --template-stage Original` of the live API stack
  (both options may be given together)

Pins (computed by synthesizing the two commits locally in deploy mode, no AWS; the synthesis is reproducible: two syntheses of the baseline gave identical asset hashes):
  BASELINE d82fefcd37407d837e7c94f6ac57a907ea286ed1 : the application deployed to TEST by Release 0052 (owner's Phase C statement, 2026-10-14)
  CANDIDATE 3159e520a7b9bc7006ee82d526a907622d30d97c : this release.
The comparison ignores exactly what is expected to differ: the Handler's Code (its S3 key), CDKMetadata, the added resources, and the VALUE of the
`ogevia:deployment-status` tag (it carries the approval reference, which differs between deployments). Anything else that differs is reported and fails.
Exit 0 = all checks passed; 1 = a check failed; 2 = usage or unreadable input.
"""
import argparse, hashlib, json, os, sys

API_STACK = "Ogevia-prod-ServiceVerificationApi"
TEST_STACKS = ["Ogevia-prod-EvidenceStorage", "Ogevia-prod-NetworkEgress", "Ogevia-prod-WebHosting", "Ogevia-prod-ServiceVerificationApi", "Ogevia-prod-Observability"]
BASELINE_COMMIT = "d82fefcd37407d837e7c94f6ac57a907ea286ed1"
CANDIDATE_COMMIT = "3159e520a7b9bc7006ee82d526a907622d30d97c"
BASELINE_HANDLER_KEY = "2fcda02d87dfb6eb35aefa22a88b95cc36675c526cb696094a87b9d1e17b125c.zip"
CANDIDATE_HANDLER_KEY = "929cdb1bde9bbf18025dc36f5cc61210246ca048efa6d6b51147cf4c22b24ab0.zip"
IDENTITY_HANDLER_KEY = "7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759.zip"
CANDIDATE_ROUTES = 228
BASELINE_FINGERPRINT = "dab82a838c974501569fc878926131d77e93c9c802c1f0d1f1c800daa9434a84"
EXPECTED_ADDED_IDS = ["ApiGETv1actionissuesCB410881", "ApiGETv1actionissueshistory0AA2C421", "ApiGETv1appearance2768A682", "ApiGETv1attentionoverviewC8401454", "ApiGETv1attentionsettingsFC87E059", "ApiGETv1authorizationimpacts42C23847", "ApiGETv1authorizationsmissingrateE1211588", "ApiGETv1caregiverload9C8E4F35", "ApiGETv1caregiverscaregiverRecordIdcomplianceDEC311EF", "ApiGETv1caregiverscaregiverRecordIdonboarding80F3EBCD", "ApiGETv1clientdocumenttypes735F7165", "ApiGETv1clientdocumentversionsversionIdfile7633CF23", "ApiGETv1clientduplicatesFB2395F7", "ApiGETv1clientsclientIdaudit66C82669", "ApiGETv1clientsclientIddocuments56B7D5EA", "ApiGETv1clientsclientIdissuehistoryE2EEE89E", "ApiGETv1clientsclientIdreadiness1A9AB078", "ApiGETv1complianceholds16979998", "ApiGETv1exports20B0BE3A", "ApiGETv1hourlimits0A9FC1C0", "ApiGETv1notifications3FC140AB", "ApiGETv1notificationsettings0EC96E4E", "ApiGETv1onboardingoverview576E72E3", "ApiGETv1onboardingrequirementsD019220F", "ApiGETv1reportsagencyperformanceEA027471", "ApiGETv1reportsaudit84F380E6", "ApiGETv1reportsmonthlychainAAB0221B", "ApiGETv1shiftpickups3C2F489C", "ApiGETv1shiftstoreconcileCA1E24DD", "ApiGETv1visitsvisitIdauthorizationreview17A2E5D5", "ApiGETv1workhourpolicy09A01356", "ApiPOSTv1appearanceme5C17F0BE", "ApiPOSTv1appearanceorganizationC4A4D3E7", "ApiPOSTv1attentionsettings94382FFD", "ApiPOSTv1authorizationimpactsimpactIdacknowledgeF4FE6C85", "ApiPOSTv1caregiverscaregiverRecordIdbackgroundcheckstatus861B1D5F", "ApiPOSTv1caregiverscaregiverRecordIdbackgroundcheckverifyD5C5DFDA", "ApiPOSTv1caregiverscaregiverRecordIdhiredateE134726C", "ApiPOSTv1caregiverscaregiverRecordIdonboardingitemsE0D7DCAB", "ApiPOSTv1caregiverscaregiverRecordIdonboardingstart8F424388", "ApiPOSTv1clientdocumentrequirements52A0D421", "ApiPOSTv1clientdocumenttypes2106DA85", "ApiPOSTv1clientdocumentversionsversionIdreviewF3560F0A", "ApiPOSTv1clientsclientIddocumentsdocumentTypeIdversionsC9E9AA9B", "ApiPOSTv1clientsclientIdserviceholds797C4D59", "ApiPOSTv1clientsclientIdstageC4A60AAB", "ApiPOSTv1clientserviceholdsholdIdrelease50FFCD6D", "ApiPOSTv1compliancesweep97A5DFAC", "ApiPOSTv1exportsEF3C9CCD", "ApiPOSTv1hourlimitsBCA60D4D", "ApiPOSTv1notificationsettings6CFF8919", "ApiPOSTv1notificationsreadAF2756D5", "ApiPOSTv1onboardingrequirementsB171A381", "ApiPOSTv1shiftpickupsrequestIdconfirmCFFFEE2B", "ApiPOSTv1shiftpickupsrequestIddeclineE60AAF87", "ApiPOSTv1shiftsshiftIdmakeup47BE68AE", "ApiPOSTv1shiftsshiftIdpickupwithdraw747E6AE6", "ApiPOSTv1shiftsshiftIdreconcile859F7007", "ApiPOSTv1visitsvisitIdauthorizationreviewresolveE544E729", "ComplianceSweep51D1109D", "ComplianceSweepAllowEventRuleOgeviaprodServiceVerificationApiHandlerC405E486F425DBBB"]


def _norm_tags(x):
    if isinstance(x, dict):
        out = {}
        for k, v in x.items():
            if k == "ogevia:deployment-status":
                out[k] = "<APPROVAL>"
            elif k == "Tags" and isinstance(v, list):
                out[k] = sorted((_norm_tag(t) for t in v), key=lambda t: json.dumps(t, sort_keys=True))
            else:
                out[k] = _norm_tags(v)
        return out
    if isinstance(x, list):
        return [_norm_tags(i) for i in x]
    return x


def _norm_tag(t):
    if isinstance(t, dict) and t.get("Key") == "ogevia:deployment-status":
        return {"Key": t["Key"], "Value": "<APPROVAL>"}
    return _norm_tags(t)


def fingerprint(template, exclude_ids=()):
    res = {}
    for k, v in template["Resources"].items():
        if k in exclude_ids or v.get("Type") == "AWS::CDK::Metadata":
            continue
        v = json.loads(json.dumps(v))
        if v.get("Type") == "AWS::Lambda::Function" and k.startswith("Handler") and not k.startswith("IdentityHandler"):
            v.get("Properties", {}).pop("Code", None)
            v.pop("Metadata", None)  # carries the asset path (the code hash)
        res[k] = v
    body = _norm_tags({"Description": template.get("Description"), "Parameters": template.get("Parameters"), "Outputs": template.get("Outputs"), "Rules": template.get("Rules"), "Resources": res})
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def lambda_keys(template):
    out = {}
    for k, v in template["Resources"].items():
        if v.get("Type") == "AWS::Lambda::Function":
            out[k] = v.get("Properties", {}).get("Code", {}).get("S3Key")
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--assembly")
    ap.add_argument("--live-template")
    a = ap.parse_args(argv)
    if not a.assembly and not a.live_template:
        ap.print_usage(sys.stderr); return 2
    problems = []

    def need(ok, text):
        print(("PASS " if ok else "FAIL ") + text)
        if not ok:
            problems.append(text)

    if a.assembly:
        try:
            files = sorted(os.listdir(a.assembly))
            template = json.load(open(os.path.join(a.assembly, API_STACK + ".template.json")))
        except (OSError, ValueError) as e:
            print("FAIL cannot read the assembly (%s)" % e); return 2
        templates = sorted(f[:-len(".template.json")] for f in files if f.endswith(".template.json"))
        need(templates == sorted(TEST_STACKS), "the assembly holds exactly the five TEST stacks %s (found %s); no Ogevia-prd-* stack" % (TEST_STACKS, templates))
        keys = lambda_keys(template)
        handler = [v for k, v in keys.items() if k.startswith("Handler")]
        ident = [v for k, v in keys.items() if k.startswith("IdentityHandler")]
        need(handler == [CANDIDATE_HANDLER_KEY], "Handler code asset is the candidate's build (%s...), found %s" % (CANDIDATE_HANDLER_KEY[:12], [h[:12] if h else h for h in handler]))
        need(ident == [IDENTITY_HANDLER_KEY], "IdentityHandler code asset is unchanged from the baseline (%s...), found %s" % (IDENTITY_HANDLER_KEY[:12], [h[:12] if h else h for h in ident]))
        types = [v["Type"] for v in template["Resources"].values()]
        need(types.count("AWS::ApiGatewayV2::Route") == CANDIDATE_ROUTES, "%d API routes (found %d)" % (CANDIDATE_ROUTES, types.count("AWS::ApiGatewayV2::Route")))
        rules = [v for v in template["Resources"].values() if v["Type"] == "AWS::Events::Rule"]
        need(len(rules) == 1 and rules[0]["Properties"].get("State") == "ENABLED", "exactly one EventBridge rule (ComplianceSweep) and its deployment state is explicitly ENABLED (found %s)" % [r["Properties"].get("State") for r in rules])
        need(types.count("AWS::Lambda::Permission") == 2, "exactly two Lambda invoke permissions: API Gateway and the rule (found %d)" % types.count("AWS::Lambda::Permission"))
        missing = [i for i in EXPECTED_ADDED_IDS if i not in template["Resources"]]
        need(not missing, "all %d expected added resources are present (missing: %s)" % (len(EXPECTED_ADDED_IDS), missing[:3]))
        fp = fingerprint(template, EXPECTED_ADDED_IDS)
        need(fp == BASELINE_FINGERPRINT, "everything else equals the baseline %s (no change to IAM, environment, outputs, other functions or resources): fingerprint %s..." % (BASELINE_COMMIT[:7], fp[:12]))
    if a.live_template:
        try:
            live = json.load(open(a.live_template))
            if "TemplateBody" in live:
                live = live["TemplateBody"]
        except (OSError, ValueError) as e:
            print("FAIL cannot read the live template (%s)" % e); return 2
        keys = lambda_keys(live)
        handler = [v for k, v in keys.items() if k.startswith("Handler")]
        need(handler == [BASELINE_HANDLER_KEY], "LIVE Handler code asset is the baseline %s build (%s...), found %s" % (BASELINE_COMMIT[:7], BASELINE_HANDLER_KEY[:12], [h[:12] if h else h for h in handler]))
        fp = fingerprint(live)
        need(fp == BASELINE_FINGERPRINT, "LIVE template equals the recorded baseline apart from the code asset and the approval tag: fingerprint %s..." % fp[:12])
        if fp != BASELINE_FINGERPRINT:
            print("NOTE the live stack is not the recorded baseline. Do NOT treat commit %s as the rollback target; use the captured live artifacts (procedure, section Recovery)." % BASELINE_COMMIT[:7])
    print("PASS all checks" if not problems else "STOP: %d check(s) failed" % len(problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
