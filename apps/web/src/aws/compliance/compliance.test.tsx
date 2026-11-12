// Caregiver compliance screens (0055), through the real app shell, routes and API client, against the stateful fake API.
// OWNER-DEFINED rules, not stated as legal requirements. SYNTHETIC data only. The server owns every decision; these tests check what people see and send.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "../aws-root";
import { actionCategories, actionNeededTotal } from "../action-needed";
import { CG, fakeApi, type Call, type FakeOptions } from "../readiness/fake-api";
import { nextDay } from "./queries";

const COLD_RENDER_MS = 15_000;
const TEST_TIMEOUT_MS = 30_000;

function renderAt(path: string, opts: FakeOptions) {
  const api = fakeApi(opts);
  const auth = {
    subscribe: vi.fn(() => () => {}),
    getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "person@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn(),
  };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: api.fetchImpl as never });
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}>
          <AwsRoutes api={client} publicApi={client} />
        </CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return api;
}
beforeEach(() => window.localStorage.clear());
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const posts = (calls: Call[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

const heldReasons = [
  { requirement: "cpr", code: "missing_after_deadline", message: "CPR missing. The 14-day period ended 2026-10-15.", dueDate: "2026-10-15" },
  { requirement: "tb", code: "missing_after_deadline", message: "TB missing. The 14-day period ended 2026-10-15.", dueDate: "2026-10-15" },
];

describe("Caregiver holds page (the Action needed destination)", () => {
  const hold = {
    holdId: "h1", caregiverRecordId: CG, caregiverCode: "CG-0001", caregiverName: "Synthetic Alpha", openedAt: "2026-10-16T08:00:00Z", automatic: true, reasons: heldReasons,
    affectedShifts: [
      { flagId: "f1", shiftId: "s1", startsAt: "2026-10-20T17:00:00Z", endsAt: "2026-10-20T19:00:00Z", clientCode: "C-104", seriesId: "ser1" },
      { flagId: "f2", shiftId: "s2", startsAt: "2026-10-21T17:00:00Z", endsAt: "2026-10-21T19:00:00Z", clientCode: "C-104", seriesId: null },
    ],
    affectedAssignments: [{ flagId: "f3", assignmentId: "a1", clientCode: "C-104", effectiveStart: "2026-09-01", effectiveEnd: null }],
    inProgressVisits: [{ visitId: "v1", timeIn: "2026-10-17T16:00:00Z", clientCode: "C-104", shiftId: null }],
  };

  it("shows the reason with a fix link, the shifts to cover, the standing assignment, and an urgent alert for a visit in progress that is NOT ended", async () => {
    renderAt("/compliance", { role: "manager", holds: { holds: [hold], totals: { holds: 1, affectedShifts: 2, affectedAssignments: 1, inProgressVisits: 1 } } });
    expect(await screen.findByRole("heading", { name: "Caregiver holds" }, { timeout: COLD_RENDER_MS })).toBeInTheDocument();
    expect(await screen.findByText("1 on hold · 2 shifts to cover · 1 visit in progress")).toBeInTheDocument();
    const article = screen.getByRole("article", { name: "Synthetic Alpha on hold" });
    const urgent = within(article).getAllByRole("alert")[0]!;
    expect(urgent).toHaveTextContent("A visit is in progress. Arrange safe coverage now.");
    expect(urgent).toHaveTextContent("The visit has not been ended and will not be.");
    expect(within(article).getByText(/CPR missing\. The 14-day period ended 2026-10-15\./)).toBeInTheDocument();
    expect(within(article).getByRole("heading", { name: "Shifts to cover (2)" })).toBeInTheDocument();
    expect(within(article).getByText(/recurring/)).toBeInTheDocument();
    expect(within(article).getAllByRole("link", { name: "Open the schedule" })).toHaveLength(2);
    expect(within(article).getByRole("heading", { name: "Standing assignments (1)" })).toBeInTheDocument();
    expect(within(screen.getByTestId("page-help-panel")).getByText(/Nothing here was cancelled, moved or ended/)).toBeInTheDocument();
  }, TEST_TIMEOUT_MS);

  it("lists scheduled shifts whose CPR/TB is expired or expires during the shift even when nobody is on hold, and marks a shift already under way", async () => {
    const risk = (shiftId: string, documentStatus: string, inProgress: boolean) => ({
      caregiverRecordId: CG, caregiverCode: "CG-A1", caregiverName: "Synthetic Alpha", shiftId, startsAt: "2026-10-27T05:00:00Z", endsAt: "2026-10-27T13:00:00Z",
      clientCode: "C-104", requirement: "cpr", documentStatus, validUntil: "2026-10-27", inProgress, visitId: inProgress ? "v9" : null, onHold: false,
    });
    renderAt("/compliance", { role: "manager", holds: { holds: [], totals: { holds: 0, affectedShifts: 0, affectedAssignments: 0, inProgressVisits: 0, shiftsAtRisk: 2, shiftsAtRiskInProgress: 1 }, shiftsAtRisk: [risk("s1", "expires_during", false), risk("s2", "expired", true)] } });
    expect(await screen.findByText("No caregiver is on a compliance hold.", {}, { timeout: COLD_RENDER_MS })).toBeInTheDocument();
    const section = screen.getByRole("region", { name: "Shifts with CPR or TB expiring" });
    expect(within(section).getByRole("heading", { name: "Shifts with CPR or TB expired or expiring (2)" })).toBeInTheDocument();
    expect(within(section).getByText(/CPR expires during this shift/)).toBeInTheDocument();
    expect(within(section).getByText(/CPR is expired for this shift/)).toBeInTheDocument();
    expect(within(section).getByText(/In progress \(visit open\)/)).toBeInTheDocument();
    expect(within(screen.getByTestId("page-help-panel")).getByText(/a visit in progress is never ended by the system/)).toBeInTheDocument();
  }, TEST_TIMEOUT_MS);

  it("shifts at risk are grouped by caregiver and reason: one row with a count, the shifts open under it, every link is kept", async () => {
    const risk = (shiftId: string, day: string) => ({
      caregiverRecordId: CG, caregiverCode: "CG-A1", caregiverName: "Synthetic Alpha", shiftId, startsAt: `2026-11-${day}T20:00:00Z`, endsAt: `2026-11-${day}T22:00:00Z`,
      clientCode: "C-104", requirement: "cpr", documentStatus: "expired", validUntil: "2026-11-07", inProgress: false, visitId: null, onHold: false,
    });
    renderAt("/compliance", { role: "manager", holds: { holds: [], totals: { holds: 0, affectedShifts: 0, affectedAssignments: 0, inProgressVisits: 0, shiftsAtRisk: 3, shiftsAtRiskInProgress: 0 }, shiftsAtRisk: [risk("s1", "09"), risk("s2", "11"), risk("s3", "13")] } });
    const section = await screen.findByRole("region", { name: "Shifts with CPR or TB expiring" }, { timeout: COLD_RENDER_MS });
    expect(within(section).getByRole("heading", { name: "Shifts with CPR or TB expired or expiring (3)" })).toBeInTheDocument();
    expect(within(section).getAllByText(/CPR is expired for this shift/)).toHaveLength(1); // one row, not three
    expect(within(section).getByText("3 shifts")).toBeInTheDocument();
    expect(within(section).getAllByRole("link", { name: "Open the schedule" })).toHaveLength(3); // the shifts are listed under the row
  }, TEST_TIMEOUT_MS);

  it("with no holds it says so; 'Check now' asks the server to re-evaluate and reports the counts", async () => {
    const { calls } = renderAt("/compliance", { role: "manager" });
    expect(await screen.findByText("No caregiver is on a compliance hold.", {}, { timeout: COLD_RENDER_MS })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText("Checked 4 caregivers. 1 new, 0 lifted.")).toBeInTheDocument();
    expect(posts(calls, "/v1/compliance/sweep")).toHaveLength(1);
    expect(posts(calls, "/v1/compliance/sweep")[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
  }, TEST_TIMEOUT_MS);

  it("a caregiver is told they have no access and nothing is requested", async () => {
    const { calls } = renderAt("/compliance", { role: "caregiver" });
    expect(await screen.findByText("You do not have access to compliance holds.", {}, { timeout: COLD_RENDER_MS })).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/v1/compliance/holds")).toBe(false);
  }, TEST_TIMEOUT_MS);
});

describe("Action needed", () => {
  const base = { missingTimeOut: 0, notConfirmed: 0, needsReview: 0, billingReadyUnapproved: null, total: 0 };

  it("lists Caregiver Holds with shifts to cover plus visits in progress, linking to the holds page", () => {
    const cats = actionCategories({ ...base, complianceHolds: { holds: 2, affectedShifts: 5, inProgressVisits: 1 } });
    const c = cats.find((x) => x.key === "caregiverHolds")!;
    expect(c).toMatchObject({ label: "Caregiver Holds", count: 6, to: "/compliance" });
    expect(c.hint).toMatch(/2 caregivers on a compliance hold/);
    expect(c.hint).toMatch(/visit in progress/);
    expect(actionNeededTotal({ ...base, complianceHolds: { holds: 2, affectedShifts: 5, inProgressVisits: 1 } })).toBe(6);
  });

  it("a viewer who may not see compliance gets no category and no false zero; one hold with nothing to cover counts zero", () => {
    expect(actionCategories({ ...base, complianceHolds: null }).some((x) => x.key === "caregiverHolds")).toBe(false);
    expect(actionCategories({ ...base }).some((x) => x.key === "caregiverHolds")).toBe(false);
    expect(actionCategories({ ...base, complianceHolds: { holds: 1, affectedShifts: 0, inProgressVisits: 0 } }).find((x) => x.key === "caregiverHolds")).toMatchObject({ count: 0 });
  });
});

describe("helpers", () => {
  it("nextDay reads the date from the string (month, year and leap-day boundaries)", () => {
    expect(nextDay("2026-10-15")).toBe("2026-10-16");
    expect(nextDay("2026-10-31")).toBe("2026-11-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    expect(nextDay("2028-02-28")).toBe("2028-02-29");
    expect(nextDay("2027-02-28")).toBe("2027-03-01");
    expect(nextDay("not a date")).toBe("not a date");
  });
});
