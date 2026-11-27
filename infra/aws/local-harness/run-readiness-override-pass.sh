#!/bin/bash
# Resets the LOCAL harness (synthetic data), seeds the override scenario with readiness enforcement ON, builds and serves the web app and runs the override browser checks: run-readiness-override-pass.sh <output dir>
set -u
out=${1:?output dir}
here=$(cd "$(dirname "$0")" && pwd); cd "$here/.."
fuser -k 443/tcp 2>/dev/null; sleep 1
pnpm harness:setup >/tmp/ogevia-ro-setup.log 2>&1 || { echo "setup failed"; tail /tmp/ogevia-ro-setup.log; exit 2; }
pnpm exec tsx local-harness/seed-readiness-override.ts >>/tmp/ogevia-ro-setup.log 2>&1 || { echo "seed failed"; tail -8 /tmp/ogevia-ro-setup.log; exit 2; }
pnpm harness:build >/tmp/ogevia-ro-build.log 2>&1 || { echo "build failed"; tail /tmp/ogevia-ro-build.log; exit 2; }
nohup pnpm harness:serve >/tmp/ogevia-ro-serve.log 2>&1 &
for _ in $(seq 1 40); do curl -sk -o /dev/null https://localhost/ && break; sleep 1; done
cd "$here" && node readiness-override-checks.mjs "$out"
