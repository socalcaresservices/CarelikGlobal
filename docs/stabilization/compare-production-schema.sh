#!/usr/bin/env bash
# OWNER-RUN, READ-ONLY. Compares production's schema fingerprint with the one computed from the repository migrations
# (0001-0107 and 0109-0112; 0108 is a proposal and is not included). No row content is read; no write is made (the connection is read-only).
# Needs: a clone of this repository at the commit being checked, node + pnpm, and OGEVIA_DATABASE_URL pointing at ogevia_prd
# (credentials from the environment, never from Git). Prints the object keys that differ; empty output = identical schema.
set -euo pipefail
: "${OGEVIA_DATABASE_URL:?set OGEVIA_DATABASE_URL (read-only access to ogevia_prd)}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp)"
( cd "$HERE/../../infra/aws" && pnpm exec tsx db/scripts/schema-fingerprint.ts ) > "$OUT"
diff <(cat "$HERE/schema-fingerprint-from-migrations.json") "$OUT" && echo "IDENTICAL: production schema equals the schema built from the repository migrations" || echo "DIFFERENCES above: lines starting < are expected (repository), > are production"
rm -f "$OUT"
