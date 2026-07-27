import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MetricStrip } from "./metric-strip";

describe("MetricStrip", () => {
  it("renders every item's label, value, and optional hint", () => {
    render(
      <MetricStrip
        items={[
          { key: "a", label: "Desired hours", value: 120 },
          { key: "b", label: "Scheduled", value: 84, hint: "this week" },
          { key: "c", label: "Gap", value: "36h", tone: "danger" }
        ]}
      />
    );

    expect(screen.getByText("Desired hours")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.getByText("Scheduled")).toBeInTheDocument();
    expect(screen.getByText("84")).toBeInTheDocument();
    expect(screen.getByText("this week")).toBeInTheDocument();
    expect(screen.getByText("36h")).toHaveClass("text-red-700");
  });

  it("renders nothing but the card shell when items is empty", () => {
    const { container } = render(<MetricStrip items={[]} />);
    expect(container.querySelectorAll("div").length).toBeGreaterThan(0);
  });
});
