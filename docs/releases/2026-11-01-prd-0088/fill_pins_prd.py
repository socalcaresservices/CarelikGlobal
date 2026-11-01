#!/usr/bin/env python3
"""Fills the placeholders of the production scripts for ONE release candidate. Run by the author AFTER the owner's GO names the commit, the window and the approval reference.
Local only: reads the checkout at the release commit; talks to nothing.
  python3 fill_pins_prd.py --repo /path/to/checkout-at-SHA --go-ref GO-... --window-start "YYYY-MM-DD HH:MM:SS" --window-end "YYYY-MM-DD HH:MM:SS" [--check] [--files STELLA_PRD_DB.sh ...]
The window is UTC. --check prints the values and writes nothing. The SHA is the checkout's HEAD; the checkout must be clean."""
import argparse, hashlib, os, re, subprocess, sys

def sha(path): return hashlib.sha256(open(path, "rb").read()).hexdigest()
def sh(cmd, cwd): return subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()

ap = argparse.ArgumentParser()
ap.add_argument("--repo", required=True); ap.add_argument("--go-ref", required=True)
ap.add_argument("--window-start", required=True); ap.add_argument("--window-end", required=True)
ap.add_argument("--check", action="store_true"); ap.add_argument("--files", nargs="*", default=["STELLA_PRD_DB.sh"])
a = ap.parse_args()
assert re.fullmatch(r"[A-Za-z0-9._-]{6,64}", a.go_ref), "the approval reference must be 6-64 characters of A-Za-z0-9._-"
for t in (a.window_start, a.window_end): assert re.fullmatch(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d", t), "window times are UTC 'YYYY-MM-DD HH:MM:SS'"
assert a.window_end > a.window_start, "the window must end after it starts"
here = os.path.dirname(os.path.abspath(__file__))
m = os.path.join(a.repo, "infra/aws/db/migrations"); r = os.path.join(a.repo, "infra/aws/db/rollback")
head = sh("git rev-parse HEAD", a.repo)
assert sh("git status --porcelain --untracked-files=no", a.repo) == "", "the checkout has local changes"
assert sh("ls *.sql | wc -l", m) == "88", "expected 88 migration files"
vals = {
  "__SHA__": head,
  "__MIG88_SHA__": sha(f"{m}/0088_caregiver_readiness_approve_for_work.sql"),
  "__SET88_SHA__": sh("LC_ALL=C sha256sum -- *.sql | sha256sum | cut -c1-64", m),
  "__ROLLSET3_SHA__": sh("LC_ALL=C sha256sum -- 0086_staff_management.down.sql 0087_staff_invitation_acceptance.down.sql 0088_caregiver_readiness_approve_for_work.down.sql | sha256sum | cut -c1-64", r),
  "__GO_REF__": a.go_ref, "__WIN_START_UTC__": a.window_start, "__WIN_END_UTC__": a.window_end,
}
for k, v in vals.items(): print(f"{k:20} {v}")
if a.check: sys.exit(0)
for f in a.files:
    p = os.path.join(here, f)
    if not os.path.exists(p): print("skipped (not present):", f); continue
    s = open(p).read()
    for k, v in vals.items(): s = s.replace(k, v)
    left = re.findall(r"__[A-Z0-9_]{3,}__", s)
    assert not left, (f, left)
    open(p, "w").write(s)
    print("filled", f, sha(p))
