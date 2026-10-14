#!/usr/bin/env bash
cd /home/user/CarelikGlobal
export HARNESS_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres
[ -f /tmp/harness.pid ] && kill -- -"$(cat /tmp/harness.pid)" 2>/dev/null; sleep 2
pnpm --filter @carelik/infra-aws harness:setup >/dev/null 2>&1 || { echo setup failed; exit 1; }
setsid nohup pnpm --filter @carelik/infra-aws harness:serve > /tmp/harness-serve.log 2>&1 &
echo $! > /tmp/harness.pid
for i in $(seq 1 40); do curl -sk https://localhost/config.json >/dev/null 2>&1 && break; sleep 1; done
curl -sk https://localhost/config.json >/dev/null && echo harness-up
