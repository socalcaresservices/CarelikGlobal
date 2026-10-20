#!/usr/bin/env python3
"""Compare two fingerprint files (lines "key<TAB>digest"). Prints key names and counts only, never values.
  fp-compare.py schema A B [--allow FILE]     keys not starting with "data:" must be identical, except the keys listed in FILE (one per line)
  fp-compare.py data BEFORE AFTER             every table present before must have the same row COUNT after; if its column set is unchanged it must also have the same content digest,
                                              except tables listed in --expect-changed (default: ogevia.permissions ogevia.role_permissions, which migrations add rows to)
Exit 0 = equal under those rules, 1 = differences (listed), 2 = usage."""
import sys

def load(p):
    d = {}
    for line in open(p, encoding="utf-8"):
        line = line.rstrip("\n")
        if not line:
            continue
        k, _, v = line.partition("\t")
        d[k] = v
    return d

def main(argv):
    if len(argv) < 4 or argv[1] not in ("schema", "data"):
        print(__doc__); return 2
    mode, a, b = argv[1], load(argv[2]), load(argv[3])
    rest = argv[4:]
    if mode == "schema":
        allow = set()
        if rest[:1] == ["--allow"] and len(rest) == 2:
            allow = {l.strip() for l in open(rest[1]) if l.strip()}
        keys = {k for k in set(a) | set(b) if not k.startswith("data:")}
        diff = sorted(k for k in keys if a.get(k) != b.get(k))
        unexpected = [k for k in diff if k not in allow]
        missing_allowed = sorted(k for k in allow if k not in diff)
        for k in unexpected:
            print(("only-in-first " if k not in b else "only-in-second " if k not in a else "changed ") + k)
        for k in missing_allowed:
            print("expected-difference-absent " + k)
        print(f"schema keys compared: {len(keys)}; differences: {len(diff)}; unexpected: {len(unexpected)}; allowed-but-absent: {len(missing_allowed)}")
        return 0 if not unexpected and not missing_allowed else 1
    changed_ok = {"ogevia.permissions", "ogevia.role_permissions"}
    if rest[:1] == ["--expect-changed"]:
        changed_ok = set(rest[1:])
    def cols(d, table):
        pre = f"column:{table}."
        return {k: v for k, v in d.items() if k.startswith(pre)}
    bad = []
    for k, v in sorted(a.items()):
        if not k.startswith("data:"):
            continue
        table = k[5:]
        if k not in b:
            bad.append(f"table-missing-after {table}"); continue
        n0, _, h0 = v.partition(":"); n1, _, h1 = b[k].partition(":")
        if table in changed_ok:
            continue
        if n0 != n1:
            bad.append(f"row-count-changed {table} {n0}->{n1}"); continue
        if cols(a, table) == cols(b, table) and h0 != h1:
            bad.append(f"content-changed {table}")
    for line in bad:
        print(line)
    tables = sum(1 for k in a if k.startswith("data:"))
    print(f"tables compared: {tables}; problems: {len(bad)}")
    return 0 if not bad else 1

sys.exit(main(sys.argv))
