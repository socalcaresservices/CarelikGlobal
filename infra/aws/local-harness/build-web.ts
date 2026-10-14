// Builds the AWS (Cognito) web app into local-harness/.local/dist. The sign-in settings are NOT baked in:
// the harness serves them at /config.json, exactly as a real deployment does.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { DIST_DIR, LOCAL_DIR } from "./common.js";

mkdirSync(LOCAL_DIR, { recursive: true });
const result = spawnSync("pnpm", ["--filter", "@carelik/web", "exec", "vite", "build", "--outDir", DIST_DIR, "--emptyOutDir"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, VITE_AUTH_PROVIDER: "cognito" },
});
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`\nWeb app built into ${DIST_DIR}\nNext: pnpm --filter @carelik/infra-aws harness:serve`);
