#!/bin/bash
# Independent browser pass on freshly reset SYNTHETIC fixtures (local harness only): run-browser-pass.sh <desktop|phone> <output dir>
# Needs playwright-core and a Chromium (executablePath is set inside browser-scenario.mjs). Resets the local harness database, restarts the local
# server, then runs the scenario. Run once per viewport so each pass starts from the same state.
set -u
label=$1; out=$2
here=$(cd "$(dirname "$0")" && pwd)
cd "$here/.."
[ -f /tmp/ogevia-serve.pid ] && kill "$(cat /tmp/ogevia-serve.pid)" 2>/dev/null; sleep 1
log=/tmp/ogevia-setup-$label.log
pnpm harness:setup >"$log" 2>&1 || { echo "setup failed"; tail "$log"; exit 2; }
pnpm harness:seed-extra >>"$log" 2>&1 || { echo "seed-extra failed"; tail "$log"; exit 2; }
pnpm harness:seed-scenario >>"$log" 2>&1 || { echo "seed-scenario failed"; tail "$log"; exit 2; }
nohup pnpm harness:serve >/tmp/ogevia-serve-$label.log 2>&1 &
echo $! > /tmp/ogevia-serve.pid
for _ in $(seq 1 40); do curl -sk -o /dev/null https://localhost/ && break; sleep 1; done
cd "$here" && node browser-scenario.mjs "$label" "$out"
