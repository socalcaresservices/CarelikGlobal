// R3 (b): when a request fails, the Schedule figures and the Action needed page say so. They never show 0 or "Nothing needs action". SYNTHETIC data only.
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { json, renderAws } from "./test-support";

afterEach(cleanup);
const PERMS = ["visits.read", "shifts.manage", "visits.manage", "clients.names.read", "readiness.read", "documents.read"];
const fail = () => json(500, { error: { code: "internal_error", message: "Something went wrong. Please try again." } });

describe("a failed load is Unavailable, never 0", () => {
  it("Schedule: the shifts failing makes the exceptions bar say items could not be loaded; it never says nothing needs action", async () => {
    renderAws("/schedule", PERMS, { "GET /v1/shifts": fail });
    const panel = await screen.findByTestId("exceptions-panel", {}, { timeout: 15000 });
    await waitFor(() => expect(panel).toHaveTextContent("Some items could not be loaded. They are not zero."), { timeout: 15000 });
    expect(panel).not.toHaveTextContent("Nothing needs action");
    expect(panel).not.toHaveTextContent(/\b0 need action/);
  }, 30000);

  it("Action needed: a failed list shows the error and Retry, no count, and never 'Nothing needs action right now'", async () => {
    renderAws("/action-needed", PERMS, { "GET /v1/action-issues": fail });
    expect(await screen.findByRole("alert", {}, { timeout: 15000 })).toHaveTextContent("The list could not be loaded");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("Nothing needs action right now.")).toBeNull();
    expect(screen.queryByTestId("issue-counts")).toBeNull();
  }, 30000);
});
