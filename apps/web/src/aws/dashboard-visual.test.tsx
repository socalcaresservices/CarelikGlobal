// The Dashboard chart is drawn only when there is something to compare. One value used to fill the whole box with one solid block (treemap), a full disc (pie) or a full bar.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DashboardVisual } from "./home-page";

afterEach(cleanup);
const colors = ["#1d4ed8", "#0f766e", "#b45309"] as const;
const one = [{ label: "Respite", value: 1890, display: "31.5 h" }];
const two = [{ label: "Respite", value: 1890, display: "31.5 h" }, { label: "Personal care", value: 600, display: "10 h" }];
const drawn = (c: HTMLElement) => c.querySelector("figure > div[aria-hidden='true']");

describe("DashboardVisual with one value", () => {
  for (const style of ["treemap", "pie", "segmented"] as const) {
    it(`${style}: no graphic for a single value, but the label and amount are still listed`, () => {
      const { container, getByText } = render(<DashboardVisual title="Unused hours by service" style={style as never} colors={colors} current="segmented" data={one} />);
      expect(drawn(container)).toBeNull();
      expect(getByText("Respite")).toBeInTheDocument();
      expect(getByText("31.5 h")).toBeInTheDocument();
    });
    it(`${style}: the graphic is drawn when two values can be compared`, () => {
      const { container } = render(<DashboardVisual title="Unused hours by service" style={style as never} colors={colors} current="segmented" data={two} />);
      expect(drawn(container)).not.toBeNull();
    });
  }
  it("a value of zero does not count as a second value", () => {
    const { container } = render(<DashboardVisual title="t" style={"treemap" as never} colors={colors} current="segmented" data={[...one, { label: "None", value: 0, display: "0 h" }]} />);
    expect(drawn(container)).toBeNull();
  });
});
