import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ShortHelp } from "./help-text";

describe("ShortHelp", () => {
  it("shows the short line, keeps the longer text behind Details (closed), and loses nothing", () => {
    render(<ShortHelp details="The longer background explanation.">Short instruction.</ShortHelp>);
    expect(screen.getByText("Short instruction.")).toBeVisible();
    const details = screen.getByText("Details").closest("details")!;
    expect(details.open).toBe(false);
    expect(within(details).getByText("The longer background explanation.")).toBeInTheDocument();
  });
  it("renders no Details control when there is nothing more to say", () => {
    render(<ShortHelp>Only this.</ShortHelp>);
    expect(screen.queryByText("Details")).toBeNull();
  });
});
