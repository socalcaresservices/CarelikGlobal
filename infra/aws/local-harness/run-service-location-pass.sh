#!/bin/bash
# Resets the LOCAL harness (synthetic data), seeds the service-location scenario, rebuilds the web, serves with the 0118 switches on, runs the browser checks: run-service-location-pass.sh <output dir>
set -u
out=${1:?output dir}
here=$(cd "$(dirname "$0")" && pwd); cd "$here/.."
fuser -k 443/tcp 2>/dev/null; sleep 1
pnpm harness:setup >/tmp/ogevia-sl-setup.log 2>&1 || { echo "setup failed"; tail /tmp/ogevia-sl-setup.log; exit 2; }
mkdir -p local-harness/.local
pnpm exec tsx local-harness/seed-service-location.ts 2>/tmp/ogevia-sl-seed.err | tail -1 > local-harness/.local/service-location-ids.json || { echo "seed failed"; tail -5 /tmp/ogevia-sl-seed.err; exit 2; }
pnpm harness:build >>/tmp/ogevia-sl-setup.log 2>&1 || { echo "build failed"; tail /tmp/ogevia-sl-setup.log; exit 2; }
SERVICE_LOCATION=on COVER_ALERT_ADDRESS_RULES=on nohup pnpm harness:serve >/tmp/ogevia-sl-serve.log 2>&1 &
for _ in $(seq 1 40); do curl -sk -o /dev/null https://localhost/ && break; sleep 1; done
cd "$here" && node service-location-checks.mjs "$out"
