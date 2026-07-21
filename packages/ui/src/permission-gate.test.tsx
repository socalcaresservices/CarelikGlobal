import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PermissionGate } from "./permission-gate";

describe("PermissionGate", () => {
  it("renders children when allowed", () => {
    render(
      <PermissionGate allowed>
        <p>Secret content</p>
      </PermissionGate>
    );
    expect(screen.getByText("Secret content")).toBeInTheDocument();
  });

  it("renders nothing by default when not allowed", () => {
    render(
      <PermissionGate allowed={false}>
        <p>Secret content</p>
      </PermissionGate>
    );
    expect(screen.queryByText("Secret content")).not.toBeInTheDocument();
  });

  it("renders the fallback when not allowed", () => {
    render(
      <PermissionGate allowed={false} fallback={<p>Not available</p>}>
        <p>Secret content</p>
      </PermissionGate>
    );
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.queryByText("Secret content")).not.toBeInTheDocument();
  });
});
