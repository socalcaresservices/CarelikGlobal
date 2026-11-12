// Home (B1-R3, R5, R6, R7, R9, R10): the compact Critical-then-Urgent list, the authorization alert with a link, highlights in Today's visits, folding optional sections
// without hiding alerts, refresh after a change, and curated failure messages. The four-stream Home, White background and Minimal layout are unchanged. SYNTHETIC data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { json, renderAws } from "./test-support";

const soon = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();
const issue = (over: Record<string, unknown>) => ({ issueKey: "k", kind: "shift", reason: "uncovered_open", queue: "needs_attention_now", category: "coverage", severity: "critical", deadline: soon(-1), since: null, shiftId: "s1", visitId: null, entityId: "s1",
  caregiverRecordId: null, clientId: "c1", serviceId: "sv1", clientCode: "CL-1", caregiverCode: null, serviceCode: "PCS", status: "open", firstSeenAt: null, reopenCount: 0, action: "assign_caregiver", recommendedAction: "Choose an eligible caregiver and confirm the assignment.", ...over });
const list = (issues: unknown[], actionNeeded = issues.length) => ({ asOf: new Date().toISOString(), matching: issues.length, limit: 50, offset: 0, counts: { total: issues.length, critical: 1, urgent: 1, routine: 0, actionNeeded, byQueue: {} }, issues });
const PERMS = ["visits.read", "shifts.manage", "visits.manage", "clients.names.read", "readiness.read", "documents.read"];
beforeEach(() => { try { window.localStorage.clear(); } catch { /* none */ } });
afterEach(() => cleanup());
const util = (over: Record<string, unknown> = {}) => ({ services: [{ serviceId: "sv1", serviceCode: "PCS", serviceName: "Personal care", clientCount: 2, authorizedMinutes: 6000, scheduledMinutes: 0, workedMinutes: 3000, billableMinutes: 3000, reviewMinutes: 0, approvedMinutes: 0, remainingMinutes: 600, committedMinutes: 5400,
  overLimitMinutes: 0, nearLimitAuthorizations: 0, criticalAuthorizations: 1, expiringAuthorizations: 0, needsReconciliationMinutes: 0, heldReviewMinutes: 0, ...over }] });

describe("Needs action first", () => {
  it("lists at most five Critical then Urgent items with the reason, when due, one action link and View all with the total; routine items are not listed", async () => {
    const issues = [issue({ issueKey: "a" }), issue({ issueKey: "b", severity: "urgent", shiftId: "s2", entityId: "s2", deadline: soon(5) }), issue({ issueKey: "c", severity: "urgent", shiftId: "s3", entityId: "s3" }), issue({ issueKey: "d", severity: "urgent", shiftId: "s4", entityId: "s4" }),
      issue({ issueKey: "e", severity: "urgent", shiftId: "s5", entityId: "s5" }), issue({ issueKey: "f", severity: "urgent", shiftId: "s6", entityId: "s6" }), issue({ issueKey: "g", severity: "routine", queue: "upcoming_staffing", shiftId: "s7", entityId: "s7" })];
    renderAws("/", PERMS, { "GET /v1/action-issues": () => json(200, list(issues, 6)) });
    const panel = await screen.findByTestId("top-issues", {}, { timeout: 15000 });
    const rows = within(panel).getAllByTestId("top-issue");
    expect(rows).toHaveLength(5);
    expect(within(rows[0]!).getByText("Critical")).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent("Was due"); // due is its own short column
    expect(within(rows[0]!).getAllByRole("link")).toHaveLength(1); // one action per row
    expect(within(rows[0]!).getByRole("link", { name: "Choose a caregiver" })).toHaveAttribute("href", expect.stringMatching(/^\/schedule\?coverage=1&shift=s1&at=.+$/));
    expect(within(panel).getByRole("link", { name: "View all (6)" })).toHaveAttribute("href", "/action-needed");
    expect(panel).not.toHaveTextContent("Routine");
  }, 30000);

  it("shows the client by NAME (F01/I07); the code appears beside it only when the server flags a shared name, and a row with no visible name keeps its code", async () => {
    const issues = [issue({ issueKey: "a", clientName: "Dana Sample", duplicateName: false }), issue({ issueKey: "b", shiftId: "s2", entityId: "s2", clientName: "Dana Twin", duplicateName: true, clientCode: "CL-7" }), issue({ issueKey: "c", shiftId: "s3", entityId: "s3", clientCode: "CL-3" })];
    renderAws("/", PERMS, { "GET /v1/action-issues": () => json(200, list(issues)) });
    const rows = within(await screen.findByTestId("top-issues", {}, { timeout: 15000 })).getAllByTestId("top-issue");
    expect(rows[0]).toHaveTextContent("Dana Sample");
    expect(rows[0]).not.toHaveTextContent("CL-1");
    expect(rows[1]).toHaveTextContent("Dana Twin (CL-7)");
    expect(rows[2]).toHaveTextContent("CL-3");
  }, 30000);

  it("a failed list says so and is never shown as empty", async () => {
    renderAws("/", PERMS, { "GET /v1/action-issues": () => json(500, { error: { code: "internal_error", message: "Something went wrong. Please try again." } }) });
    expect(await screen.findByTestId("top-issues-error", {}, { timeout: 15000 })).toHaveTextContent("could not be loaded. It is not shown as empty");
    expect(screen.queryByText("Nothing is critical or urgent right now.")).not.toBeInTheDocument();
  }, 30000);

  it("when the list fails, the failure message shows and the headline count is not shown as 0", async () => {
    const calm = { overview: { asOf: new Date().toISOString(), urgentWindowHours: 48, urgent: { items: [], itemCount: 0, issueCount: 0, shifts: 0, visits: 0 }, upcoming: null, documents: null, visitReview: null } };
    renderAws("/", PERMS, { "GET /v1/attention/overview": () => json(200, calm), "GET /v1/action-issues": () => json(500, { error: { code: "internal_error", message: "Something went wrong. Please try again." } }) });
    expect(await screen.findByTestId("top-issues-error", {}, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.queryByTestId("headline-count")).toBeNull();
    expect(screen.queryByTestId("stream-now")).toBeNull();
  }, 30000);
});

describe("Today's visits marks a blocked caregiver, not only an uncovered shift", () => {
  it("shows the hold on a covered shift", async () => {
    const start = new Date(Date.now() + 2 * 3600e3), end = new Date(Date.now() + 4 * 3600e3);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
    renderAws("/", PERMS, {
      "GET /v1/shifts": () => json(200, { shifts: [{ shiftId: "s9", startsAt: start.toISOString(), endsAt: end.toISOString(), localDate: today, coverageState: "covered", clientId: "c1", clientCode: "CL-1", clientName: "Client One", serviceName: "Personal care", serviceCode: "PCS", caregiverRecordId: "r1", caregiverCode: "CG-1", caregiverName: "Alex", hasSignIn: false, reservedMinutes: 120, fromCareRequest: false, hasVisit: false, lastCalloutReason: null }] }),
      "GET /v1/action-issues": () => json(200, list([issue({ issueKey: "h", reason: "compliance_hold", category: "compliance", severity: "urgent", shiftId: "s9", entityId: "s9", caregiverRecordId: "r1", action: "review_hold" })], 1)),
    });
    const todays = await screen.findByTestId("todays-visits", {}, { timeout: 15000 });
    await waitFor(() => expect(within(todays).getByText("Caregiver on a hold")).toBeInTheDocument());
  }, 30000);
});

describe("hours this month: an alert with a link, folding that never hides alerts, curated failure", () => {
  it("the authorization alert links to the clients; the section starts folded with its alert and key figures visible; opening and folding it is remembered", async () => {
    renderAws("/", PERMS, { "GET /v1/reports/utilisation": () => json(200, util()) });
    const tiers = await screen.findByTestId("authorization-tiers", {}, { timeout: 15000 });
    expect(within(tiers).getByTestId("authorization-tiers-link")).toHaveAttribute("href", "/service-verification/reports?view=reconciliation");
    expect(screen.queryAllByText("Billable")).toHaveLength(0); // starts folded
    expect(tiers).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show the hours" }));
    expect(screen.getAllByText("Billable").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Hide the hours" }));
    expect(screen.queryAllByText("Billable")).toHaveLength(0);
    expect(screen.getByTestId("authorization-tiers")).toBeInTheDocument(); // the alert stays
    expect(window.localStorage.getItem(`ogevia.home.collapsed.aaaaaaaa-0000-4000-8000-000000000001.hours`)).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Show the hours" }));
    expect(screen.getAllByText("Billable").length).toBeGreaterThan(0);
    expect(window.localStorage.getItem(`ogevia.home.collapsed.aaaaaaaa-0000-4000-8000-000000000001.hours`)).toBe("0");
  }, 30000);

  it("a failed load prints a fixed message with Retry, not the raw error, and is not zero", async () => {
    renderAws("/", PERMS, { "GET /v1/reports/utilisation": () => json(500, { error: { code: "internal_error", message: "relation \"x\" does not exist" } }) });
    const err = await screen.findByTestId("hours-error", {}, { timeout: 15000 });
    expect(err).toHaveTextContent("could not be loaded. They are not shown as zero.");
    expect(err).not.toHaveTextContent("relation");
    expect(within(err).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  }, 30000);
});
