import { defineConfig } from "vitest/config";

// Integration tests against a disposable LOCAL PostgreSQL migrated from zero
// with infra/aws/db/migrations. Requires OGEVIA_TEST_DATABASE_URL.
export default defineConfig({
  test: {
    environment: "node",
    env: { OGEVIA_TEST_LIVE_BASELINE: "0102" },
    include: ["test/**/*.db.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
