#!/usr/bin/env python3
"""Checks that a synthesized CDK cloud assembly is exactly the approved production release. Read-only; local files only.
  prd_assembly_check.py --assembly DIR --release-templates DIR
PASS requires: exactly the five Ogevia-prd-* templates (no Ogevia-prod-* and no other stack); each equal to the bundled release template after ignoring CDK metadata, resource
metadata, the BootstrapVersion parameter and the VALUE of the `ogevia:deployment-status` tag (the assembly carries the owner's approval reference there); the two Lambda code asset
directories of the release present under their pinned names; cdk.out/manifest.json present. Exit 0 = pass, 1 = fail (lines say why), 2 = unreadable input."""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prd_gate import load, prep  # noqa: E402  (module-level main() is guarded below)

STACKS = ["Ogevia-prd-DatabaseSecret", "Ogevia-prd-EvidenceStorage", "Ogevia-prd-WebHosting", "Ogevia-prd-ServiceVerificationApi", "Ogevia-prd-Observability"]
ASSETS = ["eab95a809b3b95b7479cfe6a572e1be0ea068ef6f12751419669443397fe7eda", "7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759"]

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--assembly", required=True); ap.add_argument("--release-templates", required=True)
    a = ap.parse_args()
    bad = []
    try:
        names = sorted(f for f in os.listdir(a.assembly) if f.endswith(".template.json"))
    except OSError as e:
        print(f"unreadable assembly: {e}"); return 2
    found = [n[: -len(".template.json")] for n in names]
    if found != sorted(STACKS):
        bad.append(f"the assembly holds {found}, expected exactly {sorted(STACKS)}")
    for s in STACKS:
        try:
            new = prep(load(os.path.join(a.assembly, f"{s}.template.json"))); rel = prep(load(os.path.join(a.release_templates, f"{s}.json")))
        except (OSError, ValueError, json.JSONDecodeError) as e:
            bad.append(f"{s}: unreadable ({e})"); continue
        if new != rel:
            bad.append(f"{s}: the assembly's template differs from the approved release template")
        else:
            print(f"PASS {s} equals the release template")
    for h in ASSETS:
        if os.path.isdir(os.path.join(a.assembly, f"asset.{h}")):
            print(f"PASS code asset {h[:12]}... present")
        else:
            bad.append(f"code asset directory asset.{h} is missing")
    if not os.path.isfile(os.path.join(a.assembly, "manifest.json")):
        bad.append("manifest.json is missing")
    for b in bad:
        print("FAIL " + b)
    print("ASSEMBLY OK" if not bad else "ASSEMBLY NOT APPROVED")
    return 0 if not bad else 1

if __name__ == "__main__":
    sys.exit(main())
