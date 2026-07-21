import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QuickActionMenu } from "./quick-action-menu";

describe("QuickActionMenu", () => {
  it("hides its items until opened", () => {
    render(
      <QuickActionMenu>
        <button>Edit</button>
      </QuickActionMenu>
    );
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("closes when an item is clicked", () => {
    render(
      <QuickActionMenu>
        <button>Edit</button>
      </QuickActionMenu>
    );
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("closes on outside click", () => {
    render(
      <div>
        <QuickActionMenu>
          <button>Edit</button>
        </QuickActionMenu>
        <p>Outside</p>
      </div>
    );
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByText("Outside"));
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });
});
