import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UtilizationCard } from "./utilization-card";

describe("UtilizationCard", () => {
  it("shows available, scheduled, completed, and remaining as text", () => {
    render(<UtilizationCard availableHours={20} scheduledHours={15} completedHours={10} />);
    expect(screen.getByText("20h")).toBeInTheDocument();
    expect(screen.getByText("15h")).toBeInTheDocument();
    expect(screen.getByText("10h")).toBeInTheDocument();
    expect(screen.getByText("5h")).toBeInTheDocument();
    expect(screen.getByText("75% utilized")).toBeInTheDocument();
  });

  it("floors remaining at zero when overbooked", () => {
    render(<UtilizationCard availableHours={10} scheduledHours={15} />);
    const remainingValues = screen.getAllByText("0h");
    expect(remainingValues.length).toBeGreaterThan(0);
  });

  it("shows 'Not set' and no progress bar when there's no available-hours target", () => {
    render(<UtilizationCard availableHours={null} scheduledHours={5} />);
    expect(screen.getByText("Not set")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});
