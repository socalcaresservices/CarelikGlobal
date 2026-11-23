#!/usr/bin/env python3
"""Production: turn the request-cleanup switch ON by adding exactly three API routes to the LIVE production template.

Follows production-signin-override-release.py (the 2026-11-15 production release, branch claude/keen-hawking-e9o2jg), adapted. Read-only: no AWS calls.
The three routes reuse the production API, the existing JWT authorizer and the shared Handler integration of a sibling route (GET /v1/attention). Nothing here
changes the Handler code (production already runs the release code, see production-0109-release.py), IAM, permissions, parameters, the database or the website.

  patch LIVE.json OUT.json      OUT = the captured live template plus exactly the three routes
  changes CHANGESET.json        the CloudFormation change set adds exactly those three routes and changes nothing else
  rollback-changes CHANGESET    the rollback change set removes exactly those three routes and nothing else
  routes TEMPLATE present|absent  all three routes are in (or all absent from) a template
  deployed ZIP                  the deployed Handler's index.js is this release's code (so the routes have handlers behind them)
  equal A B                     two templates are identical
Any other difference: exit 1 and the operator STOPS.
"""
import copy
import hashlib
import json
import pathlib
import sys
import zipfile

NEW = {
    'ApiPOSTv1carenotificationsread36182164': ('POST /v1/care-notifications/read', 'POST--v1--care-notifications--read'),
    'ApiPOSTv1documentsdocumentIdcancelB924AA20': ('POST /v1/documents/{documentId}/cancel', 'POST--v1--documents--{documentId}--cancel'),
    'ApiPOSTv1documenttypesdocumentTypeIdretireB9059636': ('POST /v1/document-types/{documentTypeId}/retire', 'POST--v1--document-types--{documentTypeId}--retire'),
}
KEYS = [v[0] for v in NEW.values()]
JS_HASH = 'a8b8387856d23e82d586a47113018fed84a1a2dccc6d61f1db6b3df3aa6336c6'
# Routes that stay OFF in production (bulk import, duplicate-staff review): they must not appear.
STAY_OFF = ['POST /v1/imports/{kind}', 'GET /v1/staff/duplicates', 'POST /v1/staff/{profileId}/merge']
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


def patch(live):
    keys = assert_production(live)
    for k in KEYS:
        assert k not in keys, 'production already has the route: ' + k
    for k in RETAINED:
        assert k in keys, 'accepted production route is missing: ' + k
    for k in STAY_OFF:
        assert k not in keys, 'a route that must stay off is in production: ' + k
    lr = routes_of(live)
    assert SIBLING in lr, 'reference route missing from production: ' + SIBLING
    sib = live['Resources'][lr[SIBLING]]['Properties']
    assert set(sib) == PROPS and sib['AuthorizationType'] == 'JWT', 'the reference route does not have the expected shape'
    out = copy.deepcopy(live)
    for rid, (key, path) in NEW.items():
        assert rid not in live['Resources'], 'logical id already in use: ' + rid
        props = copy.deepcopy(sib)
        props['RouteKey'] = key
        out['Resources'][rid] = {'Type': ROUTE, 'Properties': props,
                                 'Metadata': {'aws:cdk:path': 'Ogevia-prd-ServiceVerificationApi/Api/%s/Resource' % path}}
    check = copy.deepcopy(out)
    for rid in NEW:
        del check['Resources'][rid]
    assert check == live, 'only the three routes may be added'
    return out


def check_changes(d, action):
    assert d['Status'] == 'CREATE_COMPLETE' and d['ExecutionStatus'] == 'AVAILABLE', 'change set is not ready to execute'
    changes = [c['ResourceChange'] for c in d['Changes']]
    assert len(changes) == len(NEW), 'the change set must contain exactly the three routes'
    assert {c['LogicalResourceId'] for c in changes} == set(NEW), 'unexpected resource in the change set'
    for c in changes:
        assert c['ResourceType'] == ROUTE and c['Action'] == action, 'every change must be a route %s' % action
        assert c.get('Replacement', 'False') != 'True'


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'patch':
        out = patch(load(sys.argv[2]))
        pathlib.Path(sys.argv[3]).write_text(json.dumps(out, indent=2) + '\n')
        print('PASS: the live production template plus exactly three JWT routes; Handler, IAM, permissions, parameters and every other resource unchanged')
    elif cmd == 'changes':
        check_changes(json.loads(pathlib.Path(sys.argv[2]).read_text()), 'Add')
        print('PASS: the change set adds exactly the three request-cleanup routes')
    elif cmd == 'rollback-changes':
        check_changes(json.loads(pathlib.Path(sys.argv[2]).read_text()), 'Remove')
        print('PASS: the rollback change set removes exactly the three request-cleanup routes')
    elif cmd == 'routes':
        have = set(routes_of(load(sys.argv[2])))
        want = sys.argv[3]
        assert want in ('present', 'absent')
        assert (set(KEYS) <= have) if want == 'present' else not (set(KEYS) & have), 'request-cleanup routes are not %s' % want
        print('PASS: all three request-cleanup routes are %s' % want)
    elif cmd == 'deployed':
        with zipfile.ZipFile(sys.argv[2]) as z:
            info = z.getinfo('index.js'); assert info.file_size <= 10_000_000
            assert hashlib.sha256(z.read(info)).hexdigest() == JS_HASH, 'the deployed Handler is not the release code: the routes would have no handlers'
        print('PASS: the deployed production Handler is the release code')
    elif cmd == 'equal':
        assert json.loads(pathlib.Path(sys.argv[2]).read_text()) == json.loads(pathlib.Path(sys.argv[3]).read_text()), 'templates differ'
        print('PASS: identical')
    else:
        raise SystemExit('usage: patch LIVE OUT | changes CS | rollback-changes CS | routes T present|absent | deployed ZIP | equal A B')
