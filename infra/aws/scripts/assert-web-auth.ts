// Fails closed unless a built web bundle carries EXACTLY the production sign-in configuration (pool, domain, client) and nothing of the
// TEST pool. Found necessary on 2026-11-01: a production website was built against the TEST pool and nothing checked it.
// Usage: tsx scripts/assert-web-auth.ts <distDir> <poolId> <domain> <clientId> <testPoolId>     (no secrets are printed)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(js|html|json)$/.test(n) ? [p] : [];
  });
}

export function webAuthProblems(dir: string, pool: string, domain: string, client: string, testPool: string): string[] {
  const problems: string[] = [];
  const all = files(dir).map((f) => readFileSync(f, "utf8"));
  const text = all.join("\n");
  const testPrefix = testPool.toLowerCase().replace(/_/g, ""); // the TEST pool's default sign-in domain prefix
  if (!/^[a-z]{2}-[a-z]+-\d_[A-Za-z0-9]{9}$/.test(pool)) problems.push(`the expected pool '${pool}' is not a pool id`);
  if (pool === testPool) problems.push("the expected pool equals the TEST pool");
  if (!/^https:\/\/[a-z0-9-]+\.auth\.[a-z0-9-]+\.amazoncognito\.com$/.test(domain)) problems.push(`the expected domain '${domain}' is not a sign-in domain`);
  if (!client) problems.push("no expected client id");
  const seen = (key: string) => [...text.matchAll(new RegExp(`${key}:"([^"]*)"`, "g"))].map((m) => m[1]!);
  for (const [key, want] of [["VITE_COGNITO_USER_POOL_ID", pool], ["VITE_COGNITO_DOMAIN", domain], ["VITE_COGNITO_CLIENT_ID", client]] as const) {
    const got = seen(key);
    if (got.length === 0) problems.push(`${key} is not in the bundle`);
    else if (got.some((g) => g !== want)) problems.push(`${key} in the bundle is not the production value`);
  }
  if (text.includes(testPool) || text.toLowerCase().includes(testPrefix)) problems.push("the bundle references the TEST sign-in pool or its domain");
  return problems;
}

if (process.argv[1] && process.argv[1].endsWith("assert-web-auth.ts")) {
  const [dir, pool, domain, client, testPool] = process.argv.slice(2);
  if (!dir || !pool || !domain || !client || !testPool) { console.error("usage: assert-web-auth.ts <distDir> <poolId> <domain> <clientId> <testPoolId>"); process.exit(2); }
  const problems = webAuthProblems(dir, pool, domain, client, testPool);
  if (problems.length) { for (const p of problems) console.error(`FAIL ${p}`); process.exit(1); }
  console.log("PASS the bundle carries the production sign-in pool, domain and client and nothing of the TEST pool");
}
