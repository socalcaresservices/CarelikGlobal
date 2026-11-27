import { defineConfig } from "vitest/config";

// Default suite: CDK tests + static database checks (no PostgreSQL needed).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "db/test/**/*.static.test.ts"],
    // Each CDK synth takes several seconds, and `pnpm test` runs every workspace at once: the default 5 s limit made correct tests fail under load (Release Train 2).
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
