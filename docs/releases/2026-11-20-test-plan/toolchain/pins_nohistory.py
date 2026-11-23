# Pins check for a SHALLOW checkout (no history), Offices release. HEAD must be exactly the release commit typed in the block; every hash, count and ledger expectation in PINS_0110.json is checked.
import json, pathlib, subprocess, sys
sys.dont_write_bytecode = True
repo = pathlib.Path(sys.argv[1]).resolve(); release = sys.argv[2]
tc = repo / "docs/releases/2026-11-20-test-plan/toolchain"
sys.path.insert(0, str(tc))
import release_pins as rp
git = lambda *a: subprocess.run(["git", "-C", str(repo), *a], capture_output=True, text=True).stdout.strip()
bad = []
head = git("rev-parse", "HEAD")
if head != release: bad.append(f"HEAD is {head[:12]}, expected the release commit {release[:12]}")
if git("status", "--porcelain", "--untracked-files=no"): bad.append("tracked files in the checkout are modified")
pins = json.loads((tc / "PINS_0110.json").read_text())
now = rp.compute(head, "0110")
for key in ("pnpmLockSha256", "releasedMigrations", "pendingUx0103to0107", "migration0109", "migration0110", "toolchainSha256", "apiRoutes", "expectedLedger"):
    if now[key] != pins[key]: bad.append(f"{key} differs from the pins")
for b in bad: print("FAIL", b)
if bad:
    print("STOP: the checkout does not match the pins"); sys.exit(1)
print(f"PINS OK (no-history check): HEAD is exactly {release[:12]}; every hash, count and ledger expectation matches PINS_0110.json")
