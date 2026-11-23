// R18: Availability is a caregiver's own screen. Office roles are sent Home and never trigger the request that answers "Forbidden". SYNTHETIC data only.
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderAws } from "./test-support";

afterEach(cleanup);
const OFFICE = ["visits.read", "shifts.manage", "visits.manage", "clients.names.read", "readiness.read", "documents.read", "organization.update"];

describe("Availability route", () => {
  it.each([["manager", "manager"], ["organization_owner", "owner"], ["scheduler", "scheduler"]])("a %s opening /availability lands Home, sees no Forbidden page and never calls the availability API", async (role) => {
    const { calls } = renderAws("/availability", OFFICE, {}, role);
    expect(await screen.findByRole("heading", { name: "Dashboard" }, { timeout: 15000 })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/me")).toBe(true));
    expect(screen.queryByText(/forbidden/i)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Availability" })).toBeNull();
    expect(calls.filter((c) => c.path === "/v1/availability" || c.path === "/v1/care-opportunities")).toHaveLength(0);
  }, 30000);

  it("a caregiver (availability.manage_own) still opens it", async () => {
    renderAws("/availability", ["availability.manage_own", "documents.manage_own"], {}, "caregiver");
    expect(await screen.findByRole("heading", { name: "Availability" }, { timeout: 15000 })).toBeInTheDocument();
  }, 30000);
});
