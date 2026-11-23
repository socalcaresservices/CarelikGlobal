#!/usr/bin/env python3
"""Production release of OFFICES plus request cleanup: exact ledger SQL for migration 0110, a code-only Handler patch, and a route patch that adds exactly NINE routes.

No AWS calls. It follows production-0109-release.py and production-request-cleanup-routes-release.py (both reviewed and used in production) and reuses their helpers.
The nine routes are the three request-cleanup routes (production has the switch OFF) and the six office routes. They reuse the production API, the existing JWT authorizer and the
shared Handler integration of a sibling route (GET /v1/attention). The Handler code is replaced by the code that has been running on TEST (checked by the operator).
  sql [local-test-database]     the one-transaction migration (guards the exact 108-row ledger, applies 0110 as ogevia_owner, records the ledger row)
  rollback-sql [local-database] the pinned down script and the removal of the 0110 ledger row, in one transaction
  ledger FILE [after]           the production ledger JSON equals the exact 108 rows (or 109 with 0110)
  patch-code LIVE OUT KEY       the captured template with ONLY the Handler Code changed to KEY (an asset in the CDK asset bucket)
  patch-routes LIVE OUT         the captured template plus exactly the nine routes
  changes-code FILE             the change set contains only the Handler Code update (and the four reviewed dynamic ARN dependents)
  changes-routes FILE [Add|Remove] / changes-routes-add FILE / changes-routes-remove FILE   the change set adds (or removes) exactly the nine routes and nothing else
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
import zipfile

ROOT = pathlib.Path(os.environ['OGEVIA_UX_SOURCE_ROOT'])
HERE = ROOT / 'infra/aws/scripts'
P109 = runpy.run_path(str(HERE / 'production-0109-release.py'))
UX = runpy.run_path(str(HERE / 'production-ux-release.py'))
literal, check_changes_ux = UX['literal'], UX['check_changes']
ASSETS = 'cdk-hnb659fds-assets-300094796789-us-west-2'
UP = ROOT / 'infra/aws/db/pending/migrations/0110_offices.sql'
DOWN = ROOT / 'infra/aws/db/pending/rollback/0110_offices.down.sql'
UP_NAME, UP_VERSION = '0110_offices.sql', '0110'
UP_SHA = '76dc0f2a8f8e5a080499f7c4514c718c40403ac6772eedbf841a7c22f3597951'
DOWN_SHA = 'db1c19d88a715752189bcb9dcbed2a96c304a409c0663bf61f6b11c291a3c15a'
ROUTE = 'AWS::ApiGatewayV2::Route'
PROPS = {'ApiId', 'AuthorizationType', 'AuthorizerId', 'RouteKey', 'Target'}
SIBLING = 'GET /v1/attention'
# logical id -> (route key, CDK path segment). The ids and paths are the ones `cdk synth` produces for these routes (verified against a synthesis of this commit).
NEW = {
    'ApiPOSTv1carenotificationsread36182164': ('POST /v1/care-notifications/read', 'POST--v1--care-notifications--read'),
    'ApiPOSTv1documentsdocumentIdcancelB924AA20': ('POST /v1/documents/{documentId}/cancel', 'POST--v1--documents--{documentId}--cancel'),
    'ApiPOSTv1documenttypesdocumentTypeIdretireB9059636': ('POST /v1/document-types/{documentTypeId}/retire', 'POST--v1--document-types--{documentTypeId}--retire'),
    'ApiGETv1offices49969B79': ('GET /v1/offices', 'GET--v1--offices'),
    'ApiGETv1clientofficesDA8F1F34': ('GET /v1/client-offices', 'GET--v1--client-offices'),
    'ApiPOSTv1offices4301D2D3': ('POST /v1/offices', 'POST--v1--offices'),
    'ApiPOSTv1officesofficeIdrenameBBB7BE62': ('POST /v1/offices/{officeId}/rename', 'POST--v1--offices--{officeId}--rename'),
    'ApiPOSTv1officesofficeIdretireCF76B9F0': ('POST /v1/offices/{officeId}/retire', 'POST--v1--offices--{officeId}--retire'),
    'ApiPOSTv1clientsclientIdofficeD78D1374': ('POST /v1/clients/{clientId}/office', 'POST--v1--clients--{clientId}--office'),
}
KEYS = [v[0] for v in NEW.values()]
STAY_OFF = ['POST /v1/imports/{kind}', 'GET /v1/staff/duplicates', 'POST /v1/staff/{profileId}/merge']   # these stay off in production (the two sign-in override routes are live and allowed)
RETAINED = ['GET /v1/business-documents', 'POST /v1/business-documents', 'GET /v1/reports/missing-visits', 'POST /v1/shifts/{shiftId}/missing-visit', 'POST /v1/checkin', 'POST /v1/clients/{clientId}/qr-card']


def load(path):
    t = json.loads(pathlib.Path(path).read_text())
    if isinstance(t, dict) and 'TemplateBody' in t:
        t = t['TemplateBody']
    assert isinstance(t, dict) and isinstance(t.get('Resources'), dict), '%s is not a CloudFormation template' % path
    return t


def routes_of(t):
    return {r['Properties']['RouteKey']: k for k, r in t['Resources'].items() if r['Type'] == ROUTE}


def ledger_before():
    return P109['ledger_after']()          # the production ledger after the 0109 release: 108 rows


def ledger_after():
    return ledger_before() + [dict(version=UP_VERSION, name=UP_NAME, checksum=UP_SHA)]


def migration_sql(database='ogevia_prd'):
    assert database == 'ogevia_prd' or re.fullmatch(r'ogevia_test_[0-9a-f]{12}', database)
    body = UP.read_bytes()
    assert hashlib.sha256(body).hexdigest() == UP_SHA, 'migration 0110 bytes changed'
    expected = json.dumps(ledger_before(), separators=(',', ':'))
    return '\n'.join([
        "begin;", "set local lock_timeout='10s';", "set local statement_timeout='120s';",
        "select pg_advisory_xact_lock(4317110);",
        "do $production_guard$ begin",
        f"if current_database() <> {literal(database)} then raise exception 'Wrong production database'; end if;",
        "if (select coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name,'checksum',checksum) order by version),'[]'::jsonb) from ogevia_meta.schema_migrations) <> "
        + literal(expected) + "::jsonb then raise exception 'Production ledger differs from the accepted 108 rows'; end if;",
        "end $production_guard$;",
        'set local role ogevia_owner;', body.decode(), 'reset role;',
        'insert into ogevia_meta.schema_migrations(version,name,checksum) values (' + ','.join(literal(v) for v in (UP_VERSION, UP_NAME, UP_SHA)) + ');',
        'commit;']) + '\n'


def rollback_sql(database='ogevia_prd'):
    assert database == 'ogevia_prd' or re.fullmatch(r'ogevia_test_[0-9a-f]{12}', database)
    body = DOWN.read_bytes()
    assert hashlib.sha256(body).hexdigest() == DOWN_SHA, 'rollback 0110 bytes changed'
    expected = json.dumps(ledger_after(), separators=(',', ':'))
    return '\n'.join([
        "begin;", "set local lock_timeout='10s';", "set local statement_timeout='120s';",
        "select pg_advisory_xact_lock(4317110);",
        "do $production_guard$ begin",
        f"if current_database() <> {literal(database)} then raise exception 'Wrong production database'; end if;",
        "if (select coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name,'checksum',checksum) order by version),'[]'::jsonb) from ogevia_meta.schema_migrations) <> "
        + literal(expected) + "::jsonb then raise exception 'Production ledger is not exactly the 109 rows with 0110'; end if;",
        "end $production_guard$;",
        'set local role ogevia_owner;', body.decode(), 'reset role;',
        "delete from ogevia_meta.schema_migrations where version = '0110';",
        'commit;']) + '\n'


def check_ledger(path, after=False):
    got = json.loads(pathlib.Path(path).read_text())
    assert got == (ledger_after() if after else ledger_before()), 'production ledger differs from the exact expected rows'


def assert_production(t):
    handlers = [r for k, r in t['Resources'].items() if r['Type'] == 'AWS::Lambda::Function' and k.startswith('Handler')]
    assert len(handlers) == 1, 'expected one production Handler'
    e = handlers[0]['Properties']['Environment']['Variables']
    assert e['DB_NAME'] == 'ogevia_prd' and e['OGEVIA_ENV'] == 'prd', 'this is not the production API stack'
    assert e['DB_HOST'] == 'ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com', 'unexpected database host'
    keys = [r['Properties']['RouteKey'] for r in t['Resources'].values() if r['Type'] == ROUTE]
    assert len(keys) == len(set(keys)), 'duplicate route keys'
    return keys


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


def index_js_hash(path):
    with zipfile.ZipFile(path) as z:
        info = z.getinfo('index.js'); assert info.file_size <= 10_000_000
        return hashlib.sha256(z.read(info)).hexdigest()


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'sql':
        print(migration_sql(sys.argv[2] if len(sys.argv) > 2 else 'ogevia_prd'), end='')
    elif cmd == 'rollback-sql':
        print(rollback_sql(sys.argv[2] if len(sys.argv) > 2 else 'ogevia_prd'), end='')
    elif cmd == 'ledger':
        check_ledger(sys.argv[2], len(sys.argv) > 3 and sys.argv[3] == 'after')
        print('PASS: exact production migration ledger and checksums (%s)' % ('109 rows with 0110' if len(sys.argv) > 3 and sys.argv[3] == 'after' else '108 rows, no 0110'))
    elif cmd == 'patch-code':
        pathlib.Path(sys.argv[3]).write_text(json.dumps(patch_code(load(sys.argv[2]), sys.argv[4]), indent=2) + '\n')
        print('PASS: the production template changes Handler Code only; routes, IAM, auth and every other resource unchanged')
    elif cmd == 'patch-routes':
        pathlib.Path(sys.argv[3]).write_text(json.dumps(patch_routes(load(sys.argv[2])), indent=2) + '\n')
        print('PASS: the production template plus exactly nine JWT routes (three request cleanup, six offices); everything else unchanged')
    elif cmd == 'changes-code':
        check_changes_ux(json.loads(pathlib.Path(sys.argv[2]).read_text()))
        print('PASS: Handler Code update with only the four reviewed dynamic ARN dependencies; no Handler replacement')
    elif cmd == 'changes-routes':
        check_route_changes(json.loads(pathlib.Path(sys.argv[2]).read_text()), sys.argv[3] if len(sys.argv) > 3 else 'Add')
        print('PASS: the change set %s exactly the nine routes' % ('removes' if len(sys.argv) > 3 and sys.argv[3] == 'Remove' else 'adds'))
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
        raise SystemExit('usage: sql | rollback-sql | ledger | patch-code | patch-routes | changes-code | changes-routes | routes | hash | deployed | equal')
