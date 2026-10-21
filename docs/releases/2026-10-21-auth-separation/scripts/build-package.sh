#!/usr/bin/env bash
# Builds the OPERATOR PACKAGE for the production authentication separation: one tarball with the approved commit (new/), the previous commit (previous/, the rollback source),
# the release helper scripts the scripts reuse (vendor/) and the SQL (sql/), plus BUILD_INFO.json and a MANIFEST.sha256. Built from COMMITS (git archive), never from the
# working tree, so the package is exactly what was reviewed. The branch does not need to be pushed: upload the tarball to CloudShell.
#   bash build-package.sh <output dir> <previous commit>        (candidate = HEAD)
# Refuses if the previous commit already contains the dedicated pool (it must be the code BEFORE this change) or if the candidate does not.
set -euo pipefail
OUT="${1:-}"; PREV="${2:-}"
[[ -n "$OUT" && -n "$PREV" ]] || { echo "usage: bash build-package.sh <output dir> <previous commit>" >&2; exit 2; }
REPO="$(git rev-parse --show-toplevel)"; cd "$REPO"
CAND=$(git rev-parse --verify HEAD^{commit}); PREV=$(git rev-parse --verify "$PREV^{commit}")
[[ "$CAND" != "$PREV" ]] || { echo "STOP: the previous commit equals the candidate" >&2; exit 1; }
git show "$CAND:infra/aws/lib/config.ts" | grep -q dedicatedUserPool || { echo "STOP: the candidate does not define the dedicated production pool" >&2; exit 1; }
if git show "$PREV:infra/aws/lib/config.ts" | grep -q dedicatedUserPool; then echo "STOP: the previous commit already defines the dedicated pool (it must be the code BEFORE this change)" >&2; exit 1; fi
PATHS=(infra/aws apps packages package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json)
REL=docs/releases/2026-10-21-auth-separation; VEND=docs/releases/2026-10-19-prd-readiness/release/scripts
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/pkg/new" "$STAGE/pkg/previous"
git archive "$CAND" "${PATHS[@]}" "$REL" "$VEND/lib.sh" "$VEND/window.sh" | tar -x -C "$STAGE/pkg/new"
git archive "$PREV" "${PATHS[@]}" | tar -x -C "$STAGE/pkg/previous"
# the operator runs from new/<REL>/scripts: vendor/ and sql/ sit beside the scripts
mkdir -p "$STAGE/pkg/new/$REL/scripts/vendor" "$STAGE/pkg/new/$REL/scripts/sql"
cp "$STAGE/pkg/new/$VEND/lib.sh" "$STAGE/pkg/new/$VEND/window.sh" "$STAGE/pkg/new/$REL/scripts/vendor/"
cp "$STAGE/pkg/new/infra/aws/db/deploy/15_prd_inspect_sign_ins.sql" "$STAGE/pkg/new/infra/aws/db/deploy/16_prd_relink_sign_in.sql" "$STAGE/pkg/new/$REL/scripts/sql/"
# Pre-synthesized templates (local, no AWS call) so the operator needs no synth just to run the read-only gate. The SAME dump script is used for both trees.
# node_modules are linked in only while dumping and are never part of the package.
for T in new previous; do
  while IFS= read -r nm; do rel="${nm#"$REPO"/}"; mkdir -p "$STAGE/pkg/$T/$(dirname "$rel")"; ln -s "$nm" "$STAGE/pkg/$T/$rel"; done < <(find "$REPO" -maxdepth 4 -name node_modules -prune -not -path "*/node_modules/*")
  [[ -f "$STAGE/pkg/$T/infra/aws/test/dump-templates.ts" ]] || cp "$STAGE/pkg/new/infra/aws/test/dump-templates.ts" "$STAGE/pkg/$T/infra/aws/test/dump-templates.ts"
  (cd "$STAGE/pkg/$T/infra/aws" && npx --no-install tsx test/dump-templates.ts "$STAGE/pkg/templates/$T" >/dev/null) || { echo "STOP: could not synthesize the $T templates" >&2; exit 1; }
  find "$STAGE/pkg/$T" -name node_modules -type l -delete
  [[ -s "$STAGE/pkg/templates/$T/Ogevia-prd-ServiceVerificationApi.json" ]] || { echo "STOP: the $T templates are incomplete" >&2; exit 1; }
done
[[ -s "$STAGE/pkg/templates/new/Ogevia-prd-Auth.json" && ! -e "$STAGE/pkg/templates/previous/Ogevia-prd-Auth.json" ]] || { echo "STOP: Auth stack must exist in the new templates only" >&2; exit 1; }
jq -n --arg c "$CAND" --arg p "$PREV" --arg t "$(date -u +%FT%TZ)" --arg b "$(git rev-parse --abbrev-ref HEAD)" \
  '{package:"ogevia-prd-auth-separation", candidate_commit:$c, previous_commit:$p, built_at:$t, built_from_branch:$b, note:"built from commits with git archive; verify MANIFEST.sha256 before use"}' > "$STAGE/pkg/BUILD_INFO.json"
(cd "$STAGE/pkg" && find . -type f ! -name MANIFEST.sha256 | LC_ALL=C sort | sed 's|^\./||' | xargs -d '\n' sha256sum > MANIFEST.sha256)
mkdir -p "$OUT"; NAME="ogevia-prd-auth-package-${CAND:0:12}.tar.gz"
tar -C "$STAGE" --sort=name --owner=0 --group=0 --numeric-owner --mtime='2026-01-01 00:00:00' -czf "$OUT/$NAME" pkg
(cd "$OUT" && sha256sum "$NAME" > "$NAME.sha256")
echo "built $OUT/$NAME"; cat "$OUT/$NAME.sha256"
echo "candidate $CAND"; echo "previous  $PREV"; echo "files $(wc -l < "$STAGE/pkg/MANIFEST.sha256")"
