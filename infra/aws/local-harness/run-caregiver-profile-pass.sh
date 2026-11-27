#!/bin/bash
# Resets the LOCAL harness (synthetic data), builds and serves the web app, and runs the caregiver-profile browser checks: run-caregiver-profile-pass.sh <output dir>
set -u
out=${1:?output dir}
here=$(cd "$(dirname "$0")" && pwd); cd "$here/.."
fuser -k 443/tcp 2>/dev/null; sleep 1
pnpm harness:setup >/tmp/ogevia-cp-setup.log 2>&1 || { echo "setup failed"; tail /tmp/ogevia-cp-setup.log; exit 2; }
pnpm harness:build >/tmp/ogevia-cp-build.log 2>&1 || { echo "build failed"; tail /tmp/ogevia-cp-build.log; exit 2; }
nohup pnpm harness:serve >/tmp/ogevia-cp-serve.log 2>&1 &
for _ in $(seq 1 40); do curl -sk -o /dev/null https://localhost/ && break; sleep 1; done
cd "$here" && node caregiver-profile-checks.mjs "$out"
