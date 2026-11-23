#!/usr/bin/env python3
"""Production release gate: enable the administrator sign-in override by adding exactly two API routes.

Read-only: no AWS calls. The operator supplies JSON files captured from, or synthesized for, the PRODUCTION API stack
(Ogevia-prd-ServiceVerificationApi). Nothing here changes the Lambda code, its configuration, IAM, the database or the website:
the Handler code that production already runs (SHA-256 98e84618... in production-ux-release.py) contains the override handlers, migration 0103 is in the
production ledger, and the web build already shows the action. The release only makes the two routes reachable.

  patch   LIVE.json CANDIDATE.json OUT.json   OUT = the captured live template plus exactly the two routes taken from the synthesized candidate
  changes CHANGESET.json                      the CloudFormation change set adds exactly those two routes and changes nothing else
  rollback-changes CHANGESET.json             the rollback change set removes exactly those two routes and changes nothing else
  routes  TEMPLATE.json present|absent        both routes are in (or both are absent from) a template
  equal   A.json B.json                       two templates are identical (the live stack was not changed by someone else in between)

Any other difference: exit 1 and the operator STOPS.
"""
import copy
import json
import pathlib
import sys

NEW = {
    'ApiPOSTv1caregiverscaregiverRecordIdsigninoverrideB56070DA': 'POST /v1/caregivers/{caregiverRecordId}/signin-override',
    'ApiGETv1signinoverrides231FC345': 'GET /v1/signin-overrides',
}
# Routes that stay OFF in production (bulk import, duplicate-staff review): they must not appear.
STAY_OFF = ['POST /v1/imports/{kind}', 'GET /v1/staff/duplicates', 'POST /v1/staff/{profileId}/merge']
# Accepted production routes that must still be there.
RETAINED = ['GET /v1/business-documents', 'POST /v1/business-documents', 'GET /v1/reports/missing-visits',
            'POST /v1/shifts/{shiftId}/missing-visit', 'POST /v1/checkin', 'POST /v1/clients/{clientId}/qr-card']
SIBLING = 'GET /v1/attention'
ROUTE = 'AWS::ApiGatewayV2::Route'
PROPS = {'ApiId', 'AuthorizationType', 'AuthorizerId', 'RouteKey', 'Target'}


def load(path):
    t = json.loads(pathlib.Path(path).read_text())
    if isinstance(t, dict) and 'TemplateBody' in t:
        t = t['TemplateBody']
    assert isinstance(t, dict) and isinstance(t.get('Resources'), dict), '%s is not a CloudFormation template' % path
    return t


def routes_of(t):
    return {r['Properties']['RouteKey']: k for k, r in t['Resources'].items() if r['Type'] == ROUTE}


def assert_production(t):
    handlers = [r for k, r in t['Resources'].items() if r['Type'] == 'AWS::Lambda::Function' and k.startswith('Handler')]
    assert len(handlers) == 1, 'expected one production Handler'
    e = handlers[0]['Properties']['Environment']['Variables']
    assert e['DB_NAME'] == 'ogevia_prd' and e['OGEVIA_ENV'] == 'prd', 'this is not the production API stack'
    assert e['DB_HOST'] == 'ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com', 'unexpected database host'
    keys = [r['Properties']['RouteKey'] for r in t['Resources'].values() if r['Type'] == ROUTE]
    assert len(keys) == len(set(keys)), 'duplicate route keys'
    return keys


def patch(live, cand):
    keys = assert_production(live)
    for k in NEW.values():
        assert k not in keys, 'production already has the route: ' + k
    for k in RETAINED:
        assert k in keys, 'accepted production route is missing: ' + k
    for k in STAY_OFF:
        assert k not in keys, 'a route that must stay off is in production: ' + k
    ckeys = [r['Properties']['RouteKey'] for r in cand['Resources'].values() if r['Type'] == ROUTE]
    assert len(ckeys) == len(set(ckeys)), 'duplicate candidate route keys'
    for k in STAY_OFF:
        assert k not in ckeys, 'the candidate enables a route that must stay off: ' + k
    for k in NEW.values():
        assert ckeys.count(k) == 1, 'the candidate lacks the route: ' + k
    lr = routes_of(live)
    assert SIBLING in lr, 'reference route missing from production: ' + SIBLING
    sib = live['Resources'][lr[SIBLING]]['Properties']
    assert sib['AuthorizationType'] == 'JWT'
    out = copy.deepcopy(live)
    for rid, key in NEW.items():
        assert rid not in live['Resources'], 'logical id already in use: ' + rid
        assert rid in cand['Resources'], 'the candidate has no resource ' + rid
        res = cand['Resources'][rid]
        assert res['Type'] == ROUTE and res['Properties']['RouteKey'] == key
        assert set(res) <= {'Type', 'Properties', 'Metadata'}, 'unexpected route attributes (DependsOn, conditions or other keys)'
        if 'Metadata' in res:  # the cdk CLI stamps every resource with its construct path; nothing else is accepted
            m = res['Metadata']
            assert isinstance(m, dict) and set(m) == {'aws:cdk:path'} and isinstance(m['aws:cdk:path'], str) \
                and m['aws:cdk:path'].startswith('Ogevia-prd-ServiceVerificationApi/Api/'), 'unexpected route metadata'
        p = res['Properties']
        assert set(p) == PROPS, 'unexpected route properties'
        assert p['AuthorizationType'] == 'JWT' and p['AuthorizerId'] == sib['AuthorizerId'], 'the route must use the same JWT authorizer as every other protected route'
        assert p['ApiId'] == sib['ApiId'] and p['Target'] == sib['Target'], 'the route must use the production API and the shared Handler integration'
        out['Resources'][rid] = copy.deepcopy(res)
    check = copy.deepcopy(out)
    for rid in NEW:
        del check['Resources'][rid]
    assert check == live, 'only the two routes may be added'
    return out


def check_changes(d, action):
    assert d['Status'] == 'CREATE_COMPLETE' and d['ExecutionStatus'] == 'AVAILABLE', 'change set is not ready to execute'
    changes = [c['ResourceChange'] for c in d['Changes']]
    assert len(changes) == len(NEW), 'the change set must contain exactly the two routes'
    assert {c['LogicalResourceId'] for c in changes} == set(NEW), 'unexpected resource in the change set'
    for c in changes:
        assert c['ResourceType'] == ROUTE and c['Action'] == action, 'every change must be a route %s' % action
        assert c.get('Replacement', 'False') != 'True'


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'patch':
        out = patch(load(sys.argv[2]), load(sys.argv[3]))
        pathlib.Path(sys.argv[4]).write_text(json.dumps(out, indent=2) + '\n')
        print('PASS: the live production template plus exactly two JWT routes; Handler, IAM, permissions, parameters and every other resource unchanged')
    elif cmd == 'changes':
        check_changes(json.loads(pathlib.Path(sys.argv[2]).read_text()), 'Add')
        print('PASS: the change set adds exactly the two sign-in override routes')
    elif cmd == 'rollback-changes':
        check_changes(json.loads(pathlib.Path(sys.argv[2]).read_text()), 'Remove')
        print('PASS: the rollback change set removes exactly the two sign-in override routes')
    elif cmd == 'routes':
        have = set(routes_of(load(sys.argv[2])))
        want = sys.argv[3]
        assert want in ('present', 'absent')
        assert (set(NEW.values()) <= have) if want == 'present' else not (set(NEW.values()) & have), 'override routes are not %s' % want
        print('PASS: both override routes are %s' % want)
    elif cmd == 'equal':
        assert json.loads(pathlib.Path(sys.argv[2]).read_text()) == json.loads(pathlib.Path(sys.argv[3]).read_text()), 'templates differ'
        print('PASS: identical')
    else:
        raise SystemExit('usage: patch LIVE CANDIDATE OUT | changes CS | rollback-changes CS | routes T present|absent | equal A B')
