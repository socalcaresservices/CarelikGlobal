// R3 (b): when a request fails, the Schedule figures and the Action needed page say so. They never show 0 or "Nothing needs action". SYNTHETIC data only.
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { json, renderAws } from "./test-support";

afterEach(cleanup);
const PERMS = ["visits.read", "shifts.manage", "visits.manage", "clients.names.read", "readiness.read", "documents.read"];
const fail = () => json(500, { error: { code: "internal_error", message: "Something went wrong. Please try again." } });

describe("a failed load is Unavailable, never 0", () => {
  it("Schedule: the issue list failing makes Urgent exceptions read a dash and says some figures could not be loaded", async () => {
    renderAws("/schedule", PERMS, { "GET /v1/action-issues": fail });
    const overview = await screen.findByTestId("scheduling-overview", {}, { timeout: 15000 });
    expect(await within(overview).findByText(/Some figures could not be loaded/, {}, { timeout: 15000 })).toBeInTheDocument();
    const exceptions = within(overview).getByText(/^Urgent exceptions$/).parentElement!;
    expect(exceptions).toHaveTextContent("Urgent exceptions —");
    expect(exceptions).not.toHaveTextContent(/Urgent exceptions\s*0/);
  }, 30000);

  it("Schedule: today's shifts failing makes Today and Today, no caregiver read a dash", async () => {
    renderAws("/schedule", PERMS, { "GET /v1/shifts": fail });
    const overview = await screen.findByTestId("scheduling-overview", {}, { timeout: 15000 });
    expect(await within(overview).findByText(/Some figures could not be loaded/, {}, { timeout: 15000 })).toBeInTheDocument();
    expect(within(overview).getByText(/^Today$/).parentElement).toHaveTextContent("Today — visits");
    expect(within(overview).getByText(/^Today, no caregiver$/).parentElement).toHaveTextContent("Today, no caregiver —");
  }, 30000);

  it("Action needed: a failed list shows the error and Retry, no count, and never 'Nothing needs action right now'", async () => {
    renderAws("/action-needed", PERMS, { "GET /v1/action-issues": fail });
    expect(await screen.findByRole("alert", {}, { timeout: 15000 })).toHaveTextContent("The list could not be loaded");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("Nothing needs action right now.")).toBeNull();
    expect(screen.queryByTestId("issue-counts")).toBeNull();
  }, 30000);
});
