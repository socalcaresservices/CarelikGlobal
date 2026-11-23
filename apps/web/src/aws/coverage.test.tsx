/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies are free-form JSON in the fake API */
// Coverage queue and Open Shifts settings screens (0086). SYNTHETIC data only.
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { json, renderAws } from "./test-support";

const SHIFT = "55555555-0000-4000-8000-000000000001";
const item = { shiftId: SHIFT, shiftRef: "99999999-0000-4000-8000-000000000009", startsAt: "2026-12-01T17:30:00Z", endsAt: "2026-12-02T10:00:00Z", serviceCity: "Winchester", clientCode: "C-104", postingState: "posted",
  roundNo: 2, openSource: "callout", formerCaregiverCode: "CG-A1", urgent: true, requestCount: 2,
  delivery: { queued: 0, sent: 1, delivered: 2, failed: 0, unknown: 1, suppressed: 1, suppressedBy: { quota_exceeded: 1 } }, escalationReasons: ["unfilled_soon"] };
const reqs = [
  { requestId: "r1", orderPosition: 1, requestedAt: "2026-11-23T10:00:00Z", caregiverRecordId: "c1", caregiverCode: "CG-1", caregiverName: "Synthetic One", eligible: false, blockers: ["Over the daily hour limit."], preselected: false },
  { requestId: "r2", orderPosition: 2, requestedAt: "2026-11-23T10:05:00Z", caregiverRecordId: "c2", caregiverCode: "CG-2", caregiverName: "Synthetic Two", eligible: true, blockers: [], preselected: true },
  { requestId: "r3", orderPosition: 3, requestedAt: "2026-11-23T10:09:00Z", caregiverRecordId: "c3", caregiverCode: "CG-3", caregiverName: "Synthetic Three", eligible: true, blockers: [], preselected: false },
];
const handlers = {
  "GET /v1/coverage-queue": () => json(200, { items: [item] }),
  [`GET /v1/coverage-queue/${SHIFT}/requests`]: () => json(200, { requests: reqs }),
  "POST /v1/coverage-requests/r2/confirm": () => json(200, { coverageState: "covered" }),
  "POST /v1/coverage-requests/r3/confirm": () => json(200, { coverageState: "covered" }),
};

describe("Coverage queue", () => {
  it("shows city, time, urgency, posting state, requests and a delivery summary with why it needs attention; an overnight shift shows both dates", async () => {
    renderAws("/schedule/coverage", ["shifts.manage"], handlers);
    const row = await screen.findByTestId("queue-item");
    expect(row).toHaveTextContent("Winchester");
    expect(row).toHaveTextContent("Urgent");
    expect(row).toHaveTextContent("On the board");
    expect(row).toHaveTextContent("round 2");
    expect(row).toHaveTextContent("CG-A1 called out");
    expect(within(row).getByTestId("delivery")).toHaveTextContent("2 requests · 2 delivered, 1 sent, 1 outcome unknown, 1 not sent (monthly text limit reached)");
    expect(row).toHaveTextContent("Still unfilled close to the start time.");
    expect(row.textContent).toMatch(/12\/01.*12\/02/); // crosses midnight in the agency's zone
  });

  it("lists requests in order, pre-selects the earliest eligible, approves it without a reason, and needs a reason to choose a later one", async () => {
    const api = renderAws("/schedule/coverage", ["shifts.manage"], handlers);
    fireEvent.click(await screen.findByRole("button", { name: "Review requests" }));
    const list = await screen.findByTestId("request-list");
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Cannot be approved now: Over the daily hour limit.");
    expect(within(rows[0]!).getByRole("button", { name: "Confirm assignment" })).toBeDisabled();
    expect(rows[1]).toHaveTextContent("earliest eligible");
    // choosing #3 asks for a reason first and sends it
    fireEvent.click(within(rows[2]!).getByRole("button", { name: "Confirm assignment" }));
    const confirmWith = within(rows[2]!).getByRole("button", { name: "Confirm with this reason" });
    expect(confirmWith).toBeDisabled();
    fireEvent.change(within(rows[2]!).getByLabelText(/Why choose this caregiver/), { target: { value: "Synthetic: closest" } });
    fireEvent.click(confirmWith);
    expect(await screen.findByText(/Synthetic Three is assigned/)).toBeInTheDocument();
    const post = api.calls.find((c) => c.path === "/v1/coverage-requests/r3/confirm")!;
    expect(post.body).toEqual({ organizationId: expect.any(String), skipReason: "Synthetic: closest" });
    expect(post.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("approving the pre-selected request sends no skip reason", async () => {
    const api = renderAws("/schedule/coverage", ["shifts.manage"], handlers);
    fireEvent.click(await screen.findByRole("button", { name: "Review requests" }));
    const rows = within(await screen.findByTestId("request-list")).getAllByRole("listitem");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Confirm assignment" }));
    expect(await screen.findByText(/Synthetic Two is assigned/)).toBeInTheDocument();
    expect((api.calls.find((c) => c.path === "/v1/coverage-requests/r2/confirm")!.body as any).skipReason).toBeUndefined();
  });

  it("a person without shifts.manage gets no queue", async () => {
    renderAws("/schedule/coverage", ["visits.read"], handlers);
    expect(await screen.findByText(/do not have access to the coverage queue/)).toBeInTheDocument();
  });
});

describe("report, alerts and posting from the schedule", () => {
  it("shows the 30-day report with quota, and offers Send again only for failed or unknown notices (unknown needs a confirmation)", async () => {
    const api = renderAws("/schedule/coverage", ["shifts.manage"], {
      ...handlers,
      "GET /v1/open-shift-report": () => json(200, { report: { openings: { currentlyNeedCoverage: 3, currentlyPosted: 2, roundsOpened: 5, filled: 4, clientCancelled: 1, expiredUnfilled: 0, escalations: 1, urgentUnfilledNow: 1 },
        texts: { accepted: 6, delivered: 3, failed: 1, unknown: 1 }, textsByPurpose: {}, quota: { period: "2026-11-01", used: 9, limit: 100, blocked: 0, segments: 11, failed: 1, inbound: 0, estimatedCostMicros: 0 } } }),
      "GET /v1/coverage-alerts": () => json(200, { alerts: [
        { kind: "notification_problem", occurredAt: "2026-11-23T10:00:00Z", shiftId: SHIFT, startsAt: "2026-12-01T17:30:00Z", endsAt: "2026-12-01T19:00:00Z", serviceCity: "Winchester", detail: null, jobId: "j1", jobPurpose: "office_callout", jobStatus: "failed", jobReason: "bad_number" },
        { kind: "call_out", occurredAt: "2026-11-23T09:00:00Z", shiftId: SHIFT, startsAt: "2026-12-01T17:30:00Z", endsAt: "2026-12-01T19:00:00Z", serviceCity: "Winchester", detail: "sick", jobId: null, jobPurpose: null, jobStatus: null, jobReason: null }] }),
      "POST /v1/notification-jobs/j1/requeue": () => json(200, { notificationState: "queued" }),
    });
    const rep = await screen.findByTestId("open-shift-report");
    expect(rep).toHaveTextContent("Texts sent9");
    expect(rep).toHaveTextContent("Texts failed2");
    expect(within(rep).getByTestId("quota")).toHaveTextContent("9 of 100");
    const alerts = await screen.findByTestId("coverage-alerts");
    expect(alerts).toHaveTextContent("Caregiver called out");
    expect(within(alerts).getAllByRole("button", { name: "Send again" })).toHaveLength(1);
    fireEvent.click(within(alerts).getByRole("button", { name: "Send again" }));
    await screen.findByTestId("coverage-alerts");
    expect(api.calls.find((c) => c.path === "/v1/notification-jobs/j1/requeue")!.body).toEqual({ organizationId: expect.any(String), confirmedNotReceived: false });
  });
});

describe("Open shifts settings", () => {
  it("says texting is waiting for a verified sender, shows usage, and keeps the board independent of texting", async () => {
    renderAws("/settings/open-shifts", ["organization.update"], {
      "GET /v1/open-shift-settings": () => json(200, { settings: { openShiftsEnabled: true, smsEnabled: false, smsEntitled: true, senderStatus: "unverified", smsAvailable: false, smsDisplayName: null, monthlySendLimit: 100,
        alertWindowDays: 14, quietStart: "21:00", quietEnd: "07:00", urgentHours: 48, escalationHours: 24, officeOpen: "08:00", officeClose: "18:00", usage: { period: "2026-11-01", sent: 3, segments: 4, blocked: 1, failed: 0 } } }),
      "GET /v1/office-contacts": () => json(200, { contacts: [{ contactId: "k1", label: "Front desk", phoneMasked: "***0001", email: null, notifySms: true, notifyEmail: false, isOnCall: true, active: true }] }),
      "GET /v1/caregivers": () => json(200, { caregivers: [] }),
    });
    expect(await screen.findByTestId("sms-status")).toHaveTextContent("waiting for the sender number to be verified");
    expect(screen.getByTestId("sms-status")).toHaveTextContent("board and office approval work without it");
    expect(screen.getByTestId("sms-usage")).toHaveTextContent("3 of 100 texts used, 1 blocked");
    expect(await screen.findByTestId("contact-list")).toHaveTextContent("Front desk · ***0001 · on-call");
  });
});
