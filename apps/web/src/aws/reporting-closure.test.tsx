// Reporting & billing (Board 5): the five sections, a missed-visits figure that is NOT published, unavailable data never shown as zero, server-made exports, and the owner-only audit report.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json, renderAws } from "./test-support";

afterEach(() => cleanup());
const row = (over: Record<string, unknown> = {}) => ({ clientId: "c1", clientCode: "CL-1", serviceId: "s1", serviceCode: "PCS", serviceName: "Personal care", authorizationLineageId: "l1", authorizationVersion: 1, periodStart: "2026-10-01", periodEnd: "2026-12-31", authorizedMinutes: 6000,
  scheduledMinutes: 600, heldReviewMinutes: 0, needsReconciliationMinutes: 0, reservedMinutes: 600, workedMinutes: 3000, confirmedMinutes: 2800, billableMinutes: 2700, needsCorrectionMinutes: 100, waitingMinutes: 60, readyForReviewMinutes: 1200, approvedForBillingMinutes: 900, reviewedNotBillableMinutes: 120,
  humanApprovedMinutes: 900, needsCorrectionVisits: 2, waitingVisits: 1, readyForReviewVisits: 5, approvedVisits: 7, voidedApprovals: 1, adjustmentMinutes: 0, committedMinutes: 3300, remainingMinutes: 2700, overLimitMinutes: 0, reservedOk: true, visitsOk: true, balanceOk: true, differenceMinutes: 0, ...over });
const perf = { performance: { monthStart: "2026-10-01", monthEnd: "2026-10-31", counts: { shifts: 40, coveredNow: 10, uncoveredNow: 3, callOuts: 2, cancelled: 4, noShow: 1, endedWithoutRecord: 2 }, utilization: { authorizedMinutes: 6000, committedMinutes: 3300, percent: 55 },
  missedVisits: null, missedVisitsNote: "Not published. A missed-visits figure needs a definition and event tracking that the owner has not approved yet.", cancellationNote: "A reason is required to cancel a shift, but who cancelled is not recorded, so cancellations are not split by party.", noShowNote: "No-show is set by a person; Ogevia never sets it on its own." } };
const MANAGER = ["visits.read", "shifts.manage", "visits.manage", "billing.visits.read", "reports.export"];
const handlers = () => ({ "GET /v1/reports/monthly-chain": () => json(200, { rows: [row(), row({ clientId: "c2", needsCorrectionVisits: 1, readyForReviewVisits: 2 })] }), "GET /v1/reports/agency-performance": () => json(200, perf) });

describe("Reporting & billing", () => {
  it("shows the five sections with figures summed from the server's report; missed visits says Not published, with the definition behind it", async () => {
    renderAws("/reporting", MANAGER, handlers());
    const bill = await screen.findByTestId("billing-readiness", {}, { timeout: 15000 });
    expect(bill).toHaveTextContent("Needs correction3");
    expect(bill).toHaveTextContent("Ready for review7");
    expect(bill).toHaveTextContent("Approved for billing14");
    expect(bill).toHaveTextContent("There is no submitted or billed state");
    const hours = screen.getByTestId("authorized-delivered");
    expect(hours).toHaveTextContent("Authorized200 h"); // 2 x 6000 min
    const p = await screen.findByTestId("agency-performance");
    expect(p).toHaveTextContent("Shifts this month40");
    expect(p).toHaveTextContent("Utilization55%");
    expect(within(p).getByTestId("missed-visits")).toHaveTextContent("Not published");
    fireEvent.click(within(p).getByText("Definitions and what is not measured"));
    expect(within(p).getByTestId("missed-note")).toHaveTextContent("owner has not approved");
    for (const id of ["Billing readiness", "Authorized vs delivered hours", "Agency performance", "Reports and exports", "Compliance and audit evidence"]) expect(screen.getByRole("heading", { name: id })).toBeInTheDocument();
  }, 30000);

  it("a failed report is unavailable, never zero; a role without billing access does not see ready or approved counts", async () => {
    renderAws("/reporting", ["visits.read", "shifts.manage"], { "GET /v1/reports/monthly-chain": () => json(200, { rows: [row()] }), "GET /v1/reports/agency-performance": () => json(500, { error: { code: "internal_error", message: "Something went wrong." } }) });
    const bill = await screen.findByTestId("billing-readiness", {}, { timeout: 15000 });
    expect(bill).not.toHaveTextContent("Ready for review");
    expect(bill).toHaveTextContent("need billing access");
    expect(await screen.findByText(/Agency performance could not be loaded. It is shown as unavailable, not as zero/)).toBeInTheDocument();
    expect(screen.queryByTestId("agency-performance")).not.toBeInTheDocument();
  }, 30000);

  it("exports the billing review through the server and says generated, not delivered; the audit report is for the owner only", async () => {
    const created = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined);
    const { calls } = renderAws("/reporting", MANAGER, { ...handlers(), "POST /v1/exports": () => json(200, { exportId: "e1", filename: "billing-review-2026-10.csv", csv: "a,b", rowCount: 3 }) });
    fireEvent.click(await screen.findByRole("button", { name: /Export billing review/ }, { timeout: 15000 }));
    await waitFor(() => expect(calls.find((c) => c.path === "/v1/exports")?.body).toMatchObject({ report: "billing_review", params: { monthStart: expect.stringMatching(/^\d{4}-\d{2}-01$/) } }));
    expect(await screen.findByText(/The server generated billing-review-2026-10.csv \(3 rows\) and recorded the export. Whether it reached this device is not recorded./)).toBeInTheDocument();
    expect(created).toHaveBeenCalled();
    expect(screen.getByText("The audit report is available to the agency owner.")).toBeInTheDocument();
    expect(screen.queryByTestId("audit-report")).not.toBeInTheDocument();
  }, 30000);

  it("a role that cannot export is told so and has no export button", async () => {
    renderAws("/reporting", ["visits.read", "shifts.manage", "billing.visits.read"], handlers());
    await screen.findByTestId("billing-readiness", {}, { timeout: 15000 });
    expect(screen.queryByRole("button", { name: /Export billing review/ })).not.toBeInTheDocument();
    expect(screen.getByText("Your role can read these reports but not export them.")).toBeInTheDocument();
  }, 30000);

  it("the owner reads the audit report (field names only), filters by action, pages, and exports it through the server", async () => {
    const { calls } = renderAws("/reporting", [...MANAGER, "organization.update"], { ...handlers(),
      "GET /v1/reports/audit": ({ url }) => json(200, { report: { total: 30, limit: 25, offset: Number(url.searchParams.get("offset")), note: "Field names only, never values. Reasons are the notes staff typed.",
        events: [{ occurredAt: new Date().toISOString(), action: "client.stage_changed", actorName: "Morgan Manager", entityType: "client_preparation", reason: "Preparing", fields: ["stage"] }] } }),
      "POST /v1/exports": () => json(200, { exportId: "e2", filename: "audit-report.csv", csv: "x", rowCount: 30 }) });
    URL.createObjectURL = () => "blob:y"; URL.revokeObjectURL = () => undefined;
    const panel = await screen.findByTestId("audit-report", {}, { timeout: 15000 });
    const ev = await within(panel).findByTestId("audit-event");
    expect(within(panel).getByRole("list", { name: "Audit events" })).toBeInTheDocument();
    expect(ev).toHaveTextContent("client stage changed · Morgan Manager · client preparation · changed: stage · Preparing");
    expect(panel).toHaveTextContent("30 events");
    expect(panel).toHaveTextContent("Field names only, never values");
    fireEvent.change(within(panel).getByLabelText(/Action starts with/), { target: { value: "client." } });
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/reports/audit" && c.query.get("actionPrefix") === "client.")).toBe(true));
    fireEvent.click(within(panel).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/reports/audit" && c.query.get("offset") === "25")).toBe(true));
    fireEvent.click(within(panel).getByRole("button", { name: /Export audit report/ }));
    await waitFor(() => expect(calls.find((c) => c.path === "/v1/exports")?.body).toMatchObject({ report: "audit_report", params: { actionPrefix: "client." } }));
    fireEvent.change(within(panel).getByLabelText("To"), { target: { value: "2000-01-01" } });
    expect(await within(panel).findByRole("alert")).toHaveTextContent("start date must not be after the end date");
  }, 30000);
});
