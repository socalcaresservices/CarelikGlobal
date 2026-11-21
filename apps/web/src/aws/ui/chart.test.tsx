// The shared Chart follows the palette chosen in Settings > Appearance > Dashboard charts (not fixed theme colours).
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let chartType = "bar";
vi.mock("../appearance/appearance-hooks", async (importOriginal) => {
  const real = await importOriginal<typeof import("../appearance/appearance-hooks")>();
  return { ...real, useEffectiveAppearance: () => ({ chartType }) };
});
import { Chart } from "./chart";

const data = [
  { label: "Respite", value: 10, display: "10 h" },
  { label: "Personal care", value: 5, display: "5 h" },
];
afterEach(() => { localStorage.removeItem("ogevia.dashboard.palette"); chartType = "bar"; });

describe("Chart palette", () => {
  it("bars use the first colour of the chosen palette (Primary colors)", () => {
    localStorage.setItem("ogevia.dashboard.palette", "primary");
    const { container } = render(<Chart title="Hours" data={data} shape="parts-of-whole" unit="hours" total="15" />);
    const bar = container.querySelector("li span.block") as HTMLElement;
    expect(bar.style.background).toBe("rgb(29, 78, 216)");   // #1D4ED8
  });
  it("a donut cycles through the palette colours in order", () => {
    localStorage.setItem("ogevia.dashboard.palette", "primary");
    chartType = "donut";
    const { container } = render(<Chart title="Hours" data={data} shape="parts-of-whole" unit="hours" total="15" />);
    const strokes = Array.from(container.querySelectorAll("circle")).map((c) => c.getAttribute("stroke")).filter((s) => s && !s.startsWith("rgb(var"));
    expect(strokes).toEqual(["#1D4ED8", "#DC2626"]);
  });
  it("without a saved choice it uses the default palette (Care blue)", () => {
    const { container } = render(<Chart title="Hours" data={data} shape="parts-of-whole" unit="hours" total="15" />);
    const bar = container.querySelector("li span.block") as HTMLElement;
    expect(bar.style.background).toBe("rgb(35, 90, 231)");   // #235AE7
  });
});
