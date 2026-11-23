#!/usr/bin/env python3
"""READ-ONLY drift report between a LIVE CloudFormation template and the template the CDK code synthesizes for the same stack.

  python3 production-template-drift.py LIVE.json CANDIDATE.json [--fail-on-drift]

LIVE.json      `aws cloudformation get-template --stack-name <stack> --template-stage Original --query TemplateBody --output json`
CANDIDATE.json `cdk synth -c env=prd -c mode=plan --output <scratch dir>`, the stack's `<stack>.template.json`
No AWS calls, no writes. It prints what is only in the live stack, what is only in the code, and what differs, so that "align the CDK with production" starts from facts.
Never prints a value whose name looks like a secret (KEY, SECRET, TOKEN, PASSWORD, CREDENTIAL). Ignores AWS::CDK::Metadata and the cdk construct-path Metadata on resources.
Exit 0 always, or 1 with --fail-on-drift when anything differs.
"""
import json
import pathlib
import re
import sys

SECRETISH = re.compile(r'KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL', re.I)


def load(path):
    t = json.loads(pathlib.Path(path).read_text())
    if isinstance(t, dict) and 'TemplateBody' in t:
        t = t['TemplateBody']
    assert isinstance(t, dict) and isinstance(t.get('Resources'), dict), '%s is not a CloudFormation template' % path
    return t


def clean(resource):
    r = {k: v for k, v in resource.items() if k != 'Metadata' or set(v) - {'aws:cdk:path'}}
    return r


def label(rid, r):
    p = r.get('Properties', {}) or {}
    if r['Type'] == 'AWS::ApiGatewayV2::Route':
        return '%s  [%s]  %s' % (rid, r['Type'], p.get('RouteKey'))
    return '%s  [%s]' % (rid, r['Type'])


def show(v):
    s = json.dumps(v, sort_keys=True)
    return s if len(s) <= 160 else s[:157] + '...'


def changed_props(a, b):
    out = []
    for k in sorted(set(a) | set(b)):
        if a.get(k) != b.get(k):
            out.append(k)
    return out


def describe_change(rid, la, lb):
    """One line per differing property; Lambda environment variables are compared by name, secret-looking values are never shown."""
    lines = []
    pa, pb = la.get('Properties', {}) or {}, lb.get('Properties', {}) or {}
    for k in changed_props(la, lb):
        if k == 'Properties':
            continue
        lines.append('    %s: live %s | code %s' % (k, show(la.get(k)), show(lb.get(k))))
    for k in changed_props(pa, pb):
        if k == 'Environment' and la['Type'] == 'AWS::Lambda::Function':
            ea, eb = (pa.get(k) or {}).get('Variables', {}) or {}, (pb.get(k) or {}).get('Variables', {}) or {}
            for name in sorted(set(ea) | set(eb)):
                if ea.get(name) == eb.get(name):
                    continue
                if name not in ea:
                    lines.append('    env %s: only in code' % name)
                elif name not in eb:
                    lines.append('    env %s: only in live' % name)
                elif SECRETISH.search(name):
                    lines.append('    env %s: differs (value hidden)' % name)
                else:
                    lines.append('    env %s: live %s | code %s' % (name, show(ea[name]), show(eb[name])))
        elif SECRETISH.search(k):
            lines.append('    %s: differs (value hidden)' % k)
        else:
            lines.append('    %s: live %s | code %s' % (k, show(pa.get(k)), show(pb.get(k))))
    return lines


def report(live, cand):
    out, drift = [], 0
    L = {k: clean(v) for k, v in live['Resources'].items() if v['Type'] != 'AWS::CDK::Metadata'}
    C = {k: clean(v) for k, v in cand['Resources'].items() if v['Type'] != 'AWS::CDK::Metadata'}
    out.append('== Counts: live %d resources, code %d resources' % (len(L), len(C)))

    def route_key(r):
        return r['Properties']['RouteKey'] if r['Type'] == 'AWS::ApiGatewayV2::Route' else None
    lroutes = {route_key(r): k for k, r in L.items() if route_key(r)}
    croutes = {route_key(r): k for k, r in C.items() if route_key(r)}

    only_live = sorted(set(lroutes) - set(croutes))
    only_code = sorted(set(croutes) - set(lroutes))
    renamed = sorted(k for k in set(lroutes) & set(croutes) if lroutes[k] != croutes[k])
    out.append('\n== Routes only in LIVE (the code would REMOVE them on a deploy): %d' % len(only_live))
    out += ['  %s  (logical id %s)' % (k, lroutes[k]) for k in only_live] or ['  none']
    out.append('\n== Routes only in CODE (a deploy would ADD them): %d' % len(only_code))
    out += ['  %s  (logical id %s)' % (k, croutes[k]) for k in only_code] or ['  none']
    out.append('\n== Same route, DIFFERENT logical id (a deploy would DELETE and RECREATE it: a short outage for that route): %d' % len(renamed))
    out += ['  %s  live %s | code %s' % (k, lroutes[k], croutes[k]) for k in renamed] or ['  none']
    drift += len(only_live) + len(only_code) + len(renamed)

    routeids_l, routeids_c = set(lroutes.values()), set(croutes.values())
    other_live = sorted(k for k in set(L) - set(C) if k not in routeids_l)
    other_code = sorted(k for k in set(C) - set(L) if k not in routeids_c)
    out.append('\n== Other resources only in LIVE: %d' % len(other_live))
    out += ['  ' + label(k, L[k]) for k in other_live] or ['  none']
    out.append('\n== Other resources only in CODE: %d' % len(other_code))
    out += ['  ' + label(k, C[k]) for k in other_code] or ['  none']
    drift += len(other_live) + len(other_code)

    both = sorted(k for k in set(L) & set(C) if L[k] != C[k])
    out.append('\n== Resources in both whose definition differs: %d' % len(both))
    for k in both:
        out.append('  ' + label(k, L[k]))
        out += describe_change(k, L[k], C[k])
    if not both:
        out.append('  none')
    drift += len(both)

    for section in ('Parameters', 'Conditions', 'Outputs', 'Mappings'):
        a, b = live.get(section, {}) or {}, cand.get(section, {}) or {}
        ol, oc = sorted(set(a) - set(b)), sorted(set(b) - set(a))
        ch = sorted(k for k in set(a) & set(b) if a[k] != b[k])
        out.append('\n== %s: only in live %s | only in code %s | differing %s' % (section, ol or 'none', oc or 'none', ch or 'none'))
        for k in ch:
            out.append('    %s: live %s | code %s' % (k, 'NoEcho' if a[k].get('NoEcho') else show({x: y for x, y in a[k].items() if x != 'Default'}),
                                                  'NoEcho' if b[k].get('NoEcho') else show({x: y for x, y in b[k].items() if x != 'Default'})))
        drift += len(ol) + len(oc) + len(ch)

    out.append('\n== VERDICT: ' + ('NO DRIFT (the code synthesizes the live stack)' if drift == 0 else 'DRIFT: %d difference(s) listed above' % drift))
    return '\n'.join(out) + '\n', drift


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) != 2:
        raise SystemExit(__doc__)
    text, drift = report(load(args[0]), load(args[1]))
    sys.stdout.write(text)
    sys.exit(1 if drift and '--fail-on-drift' in sys.argv else 0)
