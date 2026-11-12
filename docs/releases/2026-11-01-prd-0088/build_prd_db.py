#!/usr/bin/env python3
"""Builds STELLA_PRD_DB.sh = prd_db_header.sh.part + lines 99-191 of ledger-recheck-prd.sh (the access-window block, verbatim except one message) + prd_db_main.sh.part.
Run from this folder:  python3 build_prd_db.py   (reads ../2026-10-26-redesign-prd-operator/scripts/ledger-recheck-prd.sh; refuses if its sha256 is not the reviewed one)."""
import hashlib, os, stat
here = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(here, "..", "2026-10-26-redesign-prd-operator", "scripts", "ledger-recheck-prd.sh")
data = open(src, "rb").read()
assert hashlib.sha256(data).hexdigest() == "133ab6af0aeb4a4e0e17cc007046a57d7712b3f8ee166727be5dc25a3afa8c2c", "ledger-recheck-prd.sh is not the reviewed version"
lines = data.decode().split("\n")
block = lines[98:191]            # lines 99..191 (1-based)
assert block[0].startswith("# ---- bounded commands") and block[-1].startswith("over_time()"), (block[0][:40], block[-1][:40])
text = "\n".join(block)
old = "bash ledger-recheck-prd.sh --restore-only"
assert text.count(old) == 1
text = text.replace(old, "bash STELLA_PRD_DB.sh --restore-only")
hdr = open(os.path.join(here, "prd_db_header.sh.part")).read()
main = open(os.path.join(here, "prd_db_main.sh.part")).read()
out = hdr + "\n" + text + "\n\n" + main
p = os.path.join(here, "STELLA_PRD_DB.sh")
open(p, "w").write(out)
os.chmod(p, os.stat(p).st_mode | stat.S_IXUSR)
print("wrote", p, len(out.split("\n")), "lines")
