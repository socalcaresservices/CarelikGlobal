#!/usr/bin/env node
// pnpm test:all: every automated suite the release process (docs/TESTING_AND_RELEASE_PROCESS.md, gate G3) requires.
//
//   1. unit and static tests in every workspace   (`turbo test --force`: a real run, never a cached replay)
//   2. database tests                             (@carelik/infra-aws test:db)
//   3. API tests against a real database          (@carelik/sv-api test:db)
//
// `pnpm test` runs only step 1. Steps 2 and 3 need a LOCAL PostgreSQL superuser in OGEVIA_TEST_DATABASE_URL.
// Without it those suites report their tests as "skipped", which looks like a pass. This script refuses to start
// without the variable and fails if ANY test is skipped or no test ran, so a green result means everything ran.
//
//   OGEVIA_TEST_DATABASE_URL=postgres://postgres:<pw>@127.0.0.1:5432/postgres pnpm test:all
//   node scripts/test-all.mjs --self-test     # checks the summary parser only; no database needed
import { spawn } from "node:child_process";

/** Reads vitest summary lines. Returns problems: skipped tests, or no tests at all. */
export function problemsInSummary(label, output) {
  const problems = [];
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  const tests = [...plain.matchAll(/^\s*(?:[^\n]*?:test:)?\s*Tests\s+(.*)$/gm)].map((m) => m[1]);
  if (tests.length === 0) problems.push(`${label}: no vitest "Tests" summary line found (did the suite run?)`);
  for (const line of tests) {
    if (/\bskipped\b/.test(line)) problems.push(`${label}: skipped tests: "${line.trim()}"`);
    if (/\bfailed\b/.test(line)) problems.push(`${label}: failed tests: "${line.trim()}"`);
    const passed = /(\d+)\s+passed/.exec(line);
    if (!passed || Number(passed[1]) === 0) problems.push(`${label}: no test passed: "${line.trim()}"`);
  }
  return problems;
}

function selfTest() {
  const ok = "   Test Files  3 passed (3)\n        Tests  69 passed (69)\n";
  const skipped = "   Test Files  3 skipped (3)\n        Tests  10 skipped (10)\n";
  const mixed = "        Tests  5 failed | 4 passed (9)\n";
  const turbo = "@carelik/web:test:       Tests  762 passed (762)\n@carelik/ui:test:       Tests  73 passed (73)\n";
  const turboSkip = turbo + "@carelik/x:test:       Tests  2 skipped | 5 passed (7)\n";
  const cases = [
    ["ok", ok, 0], ["skipped", skipped, 2], ["failed", mixed, 1], ["turbo ok", turbo, 0],
    ["turbo with a skip", turboSkip, 1], ["empty output", "nothing here", 1],
  ];
  let bad = 0;
  for (const [name, text, minProblems] of cases) {
    const found = problemsInSummary(name, text).length;
    const pass = minProblems === 0 ? found === 0 : found >= 1;
    if (!pass) bad += 1;
    console.log(`${pass ? "PASS" : "FAIL"}  ${name} (${found} problem${found === 1 ? "" : "s"})`);
  }
  process.exit(bad ? 1 : 0);
}

function run(label, command, args) {
  return new Promise((resolve) => {
    console.log(`\n=== ${label} ===\n$ ${command} ${args.join(" ")}\n`);
    const child = spawn(command, args, { shell: process.platform === "win32", env: { ...process.env, FORCE_COLOR: "0" } });
    let output = "";
    const take = (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const url = process.env.OGEVIA_TEST_DATABASE_URL;
  if (!url) {
    console.error(
      "OGEVIA_TEST_DATABASE_URL is not set.\n" +
        "Set it to a superuser URL of a PostgreSQL on THIS computer (see infra/aws/local-harness/README.md for a Docker command), e.g.\n" +
        "  OGEVIA_TEST_DATABASE_URL=postgres://postgres:<pw>@127.0.0.1:5432/postgres pnpm test:all\n" +
        "Without it the database and API suites are skipped, which is not a pass. Nothing was run.",
    );
    process.exit(2);
  }
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    console.error("OGEVIA_TEST_DATABASE_URL is not a valid URL. Nothing was run.");
    process.exit(2);
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    console.error(`OGEVIA_TEST_DATABASE_URL points at "${host}". The suites create and drop databases, so only a database on this computer is allowed. Nothing was run.`);
    process.exit(2);
  }

  const steps = [
    ["1/3 unit and static tests, all workspaces", "pnpm", ["exec", "turbo", "test", "--force"]],
    ["2/3 database tests (infra-aws)", "pnpm", ["--filter", "@carelik/infra-aws", "test:db"]],
    ["3/3 API tests against a database (sv-api)", "pnpm", ["--filter", "@carelik/sv-api", "test:db"]],
  ];
  const problems = [];
  for (const [label, command, args] of steps) {
    const { code, output } = await run(label, command, args);
    if (code !== 0) problems.push(`${label}: exited with code ${code}`);
    problems.push(...problemsInSummary(label, output));
  }

  console.log("\n=== test:all result ===");
  if (problems.length) {
    for (const p of problems) console.log(`FAIL  ${p}`);
    console.log("\nFAILED. A gate is only passed when every suite ran, none was skipped, and all passed.");
    process.exit(1);
  }
  console.log("PASS  all suites ran, none skipped, all passed.");
}

main();
