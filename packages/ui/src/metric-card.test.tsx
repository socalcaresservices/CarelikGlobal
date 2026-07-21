import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MetricCard } from "./metric-card";

describe("MetricCard", () => {
  it("renders the value, label, and hint", () => {
    render(<MetricCard value={12} label="Active clients" hint="this month" />);
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("Active clients")).toBeInTheDocument();
    expect(screen.getByText("this month")).toBeInTheDocument();
  });
});
