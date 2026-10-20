#!/usr/bin/env bash
# D2: the DEPLOY-MODE ASSEMBLY for the production API stack. Runs `cdk synth` (LOCAL: no AWS call, nothing deployed) from the TEST operator tarball (ogevia-operator-e80b770, git archive of the release
# code commit) with the owner's approval reference, then proves the assembly is exactly the approved release. Writes $B/assembly.env with the three variables the deploy guard needs.
#   OGEVIA_DEPLOY_APPROVAL=<ref> OGEVIA_OPERATOR_PKG=<dir of the extracted ogevia-rehearsal-e80b770> bash d2-assemble-prd.sh        (after: pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store, in that dir)
# Checks, in order: approval reference format; the operator package is the pinned code commit and equals its PACKAGE_MANIFEST; the pinned CDK CLI (2.1143.0) from that package's own node_modules; the
# synthesis succeeds; prd_assembly_check.py (exactly the five Ogevia-prd-* templates equal to the release templates, both Lambda assets present under their pinned names, every
# ogevia:deployment-status tag carries the approval reference). Exit 0 = ready for deploy-guard-prd.sh; 1 = refused.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
CODE_COMMIT=e80b770210c54e423d28ecf48e00f1dda9506cec; CDK_VERSION=2.1143.0
need jq python3 sha256sum node
REF="${OGEVIA_DEPLOY_APPROVAL:-}"; PKG="${OGEVIA_OPERATOR_PKG:-}"; ASM="${OGEVIA_PRD_ASSEMBLY_DIR:-/tmp/ogevia-prd-cdk.out}"
[[ "$REF" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || stop "set OGEVIA_DEPLOY_APPROVAL to the owner's approval reference (6-64 characters of A-Za-z0-9._-); the placeholder APPROVAL-REF-PENDING-OWNER is refused"
[[ "$REF" != APPROVAL-REF-PENDING-OWNER ]] || stop "the approval reference is still the placeholder"
[[ -n "$PKG" && -d "$PKG/infra/aws" ]] || stop "set OGEVIA_OPERATOR_PKG to the extracted operator package (the directory holding BUILD_INFO.json and infra/aws)"
[[ "$(jq -r .code_commit "$PKG/BUILD_INFO.json" 2>/dev/null)" == "$CODE_COMMIT" ]] || stop "the operator package is not built from the approved code commit $CODE_COMMIT"
OPK=$(operator_pkg_ok "$PKG") || stop "$OPK"
CDK="$PKG/infra/aws/node_modules/.bin/cdk"; [[ -x "$CDK" ]] || stop "dependencies are not installed: run 'pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store' in $PKG first"
"$CDK" --version 2>/dev/null | grep -q "^$CDK_VERSION" || stop "the CDK CLI in the package is not version $CDK_VERSION"
case "$ASM" in /tmp/*|"$HOME"/*) ;; *) stop "the assembly directory must be under /tmp or your home directory" ;; esac
[[ "$ASM" != "$PKG"* ]] || stop "the assembly must be outside the operator package"
say "== D2 synth (local; deploy mode; approval $REF; nothing is deployed) $(date -u +%FT%TZ)"
rm -rf "$ASM"
(cd "$PKG/infra/aws" && PATH="$PKG/infra/aws/node_modules/.bin:$PATH" OGEVIA_DEPLOY_APPROVAL="$REF" "$CDK" synth --quiet --no-notices -c env=prd -c mode=deploy -o "$ASM") >"$B/d2-synth.out" 2>&1 || { tail -5 "$B/d2-synth.out"; stop "cdk synth failed (full output: $B/d2-synth.out)"; }
python3 -I -B "$PKG_ROOT/scripts/prd_assembly_check.py" --assembly "$ASM" --release-templates "$PKG_ROOT/release-templates" --approval "$REF" | tee -a "$LOG"; rc=${PIPESTATUS[0]}
[[ $rc == 0 ]] || stop "the assembly is not the approved release (see FAIL lines). Nothing was deployed."
cat > "$B/assembly.env" <<ENV
export OGEVIA_DEPLOY_APPROVAL=$REF
export OGEVIA_PRD_ASSEMBLY=$ASM
export OGEVIA_CDK_BIN=$CDK
ENV
chmod 600 "$B/assembly.env"
say "ASSEMBLY READY: $ASM. Next: source $B/assembly.env && bash deploy-guard-prd.sh check Ogevia-prd-ServiceVerificationApi   (the deploy itself needs the snapshot, the 85|0085 marker and the typed phrase)"
