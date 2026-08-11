import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScoreBadge } from "./score-badge";

describe("ScoreBadge", () => {
  it("renders the rounded value, kind label, and a Preview tag", () => {
    render(<ScoreBadge kind="care" value={87.6} preview />);
    expect(screen.getByText("88")).toBeInTheDocument();
    expect(screen.getByText("CareScore")).toBeInTheDocument();
    expect(screen.getByText("Preview")).toBeInTheDocument();
  });

  it("labels a GeoScore badge correctly", () => {
    render(<ScoreBadge kind="geo" value={42} preview />);
    expect(screen.getByText("GeoScore")).toBeInTheDocument();
  });

  it("renders a real score with no Preview tag when preview is omitted", () => {
    render(<ScoreBadge kind="care" value={72} />);
    expect(screen.getByText("72")).toBeInTheDocument();
    expect(screen.queryByText("Preview")).not.toBeInTheDocument();
  });

  it("colors a low score as danger", () => {
    render(<ScoreBadge kind="care" value={30} preview />);
    expect(screen.getByText("30")).toHaveClass("text-red-700");
  });

  it("colors a high score as success", () => {
    render(<ScoreBadge kind="care" value={90} preview />);
    expect(screen.getByText("90")).toHaveClass("text-emerald-700");
  });
});
