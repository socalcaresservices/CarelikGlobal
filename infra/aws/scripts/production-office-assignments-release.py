#!/usr/bin/env python3
"""Production release of OFFICE ASSIGNMENTS, SERVICE COUNTIES, CAREGIVER COLOR and ASSIGNMENT HISTORY: exact ledger SQL for migrations 0111 and 0112 (one transaction), a code-only Handler patch,
and a route patch that adds exactly NINE routes (the eight officeAssignments routes and the one assignmentHistory route).

No AWS calls. It builds on production-offices-release.py (the reviewed helper used for the 0110 production release) and reuses its helpers; the ledger it expects is that release's result (109 rows with 0110).
The nine routes reuse the production API, the existing JWT authorizer and the shared Handler integration of a sibling route (GET /v1/attention). The Handler code is replaced by the code that has been running on TEST (checked by the operator).
  sql [local-test-database]     the one-transaction migration (guards the exact 109-row ledger, applies 0111 then 0112 as ogevia_owner, records both ledger rows)
  rollback-sql [local-database] the pinned down scripts (0112 then 0111) and the removal of both ledger rows, in one transaction
  ledger FILE [after]           the production ledger JSON equals the exact 109 rows (or 111 with 0111 and 0112)
  patch-code LIVE OUT KEY       the captured template with ONLY the Handler Code changed to KEY (an asset in the CDK asset bucket)
  patch-routes LIVE OUT         the captured template plus exactly the nine routes
  changes-code FILE             the change set contains only the Handler Code update (and the four reviewed dynamic ARN dependents)
  changes-routes-add FILE / changes-routes-remove FILE   the change set adds (or removes) exactly the nine routes and nothing else
  routes TEMPLATE present|absent    all nine routes are in (or all absent from) a template
  hash ZIP                      print the sha256 of the Handler's index.js
  deployed ZIP HASH             the deployed Handler's index.js has this sha256
  equal A B                     two templates are identical
Requires OGEVIA_UX_SOURCE_ROOT=<checkout at the release commit>.
"""
import copy
import hashlib
import json
import os
import pathlib
import re
import runpy
import sys

ROOT = pathlib.Path(os.environ['OGEVIA_UX_SOURCE_ROOT'])
HERE = ROOT / 'infra/aws/scripts'
P0110 = runpy.run_path(str(HERE / 'production-offices-release.py'))
UX = runpy.run_path(str(HERE / 'production-ux-release.py'))
literal, check_changes_ux = UX['literal'], UX['check_changes']
load, routes_of, assert_production, index_js_hash = P0110['load'], P0110['routes_of'], P0110['assert_production'], P0110['index_js_hash']
ASSETS = 'cdk-hnb659fds-assets-300094796789-us-west-2'
MIGRATIONS = [   # (version, up file, up sha256, down file, down sha256)
    ('0111', '0111_office_assignments_counties_colors.sql', 'd09dbb181b37e7d49c7127ee71962c63c7709bc72ee5187b588d6da6cb4926ed', '0111_office_assignments_counties_colors.down.sql', '556f9343795cf25a2dc9376bdc0b3e0f19fb66202547411e370f7c2a5d515af9'),
    ('0112', '0112_assignment_history.sql', 'e6c78065d02dc426b4661cc96d1673c46621005388c3a085d6c1511061d538b2', '0112_assignment_history.down.sql', '03808082cbcfd0a676931afb419938db08fe3eaa02e4706f207d95455fd79e5c'),
]
UP_DIR = ROOT / 'infra/aws/db/pending/migrations'
DOWN_DIR = ROOT / 'infra/aws/db/pending/rollback'
ROUTE = 'AWS::ApiGatewayV2::Route'
PROPS = {'ApiId', 'AuthorizationType', 'AuthorizerId', 'RouteKey', 'Target'}
SIBLING = 'GET /v1/attention'
# logical id -> (route key, CDK path segment): the ids and paths `cdk synth` produces for these routes (verified against a synthesis of the production stack with both switches on).
NEW = {
    'ApiPOSTv1officesofficeIdupdateA0A62D1B': ('POST /v1/offices/{officeId}/update', 'POST--v1--offices--{officeId}--update'),
    'ApiPOSTv1officesofficeIdreactivate979917A0': ('POST /v1/offices/{officeId}/reactivate', 'POST--v1--offices--{officeId}--reactivate'),
    'ApiGETv1peoplefacets69C143E7': ('GET /v1/people-facets', 'GET--v1--people-facets'),
    'ApiPOSTv1clientsclientIdoffices47DA6F02': ('POST /v1/clients/{clientId}/offices', 'POST--v1--clients--{clientId}--offices'),
    'ApiPOSTv1caregiverscaregiverRecordIdofficesC1965768': ('POST /v1/caregivers/{caregiverRecordId}/offices', 'POST--v1--caregivers--{caregiverRecordId}--offices'),
    'ApiPOSTv1clientsclientIdservicecounty2C20AB1E': ('POST /v1/clients/{clientId}/service-county', 'POST--v1--clients--{clientId}--service-county'),
    'ApiPOSTv1caregiverscaregiverRecordIdservicecounties97FEA4F0': ('POST /v1/caregivers/{caregiverRecordId}/service-counties', 'POST--v1--caregivers--{caregiverRecordId}--service-counties'),
    'ApiPOSTv1caregiverscaregiverRecordIdcolorA8B94D69': ('POST /v1/caregivers/{caregiverRecordId}/color', 'POST--v1--caregivers--{caregiverRecordId}--color'),
    'ApiGETv1assignmenthistory78D24E24': ('GET /v1/assignment-history', 'GET--v1--assignment-history'),
}
KEYS = [v[0] for v in NEW.values()]
STAY_OFF = ['POST /v1/imports/{kind}', 'GET /v1/staff/duplicates', 'POST /v1/staff/{profileId}/merge']   # these stay off in production
# routes the production API already has after the Offices release (the 0110 release): the release is refused if they are not there
RETAINED = ['GET /v1/business-documents', 'POST /v1/business-documents', 'GET /v1/reports/missing-visits', 'POST /v1/shifts/{shiftId}/missing-visit', 'POST /v1/checkin', 'POST /v1/clients/{clientId}/qr-card',
            'POST /v1/care-notifications/read', 'POST /v1/documents/{documentId}/cancel', 'POST /v1/document-types/{documentTypeId}/retire',
            'GET /v1/offices', 'GET /v1/client-offices', 'POST /v1/offices', 'POST /v1/offices/{officeId}/rename', 'POST /v1/offices/{officeId}/retire', 'POST /v1/clients/{clientId}/office']
LOCK = 4317113


def ledger_before():
    return P0110['ledger_after']()          # the production ledger after the 0110 release: 109 rows, 0110 last


def ledger_after():
    return ledger_before() + [dict(version=v, name=up, checksum=us) for v, up, us, _d, _ds in MIGRATIONS]


def _body(path, want_sha, what):
    body = pathlib.Path(path).read_bytes()
    assert hashlib.sha256(body).hexdigest() == want_sha, what + ' bytes changed'
    return body.decode()


def _guard(database, expected, message):
    assert database == 'ogevia_prd' or re.fullmatch(r'ogevia_test_[0-9a-f]{12}', database)
    return ["begin;", "set local lock_timeout='10s';", "set local statement_timeout='120s';", "select pg_advisory_xact_lock(%d);" % LOCK,
            "do $production_guard$ begin",
            f"if current_database() <> {literal(database)} then raise exception 'Wrong production database'; end if;",
            "if (select coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name,'checksum',checksum) order by version),'[]'::jsonb) from ogevia_meta.schema_migrations) <> "
            + literal(json.dumps(expected, separators=(',', ':'))) + "::jsonb then raise exception '" + message + "'; end if;",
            "end $production_guard$;"]


def migration_sql(database='ogevia_prd'):
    lines = _guard(database, ledger_before(), 'Production ledger differs from the accepted 109 rows')
    for v, up, us, _d, _ds in MIGRATIONS:
        lines += ['set local role ogevia_owner;', _body(UP_DIR / up, us, 'migration ' + v), 'reset role;',
                  'insert into ogevia_meta.schema_migrations(version,name,checksum) values (' + ','.join(literal(x) for x in (v, up, us)) + ');']
    return '\n'.join(lines + ['commit;']) + '\n'


def rollback_sql(database='ogevia_prd'):
    lines = _guard(database, ledger_after(), 'Production ledger is not exactly the 111 rows with 0111 and 0112')
    for v, _up, _us, d, ds in reversed(MIGRATIONS):          # 0112 first, then 0111
        lines += ['set local role ogevia_owner;', _body(DOWN_DIR / d, ds, 'rollback ' + v), 'reset role;', "delete from ogevia_meta.schema_migrations where version = '%s';" % v]
    return '\n'.join(lines + ['commit;']) + '\n'


def check_ledger(path, after=False):
    got = json.loads(pathlib.Path(path).read_text())
    assert got == (ledger_after() if after else ledger_before()), 'production ledger differs from the exact expected rows'


def patch_code(t, key):
    assert re.fullmatch(r'[0-9a-f]{64}\.zip', key), 'unexpected asset key'
    keys = assert_production(t)
    for k in KEYS + STAY_OFF:
        assert k not in keys, 'a route that must still be absent is in production: ' + k
    for k in RETAINED:
        assert k in keys, 'accepted production route is missing: ' + k
    new = copy.deepcopy(t)
    rid = [k for k, r in t['Resources'].items() if r['Type'] == 'AWS::Lambda::Function' and k.startswith('Handler')][0]
    p = new['Resources'][rid]['Properties']
    assert p['Runtime'] == 'nodejs24.x', 'production runtime changed'
    assert p['Environment']['Variables']['COGNITO_USER_POOL_ID'] in ('us-west-2_FHJoX71ca', {'Fn::ImportValue': 'Ogevia-prd-Auth:ExportsOutputRefUserPool19CF3AE1'}), 'dedicated production auth reference differs'
    p['Code'] = {'S3Bucket': ASSETS, 'S3Key': key}
    check = copy.deepcopy(new)
    check['Resources'][rid]['Properties']['Code'] = t['Resources'][rid]['Properties']['Code']
    assert check == t, 'only Handler Code may change'
    assert new != t, 'production already runs this code; inspect before retrying'
    return new


def patch_routes(live):
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
        out['Resources'][rid] = {'Type': ROUTE, 'Properties': props, 'Metadata': {'aws:cdk:path': 'Ogevia-prd-ServiceVerificationApi/Api/%s/Resource' % path}}
    check = copy.deepcopy(out)
    for rid in NEW:
        del check['Resources'][rid]
    assert check == live, 'only the nine routes may be added'
    return out


def check_route_changes(d, action):
    assert d['Status'] == 'CREATE_COMPLETE' and d['ExecutionStatus'] == 'AVAILABLE', 'change set is not ready to execute'
    changes = [c['ResourceChange'] for c in d['Changes']]
    assert len(changes) == len(NEW), 'the change set must contain exactly the nine routes'
    assert {c['LogicalResourceId'] for c in changes} == set(NEW), 'unexpected resource in the change set'
    for c in changes:
        assert c['ResourceType'] == ROUTE and c['Action'] == action, 'every change must be a route %s' % action
        assert c.get('Replacement', 'False') != 'True'


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'sql':
        print(migration_sql(sys.argv[2] if len(sys.argv) > 2 else 'ogevia_prd'), end='')
    elif cmd == 'rollback-sql':
        print(rollback_sql(sys.argv[2] if len(sys.argv) > 2 else 'ogevia_prd'), end='')
    elif cmd == 'ledger':
        after = len(sys.argv) > 3 and sys.argv[3] == 'after'
        check_ledger(sys.argv[2], after)
        print('PASS: exact production migration ledger and checksums (%s)' % ('111 rows with 0111 and 0112' if after else '109 rows, no 0111'))
    elif cmd == 'patch-code':
        pathlib.Path(sys.argv[3]).write_text(json.dumps(patch_code(load(sys.argv[2]), sys.argv[4]), indent=2) + '\n')
        print('PASS: the production template changes Handler Code only; routes, IAM, auth and every other resource unchanged')
    elif cmd == 'patch-routes':
        pathlib.Path(sys.argv[3]).write_text(json.dumps(patch_routes(load(sys.argv[2])), indent=2) + '\n')
        print('PASS: the production template plus exactly nine JWT routes (eight office assignments, one assignment history); everything else unchanged')
    elif cmd == 'changes-code':
        check_changes_ux(json.loads(pathlib.Path(sys.argv[2]).read_text()))
        print('PASS: Handler Code update with only the four reviewed dynamic ARN dependencies; no Handler replacement')
    elif cmd in ('changes-routes-add', 'changes-routes-remove'):
        add = cmd.endswith('add')
        check_route_changes(json.loads(pathlib.Path(sys.argv[2]).read_text()), 'Add' if add else 'Remove')
        print('PASS: the change set %s exactly the nine routes' % ('adds' if add else 'removes'))
    elif cmd == 'routes':
        have = set(routes_of(load(sys.argv[2])))
        want = sys.argv[3]
        assert want in ('present', 'absent')
        assert (set(KEYS) <= have) if want == 'present' else not (set(KEYS) & have), 'the nine routes are not %s' % want
        print('PASS: all nine routes are %s' % want)
    elif cmd == 'hash':
        print(index_js_hash(sys.argv[2]))
    elif cmd == 'deployed':
        assert index_js_hash(sys.argv[2]) == sys.argv[3], 'the deployed Handler is not the expected release code'
        print('PASS: the deployed production Handler is the release code')
    elif cmd == 'equal':
        assert json.loads(pathlib.Path(sys.argv[2]).read_text()) == json.loads(pathlib.Path(sys.argv[3]).read_text()), 'templates differ'
        print('PASS: identical')
    else:
        raise SystemExit('usage: sql | rollback-sql | ledger | patch-code | patch-routes | changes-code | changes-routes-add | changes-routes-remove | routes | hash | deployed | equal')
