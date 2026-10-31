#!/usr/bin/env python3
"""Fills the placeholders in STELLA_PHASE_C_DB.sh and STELLA_PHASE_C_DEPLOY.sh for ONE release candidate. Run by the author after the owner gives the window and the GO.
Local only: reads the repository at the candidate commit and the synthesized assembly; talks to nothing.

  python3 fill_pins.py --repo /path/to/checkout-at-SHA --assembly /path/to/cdk.out --go-ref GO-... --window-start "YYYY-MM-DD HH:MM:SS" --window-end "YYYY-MM-DD HH:MM:SS" [--check]

The window is UTC. --check only reports what would be written. The SHA is the checkout's HEAD (the code commit; later commits may only touch documents and these scripts).
"""
import argparse, hashlib, json, os, re, subprocess, sys

def sha(path): return hashlib.sha256(open(path, "rb").read()).hexdigest()
def sh(cmd, cwd): return subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()

ap = argparse.ArgumentParser()
ap.add_argument("--repo", required=True); ap.add_argument("--assembly", required=True)
ap.add_argument("--go-ref", required=True); ap.add_argument("--window-start", required=True); ap.add_argument("--window-end", required=True)
ap.add_argument("--check", action="store_true")
a = ap.parse_args()
assert re.fullmatch(r"[A-Za-z0-9._-]{6,64}", a.go_ref), "the GO reference must be 6-64 characters of A-Za-z0-9._-"
for t in (a.window_start, a.window_end): assert re.fullmatch(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d", t), "window times are UTC 'YYYY-MM-DD HH:MM:SS'"
here = os.path.dirname(os.path.abspath(__file__))
m = os.path.join(a.repo, "infra/aws/db/migrations"); r = os.path.join(a.repo, "infra/aws/db/rollback")
head = sh("git rev-parse HEAD", a.repo)
setsha = lambda n: sh(f"LC_ALL=C sha256sum -- $(ls *.sql | LC_ALL=C sort | head -{n}) | sha256sum | cut -c1-64", m)
vals = {
  "__SHA__": head,
  "__MIG_SHA__": sha(f"{m}/0088_caregiver_readiness_approve_for_work.sql"),
  "__DOWN_SHA__": sha(f"{r}/0088_caregiver_readiness_approve_for_work.down.sql"),
  "__SET87_SHA__": setsha(87),
  "__SET88_SHA__": sh("LC_ALL=C sha256sum -- *.sql | sha256sum | cut -c1-64", m),
  "__ROLLSET_SHA__": sh("LC_ALL=C sha256sum -- 0088_caregiver_readiness_approve_for_work.down.sql | sha256sum | cut -c1-64", r),
  "__GO_REF__": a.go_ref, "__WIN_START_UTC__": a.window_start, "__WIN_END_UTC__": a.window_end,
}
t = json.load(open(f"{a.assembly}/Ogevia-prod-ServiceVerificationApi.template.json"))["Resources"]
keys = [v["Properties"]["Code"]["S3Key"] for k, v in t.items() if v["Type"] == "AWS::Lambda::Function" and k.startswith("Handler")]
assert len(keys) == 1 and keys[0].endswith(".zip"), "expected exactly one Handler asset in the assembly"
vals["__HANDLER_KEY__"] = keys[0][:-4]
assert sh("ls *.sql | wc -l", m) == "88", "expected 88 migration files"
for k, v in vals.items(): print(f"{k:20} {v}")
if a.check: sys.exit(0)
for f in ("STELLA_PHASE_C_DB.sh", "STELLA_PHASE_C_DEPLOY.sh"):
    p = os.path.join(here, f); s = open(p).read()
    for k, v in vals.items(): s = s.replace(k, v)
    left = re.findall(r"__[A-Z0-9_]+__", s)
    assert not left, (f, left)
    open(p, "w").write(s)
    print("filled", f, sha(p))
