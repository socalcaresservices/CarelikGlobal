import { defineConfig } from "vitest/config";

// Default suite: CDK tests + static database checks (no PostgreSQL needed).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "db/test/**/*.static.test.ts"],
  },
});
