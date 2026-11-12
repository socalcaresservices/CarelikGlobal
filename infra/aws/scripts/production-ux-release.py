#!/usr/bin/env python3
"""Production UX promotion: exact ledger SQL and a code-only template patch.

No AWS calls. Applied migration bytes remain unchanged. The operator supplies
the captured production template; all properties except Handler Code survive.
"""
import copy
import hashlib
import json
import os
import pathlib
import re
import sys
import base64
import zipfile

ROOT = pathlib.Path(os.environ['OGEVIA_UX_SOURCE_ROOT']) if os.environ.get('OGEVIA_UX_SOURCE_ROOT') else pathlib.Path(__file__).resolve().parents[3]
SOURCE = '6cbab00b2795d0cfe42bf644adc6a559adda7c76'
ASSETS = 'cdk-hnb659fds-assets-300094796789-us-west-2'
KEY = 'ed01f08a2df9d8870ed44c25912ce9c9d18f4e6dd73dba29594c954a538c983b.zip'
JS_HASH = '98e84618f6eeaf6472985db06db9132cf39d887d296d38301ee0137e3a6e991c'
OLD_JS_HASH = '51801cff1705dc6e1cc6b8a9ed3a02a28ef25f1ad94e568388a9d435a963a591'
NAMES = ['0103_caregiver_signin_override.sql', '0104_caregiver_client_labels.sql',
         '0105_bulk_import.sql', '0106_staff_duplicates.sql', '0107_standard_document_types.sql']
HASHES = ['963d8cf4e7c8bdfa7da38d2719d4a4be2f7dafd7ab50e371c4e2ae1a567dfe54',
          '7e492ae24aff345ef15f0905e51bb0ee0c801857f6e1ee549fdf4b45f9e68712',
          '2dc18c125b459750431981dad2dd257630c6864e5ed41102770e6d9d1f992121',
          '952e1c9176ecee8b9475fd45f923fdff175bf78de14341a61b46e49d9f28affa',
          'b0a28f483462a826aac0c9bb1e8e7b4ad8d26bfea80156668ab80874508f8d91']


def files():
    db = ROOT / 'infra/aws/db'
    baseline = json.loads((db/'pending/live-test/expected-ledger-0102.json').read_text())
    assert len(baseline) == 102
    rows = []
    for name, checksum in zip(NAMES, HASHES):
        sql = (db/'pending/migrations'/name).read_bytes()
        assert hashlib.sha256(sql).hexdigest() == checksum, 'migration bytes changed: '+name
        rows.append((dict(version=name[:4], name=name, checksum=checksum), sql.decode()))
    return baseline, rows


def literal(s):
    return "'" + s.replace("'", "''") + "'"


def migration_sql(database='ogevia_prd'):
    # Local synthetic names are only for the real-Postgres integration test.
    assert database == 'ogevia_prd' or re.fullmatch(r'ogevia_test_[0-9a-f]{12}', database)
    baseline, rows = files()
    expected = json.dumps(baseline, separators=(',', ':'))
    sql = ["begin;", "set local lock_timeout='10s';", "set local statement_timeout='120s';",
           "select pg_advisory_xact_lock(4317001);",
           "do $production_guard$ begin",
           f"if current_database() <> {literal(database)} then raise exception 'Wrong production database'; end if;",
           "if (select coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name,'checksum',checksum) order by version),'[]'::jsonb) from ogevia_meta.schema_migrations) <> " + literal(expected) + "::jsonb then raise exception 'Production ledger differs from reviewed 102 migrations; no migration applied'; end if;",
           "end $production_guard$;",
           # Accepted production 0095 was created by its migration admin.
           # Normalize only this known function, without changing grants or
           # membership. Repair and all five migrations roll back together.
           "do $production_owner$ declare existing_owner text; begin",
           "select pg_get_userbyid(proowner) into existing_owner from pg_proc where oid='ogevia_api.caregiver_visible_client_name(uuid,uuid,text)'::regprocedure;",
           "if existing_owner=session_user then alter function ogevia_api.caregiver_visible_client_name(uuid,uuid,text) owner to ogevia_owner;",
           "elsif existing_owner<>'ogevia_owner' then raise exception 'Unexpected owner of caregiver_visible_client_name; no ownership change applied'; end if;",
           "end $production_owner$;"]
    for row, body in rows:
        sql += ['set local role ogevia_owner;', body, 'reset role;',
                'insert into ogevia_meta.schema_migrations(version,name,checksum) values ('+
                ','.join(literal(row[k]) for k in ['version','name','checksum'])+');']
    sql += ['commit;']
    return '\n'.join(sql)+'\n'


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
    for disabled in ['POST /v1/imports/{kind}', 'GET /v1/staff/duplicates',
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


def js_hash(path):
    with zipfile.ZipFile(path) as z:
        assert z.getinfo('index.js').file_size <= 10_000_000
        return hashlib.sha256(z.read('index.js')).hexdigest()


def check_changes(d):
    assert d['Status'] == 'CREATE_COMPLETE' and d['ExecutionStatus'] == 'AVAILABLE'
    changes = d['Changes']
    direct = [x['ResourceChange'] for x in changes if x['ResourceChange']['LogicalResourceId']=='Handler886CB40B']
    assert len(direct)==1, 'exactly one Handler code update is required'
    c = direct[0]
    assert c['ResourceType']=='AWS::Lambda::Function' and c['Action']=='Modify' and c['Replacement']=='False'
    assert c['Scope']==['Properties']
    assert c['Details'] and all(x['Target']['Attribute']=='Properties' and x['Target']['Name']=='Code'
                                for x in c['Details']), 'only Code may change'
    # These four exact live resources were reviewed from the production change
    # set. Their definitions remain byte-for-byte equal in the template. CFN
    # reports dynamic ARN propagation even though the Handler is not replaced.
    allowed = {
        'ApiGETv1meApiPermissionApiScopedOgeviaprdServiceVerificationApiHandlerB5423A9EOgeviaprdServiceVerificationApi79D9FC77F5F026AD':
            ('AWS::Lambda::Permission','Conditional',{'FunctionName':'Handler886CB40B.Arn'}),
        'ApiGETv1meHandlerCDA9441F':
            ('AWS::ApiGatewayV2::Integration','False',{'IntegrationUri':'Handler886CB40B.Arn'}),
        'ComplianceSweep51D1109D':
            ('AWS::Events::Rule','False',{'Targets':'Handler886CB40B.Arn'}),
        'ComplianceSweepAllowEventRuleOgeviaprdServiceVerificationApiHandlerB5423A9EE440EE04':
            ('AWS::Lambda::Permission','Conditional',{'SourceArn':'ComplianceSweep51D1109D.Arn','FunctionName':'Handler886CB40B.Arn'}),
    }
    seen = set()
    for change in changes:
        r = change['ResourceChange']; rid = r['LogicalResourceId']
        assert rid not in seen, 'duplicate resource change'
        seen.add(rid)
        if rid=='Handler886CB40B': continue
        assert rid in allowed, 'unreviewed dependent resource: '+rid
        kind, replacement, targets = allowed[rid]
        assert r['ResourceType']==kind and r['Action']=='Modify' and r['Replacement']==replacement
        assert r['Scope']==['Properties'] and len(r['Details'])==len(targets)
        observed = {}
        for x in r['Details']:
            assert x['Target']['Attribute']=='Properties' and x['Evaluation']=='Dynamic' and x['ChangeSource']=='ResourceAttribute', 'dependent change must be dynamic ARN propagation'
            name=x['Target']['Name']; assert name not in observed
            observed[name]=x['CausingEntity']
        assert observed==targets, 'unexpected dependency property or ARN'


def check_ledger(path, after=False):
    baseline, rows = files()
    assert json.loads(pathlib.Path(path).read_text()) == baseline + ([r for r, _ in rows] if after else [])


if __name__ == '__main__':
    if sys.argv[1] == 'sql':
        print(migration_sql(sys.argv[2] if len(sys.argv)>2 else 'ogevia_prd'), end='')
    elif sys.argv[1] == 'patch':
        t = json.loads(pathlib.Path(sys.argv[2]).read_text())
        pathlib.Path(sys.argv[3]).write_text(json.dumps(patch_template(t), indent=2)+'\n')
        print('PASS: production template changes Handler Code only; routes, QR key, auth and IAM unchanged')
    elif sys.argv[1] == 'ledger':
        check_ledger(sys.argv[2], len(sys.argv)>3 and sys.argv[3]=='after')
        print('PASS: exact production migration ledger and checksums')
    elif sys.argv[1] == 'equal':
        assert json.loads(pathlib.Path(sys.argv[2]).read_text()) == json.loads(pathlib.Path(sys.argv[3]).read_text()), 'template changed concurrently'
    elif sys.argv[1] == 'assets':
        d = pathlib.Path(sys.argv[2])
        expected = json.loads((d/'handler.before.json').read_text())['CodeSha256']
        assert base64.b64encode(hashlib.sha256((d/'handler.before.zip').read_bytes()).digest()).decode()==expected
        assert js_hash(d/'handler.before.zip') == OLD_JS_HASH, 'production code changed since capture'
        assert js_hash(d/'handler.accepted.zip') == JS_HASH, 'release asset differs from accepted TEST code'
        print('PASS: actual production rollback ZIP and accepted TEST application code')
    elif sys.argv[1] == 'deployed':
        assert js_hash(sys.argv[2]) == JS_HASH
        print('PASS: deployed production Handler matches accepted TEST code')
    elif sys.argv[1] == 'changes':
        check_changes(json.loads(pathlib.Path(sys.argv[2]).read_text()))
        print('PASS: Handler Code update with only the four reviewed dynamic ARN dependencies; no Handler replacement')
    else:
        raise SystemExit('usage: sql [local-test-database] | patch live.json candidate.json')
