// Static facts about scripts/deploy-test-slice.sh that the release procedure relies on. They are the evidence for which of its steps may be used for the release candidate
// and why a separate pin check runs first. The script is NOT changed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const text = readFileSync(fileURLToPath(new URL("../scripts/deploy-test-slice.sh", import.meta.url)), "utf8");
const code = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const step = (name: string) => { const m = new RegExp(`^  ${name}\\)\\n([\\s\\S]*?)\\n    ;;`, "m").exec(code); if (!m) throw new Error(`step ${name} not found`); return m[1]!; };

describe("deploy-test-slice.sh", () => {
  it("never selects a version: it runs no git command and builds and deploys whatever checkout it sits in", () => {
    expect(code).not.toMatch(/(^|[\s(;&|])git\s/m);
    expect(code).toMatch(/HERE="\$\(cd "\$\(dirname "\$0"\)\/\.\." && pwd\)"/);
    expect(code).toMatch(/REPO="\$\(cd "\$HERE\/\.\.\/\.\." && pwd\)"/);
    expect(step("web")).toContain('cd "$REPO/apps/web"');
    expect(step("web")).toContain("npx vite build --outDir dist-aws");
  });
  it("therefore a pin check must run first; the pin check exists and is read-only", () => {
    const pin = readFileSync(fileURLToPath(new URL("../slice/candidate-pin-check.sh", import.meta.url)), "utf8");
    expect(pin).toContain("PINS HOLD");
  });
  it("the infra step deploys all five TEST stacks, and the database step creates the database and rewrites the application login role: neither is used for this release", () => {
    expect(code).toContain("STACKS=(Ogevia-prod-EvidenceStorage Ogevia-prod-NetworkEgress Ogevia-prod-WebHosting Ogevia-prod-ServiceVerificationApi Ogevia-prod-Observability)");
    expect(step("infra")).toContain('cdk_ deploy "${STACKS[@]}"');
    expect(step("database")).toContain("00_create_test_database.sql");
    expect(step("database")).toContain("01_app_login_role.sql");
    expect(step("database")).toContain("migrate.ts");
  });
  it("the web step: TEST label by default, no deletion, no config.json, only the TEST stack outputs, an approval reference and the right account are required", () => {
    const w = step("web");
    expect(code).toContain('APP_ENV="${OGEVIA_APP_ENV:-test}"');
    expect(w).toContain('VITE_APP_ENV="$APP_ENV"');
    expect(w).not.toMatch(/--delete/);
    expect(w).not.toContain("config.json");
    for (const out of ["WebOrigin", "TestAppClientId", "SiteBucketName", "DistributionId", "ApiUrl"]) expect(w).toContain(out);
    expect(w).toContain("Ogevia-prod-WebHosting");
    expect(w).not.toContain("Ogevia-prd");
    expect(w).toMatch(/^\s*guard$/m);
    expect(code).toContain('ACCOUNT=300094796789');
    expect(code).toMatch(/OGEVIA_DEPLOY_APPROVAL:-\}" =~ \^\[A-Za-z0-9\._-\]\{6,64\}\$/);
    expect(w).toContain("aws cloudfront create-invalidation");
  });
  it("it has no rollback and does not capture the live web files first, so the procedure captures them before and restores them itself", () => {
    expect(code).not.toMatch(/rollback/i);
    expect(step("web")).not.toContain("web-before");
  });
});
