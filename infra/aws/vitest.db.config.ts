import { defineConfig } from "vitest/config";

// PostgreSQL integration tests. Requires OGEVIA_TEST_DATABASE_URL (a LOCAL
// admin connection); each file creates and drops its own database.
export default defineConfig({
  test: {
    include: ["db/test/**/*.db.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
