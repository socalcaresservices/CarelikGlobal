#!/usr/bin/env bash
# =============================================================================
# Build the operator TARBALL for the TEST release 2026-10-26-redesign (code commit 7870a04: staff management, navigation, Reports, migration 0086 applied from db/pending) (runs HERE, in the development container, never in CloudShell; no network, no AWS).
#   bash build-operator-tarball.sh --out-dir DIR [--code-commit REF]      (REF default: HEAD; resolved to the full 40-hex SHA)
#   OGEVIA_APPROVAL_REF=<owner reference>   optional; default APPROVAL-REF-PENDING-OWNER (a placeholder the pin check reports)
#   OGEVIA_BUILD_TIME=<UTC ISO time>        optional; default now. Fixing it makes two builds of the same inputs byte-identical.
# CODE comes from `git archive <code commit>` (so uncommitted edits to code can never leak in): infra/aws (without the tracked, stale cdk.out), apps/sv-api, apps/web,
# packages, the root package.json, pnpm-lock.yaml, pnpm-workspace.yaml, turbo.json, tsconfig*.json, docs/TESTING_AND_RELEASE_PROCESS.md and docs/release-process.
# The PACKAGE (this folder: procedure, README, scripts) is taken from the WORKING TREE, so it can be shipped before it is committed; its files are in the manifest.
# Never included: .git, _backup, node_modules, docs/releases screenshots and every other release folder, cdk.out.
# Writes DIR/ogevia-operator-<short>.tar.gz, DIR/ogevia-operator-<short>.tar.gz.sha256 (the value the owner gives the operator), DIR/BUILD_INFO.json, DIR/PACKAGE_MANIFEST.sha256.
# The tarball's own hash cannot be written inside it: it is printed here and travels in the covering message / GO message.
# Exit: 0 built and self-verified; 1 refused or failed; 2 usage.
# =============================================================================
set -uo pipefail
PKG_REL=docs/releases/2026-10-26-redesign-operator
die() { echo "REFUSED: $*" >&2; exit 1; }
OUT=""; REF=HEAD
while (( $# )); do
  case "$1" in
    --out-dir) OUT="${2:-}"; shift 2 ;;
    --code-commit) REF="${2:-}"; shift 2 ;;
    *) echo "usage: bash build-operator-tarball.sh --out-dir DIR [--code-commit REF]" >&2; exit 2 ;;
  esac
done
[[ -n "$OUT" ]] || { echo "usage: bash build-operator-tarball.sh --out-dir DIR [--code-commit REF]" >&2; exit 2; }
for t in git tar gzip sha256sum jq find sort; do command -v "$t" >/dev/null 2>&1 || die "missing tool '$t'"; done
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null)" || die "run this inside the repository checkout"
SHA=$(git -C "$REPO" rev-parse --verify "$REF^{commit}" 2>/dev/null) || die "cannot resolve '$REF' to a commit"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "the commit did not resolve to a 40-character SHA"
TREE=$(git -C "$REPO" rev-parse "$SHA^{tree}")
SHORT=${SHA:0:7}
mkdir -p "$OUT" || die "cannot create $OUT"
OUT="$(cd "$OUT" && pwd)"
case "$OUT/" in "$REPO"/*) die "the output directory must be OUTSIDE the repository tree ($REPO)" ;; esac
[[ -d "$REPO/$PKG_REL/scripts" && -f "$REPO/$PKG_REL/OPERATOR_PROCEDURE_$SHORT.md" ]] || die "the package folder $PKG_REL with OPERATOR_PROCEDURE_$SHORT.md is missing from the working tree"
APPROVAL_REF="${OGEVIA_APPROVAL_REF:-APPROVAL-REF-PENDING-OWNER}"
[[ "$APPROVAL_REF" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || die "OGEVIA_APPROVAL_REF must be 6-64 characters of A-Za-z0-9._-"
BUILD_TIME="${OGEVIA_BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
EPOCH=$(date -u -d "$BUILD_TIME" +%s 2>/dev/null) || die "OGEVIA_BUILD_TIME is not a valid UTC time"
TOP="ogevia-test-0086-$SHORT"
WORK=$(mktemp -d "$OUT/.build.XXXXXX") || die "cannot create a work directory in $OUT"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/$TOP"; mkdir -p "$STAGE"

# 1. code, exactly as committed
ROOT_FILES=(package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json)
while IFS= read -r f; do ROOT_FILES+=("$f"); done < <(git -C "$REPO" ls-tree --name-only "$SHA" | grep -E '^tsconfig.*\.json$')
for f in "${ROOT_FILES[@]}"; do git -C "$REPO" cat-file -e "$SHA:$f" 2>/dev/null || die "$f is not in commit $SHA"; done
git -C "$REPO" archive "$SHA" -- infra/aws apps/sv-api apps/web packages "${ROOT_FILES[@]}" docs/TESTING_AND_RELEASE_PROCESS.md docs/release-process | tar -x -C "$STAGE" || die "git archive failed"
rm -rf "$STAGE/infra/aws/cdk.out"
# 2. the package folder, from the working tree (no cache files)
mkdir -p "$STAGE/$PKG_REL"
(cd "$REPO/$PKG_REL" && tar -c --exclude=__pycache__ --exclude='*.pyc' --exclude=.DS_Store .) | tar -x -C "$STAGE/$PKG_REL" || die "cannot copy the package folder"
# 3. nothing that must not travel
for bad in .git _backup node_modules infra/aws/cdk.out; do [[ ! -e "$STAGE/$bad" ]] || die "$bad is in the staging tree"; done
[[ ! -e "$STAGE/infra/aws/db/migrations/0086_staff_management.sql" ]] || die "0086 is in db/migrations: this package applies it from db/pending (decision D1 b); the production release pins 0001-0085"
[[ "$(ls "$STAGE/infra/aws/db/migrations" | grep -c "\.sql$")" == 85 ]] || die "db/migrations does not hold exactly the 85 released migrations"
[[ -z "$(find "$STAGE" -name node_modules -o -name .git -o -name _backup | head -1)" ]] || die "a node_modules, .git or _backup directory is in the staging tree"
[[ -z "$(find "$STAGE" -type l | head -1)" ]] || die "the staging tree contains a symbolic link: $(find "$STAGE" -type l | head -1)"
[[ -z "$(find "$STAGE" -type f -regextype posix-extended -iregex '.*\.(png|jpe?g|gif|webp|mp4|mov|pdf)$' | grep -v '/node_modules/' | head -1)" ]] || die "an image, video or PDF is in the staging tree (screenshots are excluded): $(find "$STAGE" -type f -regextype posix-extended -iregex '.*\.(png|jpe?g|gif|webp|mp4|mov|pdf)$' | head -1)"
[[ -z "$(cd "$STAGE" && find . -type f | grep -E '[[:space:]]' | head -1)" ]] || die "a file name contains whitespace"
for need in infra/aws/db/migrations/0085_create_caregiver_gate_no_service_void.sql infra/aws/db/rollback/0085_create_caregiver_gate_no_service_void.down.sql infra/aws/db/pending/migrations/0086_staff_management.sql infra/aws/db/pending/rollback/0086_staff_management.down.sql infra/aws/db/pending/migrations/0087_staff_invitation_acceptance.sql infra/aws/db/pending/rollback/0087_staff_invitation_acceptance.down.sql infra/aws/bin/ogevia.ts apps/sv-api apps/web pnpm-lock.yaml; do [[ -e "$STAGE/$need" ]] || die "$need is missing from the package"; done
# 4. BUILD_INFO.json then the manifest of every file (the manifest does not list itself)
FILES=$(cd "$STAGE" && find . -type f ! -name BUILD_INFO.json | wc -l)
jq -n --arg commit "$SHA" --arg tree "$TREE" --arg time "$BUILD_TIME" --arg ref "$APPROVAL_REF" --arg pkg "$PKG_REL" --argjson files "$((FILES + 1))" \
  '{code_commit:$commit, code_tree:$tree, package_built_utc:$time, approval_ref:$ref, package_folder:$pkg, files_in_manifest:$files, built_by:"build-operator-tarball.sh", note:"code is git archive of code_commit; the package folder is taken from the working tree at build time"}' > "$STAGE/BUILD_INFO.json" || die "cannot write BUILD_INFO.json"
(cd "$STAGE" && find . -type f ! -name PACKAGE_MANIFEST.sha256 -printf '%P\n' | LC_ALL=C sort | xargs -d '\n' sha256sum) > "$WORK/manifest.tmp" || die "cannot compute the manifest"
mv "$WORK/manifest.tmp" "$STAGE/PACKAGE_MANIFEST.sha256"
[[ "$(wc -l < "$STAGE/PACKAGE_MANIFEST.sha256")" -eq "$((FILES + 1))" ]] || die "the manifest line count differs from the file count"
# 5. deterministic tarball: sorted names, fixed owner and times, gzip without a name or time stamp
TAR="$OUT/ogevia-operator-$SHORT.tar.gz"
(cd "$WORK" && tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner --mode='u+rwX,go+rX,go-w' -cf - "$TOP" | gzip -n -9) > "$TAR.part" || die "tar failed"
mv "$TAR.part" "$TAR"
TARSHA=$(sha256sum "$TAR" | cut -d' ' -f1)
printf '%s  %s\n' "$TARSHA" "$(basename "$TAR")" > "$TAR.sha256"
cp "$STAGE/BUILD_INFO.json" "$OUT/BUILD_INFO.json"; cp "$STAGE/PACKAGE_MANIFEST.sha256" "$OUT/PACKAGE_MANIFEST.sha256"
# 6. self-verification: extract elsewhere and verify the manifest from the extracted copy
CHECK="$WORK/verify"; mkdir -p "$CHECK"
tar -xzf "$TAR" -C "$CHECK" || die "the finished tarball does not extract"
(cd "$CHECK/$TOP" && sha256sum -c --quiet PACKAGE_MANIFEST.sha256) || die "the finished tarball does not verify against its own manifest"
[[ "$(jq -r .code_commit "$CHECK/$TOP/BUILD_INFO.json")" == "$SHA" ]] || die "BUILD_INFO.json in the tarball does not name $SHA"
echo "code commit        : $SHA"
echo "code tree          : $TREE"
echo "package built (UTC): $BUILD_TIME"
echo "approval reference : $APPROVAL_REF"
echo "files in manifest  : $(wc -l < "$STAGE/PACKAGE_MANIFEST.sha256")"
echo "tarball            : $TAR ($(stat -c %s "$TAR") bytes)"
echo "tarball sha256     : $TARSHA"
echo "manifest sha256    : $(sha256sum "$STAGE/PACKAGE_MANIFEST.sha256" | cut -d' ' -f1)"
echo "migration set 0001-0085 sha256 : $(cd "$STAGE/infra/aws/db/migrations" && LC_ALL=C sha256sum -- *.sql | sha256sum | cut -d' ' -f1)"
echo "0086 up file sha256            : $(sha256sum "$STAGE/infra/aws/db/pending/migrations/0086_staff_management.sql" | cut -d' ' -f1)"
echo "0086 down file sha256          : $(sha256sum "$STAGE/infra/aws/db/pending/rollback/0086_staff_management.down.sql" | cut -d' ' -f1)"
echo "0087 up file sha256            : $(sha256sum "$STAGE/infra/aws/db/pending/migrations/0087_staff_invitation_acceptance.sql" | cut -d' ' -f1)"
echo "0087 down file sha256          : $(sha256sum "$STAGE/infra/aws/db/pending/rollback/0087_staff_invitation_acceptance.down.sql" | cut -d' ' -f1)"
echo "pnpm-lock.yaml sha256          : $(sha256sum "$STAGE/pnpm-lock.yaml" | cut -d' ' -f1)"
echo "BUILT AND SELF-VERIFIED"
