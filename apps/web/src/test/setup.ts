import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// jsdom has no ResizeObserver, but recharts' <ResponsiveContainer>
// (owner-dashboard-page.tsx's capacity/team-composition charts,
// Build 012) requires one to measure its container - without this stub
// every chart render throws "ResizeObserver is not defined".
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = ResizeObserverStub;

// jsdom also reports every element as 0x0 (no real layout engine), which
// makes recharts' <ResponsiveContainer> refuse to render its children at
// all ("width(0) and height(0) of chart should be greater than 0").
// Fixed non-zero dimensions are enough for recharts to actually mount
// its SVG in tests, without needing a real layout engine.
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 500 });
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 300 });
HTMLElement.prototype.getBoundingClientRect = () =>
  ({ width: 500, height: 300, top: 0, left: 0, right: 500, bottom: 300, x: 0, y: 0, toJSON() {} }) as DOMRect;

// With `globals: false` in vite.config.ts, @testing-library/react's
// automatic afterEach(cleanup) never registers (it only self-registers
// when it finds a global `afterEach`). Without this, DOM from one test
// leaks into the next, causing "Found multiple elements" failures.
afterEach(() => {
  cleanup();
});
