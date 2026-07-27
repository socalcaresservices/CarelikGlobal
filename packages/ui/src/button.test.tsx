import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button, buttonVariants } from "./button";

describe("Button", () => {
  it("renders children and fires onClick", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("defaults to type=button so it never accidentally submits a form", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("type", "button");
  });

  it("is disabled while loading and shows a spinner instead of the icon", () => {
    render(
      <Button loading icon={<span data-testid="icon" />}>
        Convert
      </Button>
    );
    const button = screen.getByRole("button", { name: "Convert" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByTestId("icon")).not.toBeInTheDocument();
  });

  it("respects an explicit disabled prop", () => {
    render(<Button disabled>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

describe("buttonVariants", () => {
  it("returns danger classes for the danger variant", () => {
    expect(buttonVariants({ variant: "danger" })).toContain("bg-red-600");
  });

  it("defaults to primary/md", () => {
    const classes = buttonVariants();
    expect(classes).toContain("bg-slate-900");
    expect(classes).toContain("text-body");
  });
});
