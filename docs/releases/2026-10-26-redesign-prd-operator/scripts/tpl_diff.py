#!/usr/bin/env python3
"""REPORT (not a gate): differences between a LIVE CloudFormation template and the NEW (release) template, as resource-level lines. Read-only; prints paths and truncated values.
  tpl_diff.py LIVE.json NEW.json
Ignored: CDK::Metadata, per-resource Metadata (asset and path hints), the BootstrapVersion parameter and the CheckBootstrapVersion rule, and the VALUE of the `ogevia:deployment-status` tag.
Output lines: RESOURCE-ADDED <Type> <LogicalId> | RESOURCE-REMOVED <Type> <LogicalId> | CHANGED <LogicalId> (<Type>) <path>: <old> -> <new> | SECTION-CHANGED <Section> ...
Exit 0 = no difference after those rules; 1 = differences (listed); 2 = usage / unreadable input."""
import json, sys

TOP = ["Description", "Parameters", "Outputs", "Conditions", "Mappings", "Transform", "AWSTemplateFormatVersion"]

def load(path):
    with open(path, encoding="utf-8") as fh:
        t = json.load(fh)
    if isinstance(t, dict) and "TemplateBody" in t:
        t = t["TemplateBody"]
    if not isinstance(t, dict) or "Resources" not in t:
        raise ValueError(f"{path} is not a CloudFormation template")
    return t

def norm(x):
    if isinstance(x, dict):
        if "Key" in x and "Value" in x and x.get("Key") == "ogevia:deployment-status":
            return {"Key": x["Key"], "Value": "<APPROVAL>"}
        return {k: ("<APPROVAL>" if k == "ogevia:deployment-status" else norm(v)) for k, v in x.items()}
    if isinstance(x, list):
        out = [norm(i) for i in x]
        if out and all(isinstance(i, dict) and "Key" in i for i in out):
            out.sort(key=lambda i: json.dumps(i, sort_keys=True))
        return out
    return x

def flat(x, prefix=""):
    if isinstance(x, dict):
        if not x:
            yield prefix, {}
        for k in sorted(x):
            yield from flat(x[k], f"{prefix}.{k}" if prefix else k)
    elif isinstance(x, list):
        if not x:
            yield prefix, []
        for i, v in enumerate(x):
            yield from flat(v, f"{prefix}[{i}]")
    else:
        yield prefix, x

def short(v):
    s = json.dumps(v, sort_keys=True) if not isinstance(v, str) else v
    return s if len(s) <= 110 else s[:107] + "..."

def prep(t):
    t = norm(t)
    res = {}
    for k, v in t["Resources"].items():
        if v.get("Type") == "AWS::CDK::Metadata":
            continue
        v = {a: b for a, b in v.items() if a != "Metadata"}
        res[k] = v
    params = {k: v for k, v in (t.get("Parameters") or {}).items() if k != "BootstrapVersion"}
    return res, {**{s: t.get(s) for s in TOP if s != "Parameters"}, "Parameters": params or None}

def main(argv):
    if len(argv) != 3:
        print(__doc__); return 2
    try:
        a, b = load(argv[1]), load(argv[2])
    except (OSError, ValueError, json.JSONDecodeError) as e:
        print(f"unreadable input: {e}"); return 2
    ra, sa = prep(a); rb, sb = prep(b)
    lines = []
    for k in sorted(set(rb) - set(ra)):
        lines.append(f"RESOURCE-ADDED {rb[k].get('Type')} {k}")
    for k in sorted(set(ra) - set(rb)):
        lines.append(f"RESOURCE-REMOVED {ra[k].get('Type')} {k}")
    for k in sorted(set(ra) & set(rb)):
        if ra[k] == rb[k]:
            continue
        fa, fb = dict(flat(ra[k])), dict(flat(rb[k]))
        for p in sorted(set(fa) | set(fb)):
            if fa.get(p, "<absent>") != fb.get(p, "<absent>"):
                lines.append(f"CHANGED {k} ({rb[k].get('Type')}) {p}: {short(fa.get(p, '<absent>'))} -> {short(fb.get(p, '<absent>'))}")
    for s in TOP:
        if sa[s] != sb[s]:
            ka, kb = (sa[s] or {}), (sb[s] or {})
            if isinstance(ka, dict) and isinstance(kb, dict):
                for k in sorted(set(ka) | set(kb)):
                    if ka.get(k) != kb.get(k):
                        lines.append(f"SECTION-CHANGED {s}.{k}: {short(ka.get(k, '<absent>'))} -> {short(kb.get(k, '<absent>'))}")
            else:
                lines.append(f"SECTION-CHANGED {s}: {short(ka)} -> {short(kb)}")
    for l in lines:
        print(l)
    added = sum(1 for l in lines if l.startswith("RESOURCE-ADDED")); removed = sum(1 for l in lines if l.startswith("RESOURCE-REMOVED")); changed = sum(1 for l in lines if l.startswith("CHANGED"))
    print(f"SUMMARY resources: live {len(ra)}, new {len(rb)}; added {added}; removed {removed}; changed properties {changed}; section changes {sum(1 for l in lines if l.startswith('SECTION'))}")
    return 0 if not lines else 1

sys.exit(main(sys.argv))
