#!/usr/bin/env python3
"""Production release of the request-cleanup change (PR #113, commit ef90a2a): exact ledger SQL for migration 0109 and a code-only template patch.

No AWS calls. It follows production-ux-release.py (the 2026-11-11 production promotion) and reuses its reviewed helpers for the baseline ledger,
the change-set check and the code hash. The request-cleanup switch is NOT turned on: the three new routes must stay absent from production.
  sql [local-test-database]   the one-transaction migration (guards the exact 107-row ledger, applies 0109 as ogevia_owner, records the ledger row)
  ledger FILE [after]         the production ledger JSON equals the exact 107 rows (or 108 with 0109)
  patch LIVE.json OUT.json    the captured production template with ONLY the Handler Code changed
  assets DIR                  the production rollback ZIP is the accepted 2026-11-11 code and the release asset is this release's code
  deployed ZIP                the deployed Handler's index.js equals this release's code
  changes FILE                the change set contains only the Handler Code update (and the four reviewed dynamic ARN dependents)
  equal A B                   two templates are equal
Requires OGEVIA_UX_SOURCE_ROOT=<checkout at the release commit>.
"""
import base64
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
UX = runpy.run_path(str(ROOT / 'infra/aws/scripts/production-ux-release.py'))
literal, js_hash, check_changes, files = UX['literal'], UX['js_hash'], UX['check_changes'], UX['files']
SOURCE = 'ef90a2a42c21e2c68e6fbf3f361e618806699b8d'
ASSETS = 'cdk-hnb659fds-assets-300094796789-us-west-2'
KEY = '0877a461644480499fff3a5f2e80c0624b9692a2b15536643ff54bba25a6c739.zip'
JS_HASH = 'a8b8387856d23e82d586a47113018fed84a1a2dccc6d61f1db6b3df3aa6336c6'
OLD_JS_HASH = '98e84618f6eeaf6472985db06db9132cf39d887d296d38301ee0137e3a6e991c'
UP = ROOT / 'infra/aws/db/pending/migrations/0109_request_cleanup.sql'
UP_NAME, UP_VERSION = '0109_request_cleanup.sql', '0109'
UP_SHA = '2c0ebb9e91e5a88d52f4cd323a82c7b691fb85197c74f80ca98ee774642cd25b'


def ledger_before():
    baseline, rows = files()
    return baseline + [r for r, _ in rows]


def ledger_after():
    return ledger_before() + [dict(version=UP_VERSION, name=UP_NAME, checksum=UP_SHA)]


def migration_sql(database='ogevia_prd'):
    # Local synthetic names are only for the real-Postgres integration test.
    assert database == 'ogevia_prd' or re.fullmatch(r'ogevia_test_[0-9a-f]{12}', database)
    body = UP.read_bytes()
    assert hashlib.sha256(body).hexdigest() == UP_SHA, 'migration 0109 bytes changed'
    expected = json.dumps(ledger_before(), separators=(',', ':'))
    return '\n'.join([
        "begin;", "set local lock_timeout='10s';", "set local statement_timeout='120s';",
        "select pg_advisory_xact_lock(4317001);",
        "do $production_guard$ begin",
        f"if current_database() <> {literal(database)} then raise exception 'Wrong production database'; end if;",
        "if (select coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name,'checksum',checksum) order by version),'[]'::jsonb) from ogevia_meta.schema_migrations) <> "
        + literal(expected) + "::jsonb then raise exception 'Production ledger differs from the accepted 107 rows'; end if;",
        "end $production_guard$;",
        'set local role ogevia_owner;', body.decode(), 'reset role;',
        'insert into ogevia_meta.schema_migrations(version,name,checksum) values (' + ','.join(literal(v) for v in (UP_VERSION, UP_NAME, UP_SHA)) + ');',
        'commit;']) + '\n'


def patch_template(t):
    new = copy.deepcopy(t)
    handlers = [k for k, r in t['Resources'].items()
                if r['Type'] == 'AWS::Lambda::Function' and k.startswith('Handler')]
    assert len(handlers) == 1, 'expected one production Handler'
    rid = handlers[0]
    p = new['Resources'][rid]['Properties']
    e = p['Environment']['Variables']
    assert e['DB_NAME'] == 'ogevia_prd' and e['OGEVIA_ENV'] == 'prd'
    assert e['DB_HOST'] == 'ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com'
    assert e['COGNITO_USER_POOL_ID'] in (
        'us-west-2_FHJoX71ca',
        {'Fn::ImportValue': 'Ogevia-prd-Auth:ExportsOutputRefUserPool19CF3AE1'},
    ), 'dedicated production auth reference differs'
    assert p['Runtime'] == 'nodejs24.x', 'production runtime changed'
    # The owner's production capture uses QrEncryptionKey0102; TEST uses
    # ClientQrEncryptionKey. Preserve the actual reference and previous value.
    qr = e.get('OGEVIA_QR_ENCRYPTION_KEY')
    assert qr in (None, '', {'Ref': 'ClientQrEncryptionKey'}, {'Ref': 'QrEncryptionKey0102'}), 'unexpected QR configuration'
    if isinstance(qr, dict):
        spec = t['Parameters'][qr['Ref']]
        assert spec.get('NoEcho') is True
        assert not spec.get('Default'), 'embedded QR default'
    routes = [r['Properties']['RouteKey'] for r in t['Resources'].values()
              if r['Type'] == 'AWS::ApiGatewayV2::Route']
    assert len(routes) == len(set(routes))
    for disabled in ['POST /v1/care-notifications/read', 'POST /v1/documents/{documentId}/cancel', 'POST /v1/document-types/{documentTypeId}/retire',
                     'POST /v1/imports/{kind}', 'GET /v1/staff/duplicates',
                     'POST /v1/staff/{profileId}/merge', 'GET /v1/signin-overrides',
                     'POST /v1/caregivers/{caregiverRecordId}/signin-override']:
        assert disabled not in routes, 'disabled production feature is enabled: '+disabled
    for retained in ['GET /v1/business-documents', 'POST /v1/business-documents',
                     'GET /v1/reports/missing-visits', 'POST /v1/shifts/{shiftId}/missing-visit',
                     'POST /v1/checkin', 'POST /v1/clients/{clientId}/qr-card']:
        assert retained in routes, 'accepted production route is missing: '+retained
    p['Code'] = {'S3Bucket': ASSETS, 'S3Key': KEY}
    check = copy.deepcopy(new)
    check['Resources'][rid]['Properties']['Code'] = t['Resources'][rid]['Properties']['Code']
    assert check == t, 'only Handler Code may change'
    assert new != t, 'production is already on this code; inspect before retrying'
    return new


def check_ledger(path, after=False):
    got = json.loads(pathlib.Path(path).read_text())
    assert got == (ledger_after() if after else ledger_before()), 'production ledger differs from the exact expected rows'


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'sql':
        print(migration_sql(sys.argv[2] if len(sys.argv) > 2 else 'ogevia_prd'), end='')
    elif cmd == 'patch':
        t = json.loads(pathlib.Path(sys.argv[2]).read_text())
        pathlib.Path(sys.argv[3]).write_text(json.dumps(patch_template(t), indent=2) + '\n')
        print('PASS: production template changes Handler Code only; routes, QR key, auth and IAM unchanged; the three request-cleanup routes stay absent')
    elif cmd == 'ledger':
        check_ledger(sys.argv[2], len(sys.argv) > 3 and sys.argv[3] == 'after')
        print('PASS: exact production migration ledger and checksums (%s)' % ('108 rows with 0109' if len(sys.argv) > 3 and sys.argv[3] == 'after' else '107 rows, no 0109'))
    elif cmd == 'equal':
        assert json.loads(pathlib.Path(sys.argv[2]).read_text()) == json.loads(pathlib.Path(sys.argv[3]).read_text()), 'template changed concurrently'
    elif cmd == 'assets':
        d = pathlib.Path(sys.argv[2])
        expected = json.loads((d / 'handler.before.json').read_text())['CodeSha256']
        assert base64.b64encode(hashlib.sha256((d / 'handler.before.zip').read_bytes()).digest()).decode() == expected
        assert js_hash(d / 'handler.before.zip') == OLD_JS_HASH, 'production code is not the accepted 2026-11-11 code; do not continue'
        assert js_hash(d / 'handler.accepted.zip') == JS_HASH, 'release asset differs from the code accepted on TEST'
        print('PASS: actual production rollback ZIP and this release application code')
    elif cmd == 'deployed':
        assert js_hash(sys.argv[2]) == JS_HASH
        print('PASS: deployed production Handler matches the code accepted on TEST')
    elif cmd == 'changes':
        check_changes(json.loads(pathlib.Path(sys.argv[2]).read_text()))
        print('PASS: Handler Code update with only the four reviewed dynamic ARN dependencies; no Handler replacement')
    else:
        raise SystemExit('usage: sql [db] | ledger FILE [after] | patch LIVE OUT | assets DIR | deployed ZIP | changes FILE | equal A B')
