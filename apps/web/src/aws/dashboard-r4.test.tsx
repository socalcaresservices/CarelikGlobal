// R4: a compact dashboard. One row of figures, one work queue with filter chips, the hours and billing detail folded away. SYNTHETIC data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { json, renderAws } from "./test-support";

const soon = (h: number) => new Date(Date.now() + h * 3600e3).toISOString();
const issue = (over: Record<string, unknown>) => ({ issueKey: "k", kind: "shift", reason: "uncovered_open", queue: "needs_attention_now", category: "coverage", severity: "critical", deadline: soon(-1), since: null, shiftId: "s1", visitId: null, entityId: "s1",
  caregiverRecordId: null, clientId: "c1", serviceId: "sv1", clientCode: "CL-1", caregiverCode: null, serviceCode: "PCS", status: "open", firstSeenAt: null, reopenCount: 0, action: "assign_caregiver", recommendedAction: "Choose an eligible caregiver and confirm the assignment.", ...over });
const list = (issues: unknown[]) => ({ asOf: new Date().toISOString(), matching: issues.length, limit: 50, offset: 0, counts: { total: issues.length, critical: 1, urgent: 1, routine: 0, actionNeeded: issues.length, byQueue: {} }, issues });
const util = { services: [{ serviceId: "sv1", serviceCode: "PCS", serviceName: "Personal care", clientCount: 2, authorizedMinutes: 6000, scheduledMinutes: 0, workedMinutes: 3000, billableMinutes: 3000, reviewMinutes: 0, approvedMinutes: 0, remainingMinutes: 600, committedMinutes: 5400,
  overLimitMinutes: 0, nearLimitAuthorizations: 0, criticalAuthorizations: 0, expiringAuthorizations: 0, needsReconciliationMinutes: 0, heldReviewMinutes: 0 }] };
const PERMS = ["visits.read", "shifts.manage", "visits.manage", "clients.names.read", "readiness.read", "documents.read"];
beforeEach(() => { try { window.localStorage.clear(); } catch { /* none */ } });
afterEach(() => cleanup());
const ISSUES = [
  issue({ issueKey: "a" }),
  issue({ issueKey: "b", kind: "document", reason: "document_overdue", category: "documents", severity: "urgent", shiftId: null, entityId: "d1", action: "review_document" }),
  issue({ issueKey: "c", kind: "visit", reason: "missing_clock_out", category: "visits", queue: "visit_review", severity: "urgent", shiftId: null, visitId: "v1", entityId: "v1", action: "review_visit" }),
];

describe("dashboard (R4)", () => {
  it("shows one row of figures with Hours left as the last, and the hours, billing and outage detail folded away", async () => {
    renderAws("/", PERMS, { "GET /v1/action-issues": () => json(200, list(ISSUES)), "GET /v1/reports/utilisation": () => json(200, util) });
    const row = await screen.findByTestId("kpi-row", {}, { timeout: 15000 });
    expect(await within(row).findByTestId("stream-hours", {}, { timeout: 15000 })).toHaveTextContent(/Hours left/);
    const detail = screen.getByTestId("hours-billing-detail");
    expect(detail).not.toHaveAttribute("open");
    expect(within(detail).getByText("Hours, billing and outage readiness")).toBeInTheDocument();
  }, 30000);

  it("the hours figure reads Unavailable, never 0, when the hours could not be loaded", async () => {
    renderAws("/", PERMS, { "GET /v1/action-issues": () => json(200, list(ISSUES)), "GET /v1/reports/utilisation": () => json(500, { error: { code: "internal_error", message: "x" } }) });
    expect(await screen.findByTestId("stream-hours-unavailable", {}, { timeout: 15000 })).toHaveTextContent("Unavailable");
    expect(screen.getByTestId("stream-hours")).not.toHaveTextContent(/\b0\s*h/);
  }, 30000);

  it("the work queue has filter chips; a chosen group shows only its own rows, each with one action", async () => {
    renderAws("/", PERMS, { "GET /v1/action-issues": () => json(200, list(ISSUES)), "GET /v1/reports/utilisation": () => json(200, util) });
    const queue = await screen.findByTestId("top-issues", {}, { timeout: 15000 });
    expect(within(queue).getAllByTestId("top-issue")).toHaveLength(3);
    fireEvent.click(within(queue).getByRole("button", { name: "Documents" }));
    expect(within(queue).getByRole("button", { name: "Documents" })).toHaveAttribute("aria-pressed", "true");
    const rows = within(queue).getAllByTestId("top-issue");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getAllByRole("link")).toHaveLength(1);
    fireEvent.click(within(queue).getByRole("button", { name: "Authorization" }));
    expect(within(queue).getByText("Nothing in this group is critical or urgent.")).toBeInTheDocument();
    fireEvent.click(within(queue).getByRole("button", { name: "All" }));
    await waitFor(() => expect(within(queue).getAllByTestId("top-issue")).toHaveLength(3));
  }, 30000);

  it("no chips and 'Nothing is critical or urgent right now.' when the queue is empty", async () => {
    renderAws("/", PERMS, { "GET /v1/action-issues": () => json(200, list([])), "GET /v1/reports/utilisation": () => json(200, util) });
    const queue = await screen.findByTestId("top-issues", {}, { timeout: 15000 });
    expect(within(queue).queryByRole("group", { name: "Show" })).toBeNull();
    expect(within(queue).getByText("Nothing is critical or urgent right now.")).toBeInTheDocument();
  }, 30000);
});
