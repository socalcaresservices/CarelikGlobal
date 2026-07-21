import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProgressBar, usageLabel, usageTone, UsageBadge } from "./progress-bar";

describe("ProgressBar", () => {
  it("clamps the width to 100% when value exceeds max", () => {
    render(<ProgressBar value={30} max={20} label="Hours used" />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "100");
  });

  it("renders 0% when max is zero", () => {
    render(<ProgressBar value={5} max={0} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });

  it("shows the label text", () => {
    render(<ProgressBar value={5} max={10} label="50% utilized" />);
    expect(screen.getByText("50% utilized")).toBeInTheDocument();
  });
});

describe("usageTone / usageLabel", () => {
  it("is 'success' / 'Normal usage' well under the limit", () => {
    expect(usageTone(5, 20)).toBe("success");
    expect(usageLabel(5, 20)).toBe("Normal usage");
  });

  it("is 'warning' / 'Approaching limit' at 90% or more", () => {
    expect(usageTone(18, 20)).toBe("warning");
    expect(usageLabel(18, 20)).toBe("Approaching limit");
  });

  it("is 'danger' / 'Over limit' beyond the max", () => {
    expect(usageTone(21, 20)).toBe("danger");
    expect(usageLabel(21, 20)).toBe("Over limit");
  });

  it("is neutral with no limit set", () => {
    expect(usageTone(5, 0)).toBe("neutral");
    expect(usageLabel(5, 0)).toBe("No limit set");
  });
});

describe("UsageBadge", () => {
  it("renders the derived label", () => {
    render(<UsageBadge value={21} max={20} />);
    expect(screen.getByText("Over limit")).toBeInTheDocument();
  });
});
