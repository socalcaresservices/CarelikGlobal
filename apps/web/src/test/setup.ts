import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// With `globals: false` in vite.config.ts, @testing-library/react's
// automatic afterEach(cleanup) never registers (it only self-registers
// when it finds a global `afterEach`). Without this, DOM from one test
// leaks into the next, causing "Found multiple elements" failures.
afterEach(() => {
  cleanup();
});
