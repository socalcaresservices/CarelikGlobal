#!/usr/bin/env python3
"""EXPECTED-ONLY gate for the UX redesign API-stack deployment on TEST (derived from diff_gate_0086.py, which was specific to the 8 readiness routes).
Read-only: compares two CloudFormation templates (JSON files) and exits 0 only if EVERY difference is on the allow-list below.

  python3 diff_gate_ux.py --live LIVE.json --new NEW.json [--expect pre|post]
      LIVE.json = `aws cloudformation get-template --stack-name Ogevia-prod-ServiceVerificationApi --template-stage Original --query TemplateBody --output json`
      NEW.json  = the synthesized Ogevia-prod-ServiceVerificationApi.template.json
      --expect pre  (default) the 3 new routes must be ADDED (the release is not deployed yet)
      --expect post           NO difference at all (the release is deployed); used after the deployment

ALLOW-LIST for --expect pre:
  * exactly these 3 AWS::ApiGatewayV2::Route resources are ADDED (by RouteKey), nothing else is added or removed;
  * the Lambda function whose logical id starts with `Handler` may change ONLY Properties.Code.S3Key and Metadata `aws:asset:path` (the new code asset);
  * everything else is identical: every other resource (IAM, permissions, integrations, authorizer, log groups, events), Parameters, Outputs, Conditions, Mappings,
    Rules, Transform, Description. AWS::CDK::Metadata is ignored; the value of the `ogevia:deployment-status` tag is ignored (it carries the approval reference).
Any other difference: exit 1 and the Operator STOPS. Nothing here talks to AWS.
"""
import argparse, copy, json, pathlib, sys

NEW_ROUTES = {
    "POST /v1/caregivers/{caregiverRecordId}/signin-override",
    "GET /v1/signin-overrides",
    "POST /v1/imports/{kind}",
}
SECTIONS = ["AWSTemplateFormatVersion", "Description", "Parameters", "Outputs", "Conditions", "Mappings", "Rules", "Transform"]


def norm(x):
    if isinstance(x, dict):
        return {k: ("<APPROVAL>" if k == "ogevia:deployment-status" else norm(v)) for k, v in x.items()}
    if isinstance(x, list):
        out = [norm(i) for i in x]
        if out and all(isinstance(i, dict) and "Key" in i for i in out):
            for i in out:
                if i.get("Key") == "ogevia:deployment-status" and "Value" in i:
                    i["Value"] = "<APPROVAL>"
            out.sort(key=lambda i: json.dumps(i, sort_keys=True))
        return out
    return x


def load(path):
    with open(path) as fh:
        t = json.load(fh)
    if isinstance(t, dict) and "TemplateBody" in t:
        t = t["TemplateBody"]
    if not isinstance(t, dict) or not isinstance(t.get("Resources"), dict):
        raise ValueError("%s is not a CloudFormation template" % path)
    return t


def isolated_gate(baseline_dir, candidate_dir):
    """Compare two local CDK assemblies; never contacts AWS. Defaults remain shared.

    First run the ordinary live API -> shared UX gate separately. For NetworkEgress
    and Observability, compare the live templates to the shared baseline as well.
    This second gate permits only the reviewed separation delta, never live drift.
    """
    def assembly(directory):
        return {p.name: norm(load(p)) for p in pathlib.Path(directory).glob('Ogevia-prod-*.template.json')}
    old, new = assembly(baseline_dir), assembly(candidate_dir)
    secret_name = 'Ogevia-prod-DatabaseSecret.template.json'
    assert old and secret_name not in old and set(new) == set(old) | {secret_name}, 'unexpected stack set'
    expected = copy.deepcopy(old)
    api = expected['Ogevia-prod-ServiceVerificationApi.template.json']['Resources']
    secret_ref = {'Fn::ImportValue': 'Ogevia-prod-DatabaseSecret:ExportsOutputRefAppDatabaseSecret8F772B622E5A091B'}
    handler = api['Handler886CB40B']['Properties']['Environment']['Variables']
    assert handler['DB_NAME'] == 'ogevia_sv_test' and handler['DB_HOST'] == 'ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com'
    handler['DB_HOST'] = 'ogevia-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com'
    handler['DB_SECRET_ARN'] = secret_ref
    policy = api['HandlerPolicy7544C855']['Properties']['PolicyDocument']['Statement']
    next(s for s in policy if s.get('Sid') == 'ReadAppDatabaseSecret')['Resource'] = secret_ref
    api['IsolatedTestDatabaseIngress'] = {'Type': 'AWS::EC2::SecurityGroupIngress', 'Properties': {
        'Description': 'TEST API access to the isolated TEST database only', 'FromPort': 5432,
        'GroupId': 'sg-0bc0f1315fd0feaf2', 'IpProtocol': 'tcp',
        'SourceSecurityGroupId': 'sg-064ffce3bcbe8eb3b', 'ToPort': 5432}}
    endpoint = expected['Ogevia-prod-NetworkEgress.template.json']['Resources']['SecretsManagerEndpoint5E83C66B']['Properties']['PolicyDocument']['Statement']
    statement = next(s for s in endpoint if s.get('Action') == 'secretsmanager:GetSecretValue')
    assert statement['Resource'] == [
        'arn:aws:secretsmanager:us-west-2:300094796789:secret:ogevia/database/app-JsOTVQ',
        'arn:aws:secretsmanager:us-west-2:300094796789:secret:ogevia/prd/database/app-??????']
    statement['Resource'].append('arn:aws:secretsmanager:us-west-2:300094796789:secret:ogevia/test/database/app-??????')
    for r in expected['Ogevia-prod-Observability.template.json']['Resources'].values():
        for d in r.get('Properties', {}).get('Dimensions', []):
            if d['Name'] == 'DBInstanceIdentifier':
                assert d['Value'] == 'ogevia-prod-postgres'
                d['Value'] = 'ogevia-postgres'
    for name in old:
        assert expected[name] == new[name], 'unexpected separation change in ' + name
    secret_template = new[secret_name]
    resources = {k: v for k, v in secret_template['Resources'].items() if v['Type'] != 'AWS::CDK::Metadata'}
    assert set(resources) == {'AppDatabaseSecret8F772B62'}, 'unexpected credential-stack resources'
    secret = resources['AppDatabaseSecret8F772B62']
    assert secret['Type'] == 'AWS::SecretsManager::Secret'
    assert secret['DeletionPolicy'] == secret['UpdateReplacePolicy'] == 'Retain'
    props = secret['Properties']
    assert set(props) == {'Name', 'Description', 'GenerateSecretString', 'Tags'}
    assert props['Name'] == 'ogevia/test/database/app'
    assert props['GenerateSecretString'] == {'ExcludePunctuation': True, 'GenerateStringKey': 'password',
        'IncludeSpace': False, 'PasswordLength': 40,
        'SecretStringTemplate': '{"username":"ogevia_test_app","dbname":"ogevia_sv_test"}'}
    assert secret_template.get('Outputs') == {'AppSecretName': {'Value': {'Fn::Select': [0, {
        'Fn::Split': ['-', {'Fn::Select': [6, {'Fn::Split': [':', {'Ref': 'AppDatabaseSecret8F772B62'}]}]}]}]}},
        'ExportsOutputRefAppDatabaseSecret8F772B622E5A091B': {
        'Value': {'Ref': 'AppDatabaseSecret8F772B62'}, 'Export': {
            'Name': 'Ogevia-prod-DatabaseSecret:ExportsOutputRefAppDatabaseSecret8F772B622E5A091B'}}}
    for s in ['Parameters', 'Conditions', 'Mappings', 'Rules', 'Transform']:
        reference = old['Ogevia-prod-ServiceVerificationApi.template.json'].get(s)
        if s == 'Parameters':
            reference = {k: v for k, v in reference.items() if k not in ['ClientQrEncryptionKey', 'RepairCodeBucket', 'RepairCodeKey']}
        assert secret_template.get(s) == reference, 'unexpected credential-stack ' + s
    print('ISOLATED EXPECTED-ONLY: YES (API target/credential/ingress, additive endpoint grant, TEST RDS alarms, retained secret)')
    return 0


def main():
    if len(sys.argv) == 4 and sys.argv[1] == '--isolated-assemblies':
        try:
            return isolated_gate(sys.argv[2], sys.argv[3])
        except (AssertionError, KeyError, ValueError, StopIteration) as e:
            print('ISOLATED EXPECTED-ONLY: NO', str(e))
            return 1
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", required=True)
    ap.add_argument("--new", required=True)
    ap.add_argument("--expect", choices=["pre", "post"], default="pre")
    a = ap.parse_args()
    live, new = load(a.live), load(a.new)
    bad = []
    for s in SECTIONS:
        if norm(live.get(s)) != norm(new.get(s)):
            bad.append("section %s differs" % s)
    lr = {k: v for k, v in live["Resources"].items() if v.get("Type") != "AWS::CDK::Metadata"}
    nr = {k: v for k, v in new["Resources"].items() if v.get("Type") != "AWS::CDK::Metadata"}
    removed = sorted(set(lr) - set(nr))
    added = sorted(set(nr) - set(lr))
    for k in removed:
        bad.append("REMOVED resource %s (%s)" % (k, lr[k].get("Type")))
    added_keys = set()
    for k in added:
        r = nr[k]
        rk = (r.get("Properties") or {}).get("RouteKey")
        if r.get("Type") == "AWS::ApiGatewayV2::Route" and rk in NEW_ROUTES:
            added_keys.add(rk)
        else:
            bad.append("UNEXPECTED added resource %s (%s %s)" % (k, r.get("Type"), rk or ""))
    if a.expect == "pre" and added_keys != NEW_ROUTES:
        bad.append("expected the 3 new routes to be added; missing: %s" % sorted(NEW_ROUTES - added_keys))
    if a.expect == "post" and added:
        bad.append("expected NO difference after deployment, but %d resources would be added" % len(added))
    changed_handler = []
    for k in sorted(set(lr) & set(nr)):
        l, n = norm(lr[k]), norm(nr[k])
        if l == n:
            continue
        if lr[k].get("Type") == "AWS::Lambda::Function" and k.startswith("Handler"):
            l2, n2 = json.loads(json.dumps(l)), json.loads(json.dumps(n))
            for d in (l2, n2):
                d.get("Properties", {}).get("Code", {}).pop("S3Key", None)
                d.get("Properties", {}).get("Code", {}).pop("S3Bucket", None)
                d.get("Metadata", {}).pop("aws:asset:path", None)
                if not d.get("Metadata"):
                    d.pop("Metadata", None)
            if l2 == n2 and nr[k].get("Properties", {}).get("Code", {}).get("S3Bucket") == "cdk-hnb659fds-assets-300094796789-us-west-2":
                changed_handler.append(k)
                continue
        bad.append("CHANGED resource %s (%s)" % (k, lr[k].get("Type")))
    if a.expect == "post" and changed_handler:
        bad.append("expected NO difference after deployment, but the Handler code asset still differs")
    print("added: %d route(s) %s" % (len(added_keys), "(the 3 expected)" if added_keys == NEW_ROUTES else sorted(added_keys)))
    print("Handler code asset changed: %s" % (", ".join(changed_handler) or "no"))
    if bad:
        print("EXPECTED-ONLY: NO")
        for b in bad:
            print("  VIOLATION", b)
        return 1
    print("EXPECTED-ONLY: YES")
    return 0


if __name__ == "__main__":
    sys.exit(main())
