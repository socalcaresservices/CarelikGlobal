// Shared fixtures for the PRODUCTION 0086 operator package tests (release 2026-10-26-redesign). The release templates are the REAL ones: `cdk synth` of this checkout (local, no AWS), plan mode
// for the bundled release templates and deploy mode (with an approval reference) for the assembly. The "live" production stacks are derived from them exactly as the read-only capture of
// 2026-10-26 found production (p1-diff-report.sh): the API stack without the 13 staff routes, the two CORS origins and with the previous Handler build; the Auth stack without the app./admin.
// URLs; WebHosting with the one extra export. No AWS, no network, synthetic data only.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const INFRA = join(REPO_ROOT, "infra/aws");
export const PKG_REL = "docs/releases/2026-10-26-redesign-prd-operator";
export const SCRIPTS_SRC = join(REPO_ROOT, PKG_REL, "scripts");
export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const APPROVAL = "REF-PRD-TEST-0001";
export const PRD_STACKS = ["Ogevia-prd-Auth", "Ogevia-prd-DatabaseSecret", "Ogevia-prd-EvidenceStorage", "Ogevia-prd-Observability", "Ogevia-prd-ServiceVerificationApi", "Ogevia-prd-WebHosting"];
export const API = "Ogevia-prd-ServiceVerificationApi", AUTH = "Ogevia-prd-Auth", WEB = "Ogevia-prd-WebHosting", NET = "Ogevia-prod-NetworkEgress";
export const NEW_KEYS: string[] = JSON.parse(readFileSync(join(SCRIPTS_SRC, "new-route-keys.json"), "utf8"));
export const PREVIOUS_HANDLER_KEY = "debd1d4305fc1e230fbc7c7a67ffded67d059f8b61cc3ccc3e238d64e74a3235.zip"; // what production's Handler runs today (capture of 2026-10-26)
export const WEB_EXPORT = "ExportsOutputRefTestSliceAppClient5EA2F71F";
type T = any;

export function sh(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; input?: string } = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", input: opts.input, env: { ...process.env, ...(opts.env ?? {}) }, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), stdout: r.stdout ?? "" };
}

export interface Synth { plan: string; deploy: string; prod: string; rel: string }
let cached: Synth | null = null;
/** synthesizes once per process: plan (prd), deploy (prd, approval) and plan (prod, for NetworkEgress); `rel` is the bundled-release-template layout the scripts read */
export function synth(): Synth {
  if (cached) return cached;
  const root = mkdtempSync(join(tmpdir(), "prd-synth-"));
  const run = (args: string[], out: string, env: Record<string, string> = {}) => {
    const r = sh("npx", ["--no-install", "cdk", "synth", "--quiet", "--no-notices", ...args, "-o", out], { cwd: INFRA, env });
    if (r.code !== 0) throw new Error("cdk synth failed: " + r.out.slice(-600));
  };
  const plan = join(root, "plan"), deploy = join(root, "deploy"), prod = join(root, "prod"), rel = join(root, "rel");
  run(["-c", "env=prd", "-c", "mode=plan"], plan);
  run(["-c", "env=prd", "-c", "mode=deploy"], deploy, { OGEVIA_DEPLOY_APPROVAL: APPROVAL });
  run(["-c", "env=prod", "-c", "mode=plan"], prod);
  mkdirSync(rel);
  for (const s of PRD_STACKS) cpSync(join(plan, `${s}.template.json`), join(rel, `${s}.json`));
  cpSync(join(prod, `${NET}.template.json`), join(rel, `${NET}.json`));
  cached = { plan, deploy, prod, rel };
  return cached;
}
export const readJson = (p: string): T => JSON.parse(readFileSync(p, "utf8"));
export const release = (stack: string): T => readJson(join(synth().rel, `${stack}.json`));

/** the production stacks as the 2026-10-26 capture found them: LIVE = release minus the release's expected difference */
export function liveOf(stack: string): T {
  const t = JSON.parse(JSON.stringify(release(stack)));
  if (stack === API) {
    const R = t.Resources;
    for (const k of Object.keys(R)) if (R[k].Type === "AWS::ApiGatewayV2::Route" && NEW_KEYS.includes(R[k].Properties.RouteKey)) delete R[k];
    for (const k of Object.keys(R)) {
      if (R[k].Type === "AWS::ApiGatewayV2::Api") R[k].Properties.CorsConfiguration.AllowOrigins = R[k].Properties.CorsConfiguration.AllowOrigins.slice(0, -1);
      if (R[k].Type === "AWS::Lambda::Function" && k.startsWith("Handler") && !k.startsWith("IdentityHandler")) R[k].Properties.Code.S3Key = PREVIOUS_HANDLER_KEY;
    }
  }
  if (stack === AUTH) {
    for (const r of Object.values<T>(t.Resources)) if (r.Type === "AWS::Cognito::UserPoolClient") { r.Properties.CallbackURLs = r.Properties.CallbackURLs.slice(0, -2); r.Properties.LogoutURLs = r.Properties.LogoutURLs.slice(0, -2); }
  }
  if (stack === WEB) t.Outputs = { ...(t.Outputs ?? {}), [WEB_EXPORT]: { Value: { Ref: "WebClientX" }, Export: { Name: `Ogevia-prd-WebHosting:${WEB_EXPORT}` } } };
  return t;
}
export const apiResource = (t: T, type: string, pred: (k: string) => boolean = () => true): string => Object.keys(t.Resources).find((k) => t.Resources[k].Type === type && pred(k))!;
