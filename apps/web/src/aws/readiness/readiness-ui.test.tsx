// The caregiver-readiness screens, through the real app shell, routes and API client, against a stateful fake of the
// API. SYNTHETIC data only. The server owns every decision; these tests check what people see and what is sent.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "../aws-root";
import { CG, CLIENT, REQ, SVC, fakeApi, okChecks, type Call, type FakeOptions } from "./fake-api";

// The first lookup of a test waits for the whole app to render for the first time (module load + first paint). On a normal machine that
// takes about 0.5 s, close to Testing Library's 1 s default; on a small or busy shell (such as the production deploy shell) it can exceed
// it, which fails with "Unable to find ..." although the screen is correct. Only the cold first lookup and the test as a whole get more
// time; every assertion is unchanged.
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
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}>
          <AwsRoutes api={client} publicApi={client} />
        </CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { ...api, view };
}
beforeEach(() => window.localStorage.clear());
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const posts = (calls: Call[], path: string) => calls.filter((c) => c.method === "POST" && c.path === path);

describe("administrator matching inputs", () => {
  it("separates reported experience from confirmed tags and requires an explicit review", async () => {
    const { calls } = renderAt(`/care-team/${CG}`, { role: "organization_owner" });
    expect(await screen.findByText("ABA experience · Caregiver-reported", {}, { timeout: COLD_RENDER_MS })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review experience" }));
    expect(screen.getByLabelText("ABA experience")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Save review" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("ABA experience"));
    fireEvent.change(screen.getByLabelText("Review note"), { target: { value: "Owner reviewed prior experience" } });
    fireEvent.click(screen.getByRole("button", { name: "Save review" }));
    expect(await screen.findByText("Experience review saved.")).toBeInTheDocument();
    expect(posts(calls, `/v1/caregivers/${CG}/experience/review`)[0]?.body).toMatchObject({ confirmedTagIds: [SVC], note: "Owner reviewed prior experience" });
  }, TEST_TIMEOUT_MS);

  it("loads the saved ZIP but never implies it provides distance", async () => {
    const { calls } = renderAt(`/care-team/${CG}`, { role: "organization_owner" });
    expect(await screen.findByText("ZIP: 92592")).toBeInTheDocument();
    expect(screen.getByText(/Approx\. distance unavailable/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit location" }));
    expect(screen.getByLabelText("ZIP code")).toHaveValue("92592");
    fireEvent.change(screen.getByLabelText("ZIP code"), { target: { value: "12" } });
    expect(screen.getByRole("button", { name: "Save location" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("ZIP code"), { target: { value: "92595" } });
    fireEvent.click(screen.getByRole("button", { name: "Save location" }));
    expect(await screen.findByText("Location saved.")).toBeInTheDocument();
    expect(posts(calls, `/v1/caregivers/${CG}/zip`)[0]?.body.zip).toBe("92595");
  });

  it("records optional client preferences separately from mandatory requirements", async () => {
    const { calls } = renderAt(`/clients/${CLIENT}`, { role: "organization_owner" });
    fireEvent.click(await screen.findByRole("button", { name: "Edit preferences" }));
    fireEvent.change(screen.getByLabelText("ABA experience"), { target: { value: "optional" } });
    fireEvent.change(screen.getByLabelText("Reason for preferences"), { target: { value: "Family preference only" } });
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    expect(await screen.findByText(/Preferences saved/)).toBeInTheDocument();
    expect(posts(calls, `/v1/clients/${CLIENT}/experience-requirements`)[0]?.body).toMatchObject({ requirements: [{ tagId: SVC, mandatory: false }], reason: "Family preference only" });
  });
});

describe("caregiver: Availability", () => {
  it("shows the approved hours with the agency time zone and exceptions, apart from pending changes", async () => {
    renderAt("/availability", { role: "caregiver", availability: { pending: [{ requestId: "r1", kind: "weekly", status: "pending", reason: "New school schedule", effectiveFrom: "2026-10-19", effectiveUntil: null, windows: [] }] } });
    expect(await screen.findByRole("heading", { name: "Approved hours" })).toBeInTheDocument();
    expect(screen.getByText(/agency time \(America\/Los_Angeles\)/)).toBeInTheDocument();
    expect(screen.getByText("8:00 AM – 8:00 PM")).toBeInTheDocument();
    expect(screen.getByText(/10\/20\/2026: Not available/)).toBeInTheDocument();
    const pending = screen.getByRole("heading", { name: "Pending changes" }).closest("section, div")!.parentElement!;
    expect(within(pending).getByText("Pending")).toBeInTheDocument();
    expect(within(pending).getByText(/New school schedule/)).toBeInTheDocument();
  });

  it("says 'Not provided' when no hours have ever been approved or entered", async () => {
    renderAt("/availability", { role: "caregiver", availability: { provided: false, weekly: [], exceptions: [] } });
    expect(await screen.findByText("Not provided")).toBeInTheDocument();
  });

  it("a request needs a reason, sends the version it was written against and one idempotency key, and says the current hours stay in place", async () => {
    const { calls } = renderAt("/availability", { role: "caregiver" });
    fireEvent.click(await screen.findByRole("button", { name: "Request change" }));
    const submit = screen.getByRole("button", { name: "Submit request" });
    expect(submit).toBeDisabled(); // no reason yet
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "School schedule changed" } });
    expect(submit).toBeEnabled();
    // Overnight is accepted on the screen (the server allows an end earlier than the start).
    fireEvent.change(screen.getByLabelText("Monday range 1 from"), { target: { value: "22:00" } });
    fireEvent.change(screen.getByLabelText("Monday range 1 to"), { target: { value: "06:00" } });
    fireEvent.click(submit);
    fireEvent.click(submit); // a second click while sending must not send twice
    await waitFor(() => expect(screen.getByText("Request sent. Your current hours stay in place until approved.")).toBeInTheDocument());
    const sent = posts(calls, "/v1/availability/requests");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ kind: "weekly", baseVersion: 2, reason: "School schedule changed", effectiveFrom: "2026-10-12", effectiveUntil: null });
    expect(sent[0]!.body.windows).toContainEqual({ weekday: 1, start_local: "22:00", end_local: "06:00" });
    expect(sent[0]!.body.windows).toContainEqual({ weekday: 3, start_local: "09:00", end_local: "13:00" }); // the rest of the week is preserved
    expect(sent[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(posts(calls, "/v1/availability/me")).toHaveLength(0);
  });

  it("a temporary change needs an end date; a specific date can be 'not available'", async () => {
    const { calls } = renderAt("/availability", { role: "caregiver" });
    fireEvent.click(await screen.findByRole("button", { name: "Request change" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Cousin visiting" } });
    fireEvent.click(screen.getByLabelText("Temporary change"));
    expect(screen.getByRole("button", { name: "Submit request" })).toBeDisabled(); // no end date yet
    fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "2026-11-02" } });
    expect(screen.getByRole("button", { name: "Submit request" })).toBeEnabled();
    fireEvent.click(screen.getByRole("tab", { name: "Specific date" }));
    fireEvent.click(screen.getByLabelText("Not available that day"));
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    await waitFor(() => expect(posts(calls, "/v1/availability/requests")).toHaveLength(1));
    expect(posts(calls, "/v1/availability/requests")[0]!.body).toMatchObject({ kind: "date", windows: [], effectiveFrom: "2026-10-12", effectiveUntil: null });
  });

  it("a request that changes nothing is explained by the server and the typed reason is kept", async () => {
    renderAt("/availability", { role: "caregiver", failNextRequestWith: { status: 422, code: "validation_failed", message: "These are already your approved hours. Change something before sending the request." } });
    fireEvent.click(await screen.findByRole("button", { name: "Request change" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Same as before" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("These are already your approved hours. Change something before sending the request.");
    expect(screen.getByLabelText("Reason")).toHaveValue("Same as before");
  });

  it("keeps what was typed and shows the server's words when the request fails (a stale form)", async () => {
    renderAt("/availability", { role: "caregiver", failNextRequestWith: { status: 409, code: "conflict", message: "Your availability changed since you opened this form. Reload and try again." } });
    fireEvent.click(await screen.findByRole("button", { name: "Request change" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Keep this text" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your availability changed since you opened this form. Reload and try again.");
    expect(screen.getByLabelText("Reason")).toHaveValue("Keep this text");
  });

  it("a caregiver can withdraw a pending request and has no direct save", async () => {
    const { calls } = renderAt("/availability", { role: "caregiver", availability: { pending: [{ requestId: "r1", kind: "weekly", status: "pending", reason: "x reason", effectiveFrom: "2026-10-19", effectiveUntil: null, windows: [] }] } });
    expect(screen.queryByRole("button", { name: "Save availability" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw request" }));
    await waitFor(() => expect(posts(calls, "/v1/availability/requests/r1/withdraw")).toHaveLength(1));
  });
});

describe("administrator: reviewing availability", () => {
  const pending = [{ requestId: "r1", kind: "weekly", status: "pending", reason: "Second job", effectiveFrom: "2026-10-19", effectiveUntil: null, windows: [{ weekday: 1, start_local: "10:00", end_local: "12:00" }], requestedAt: "2026-10-10T10:00:00Z" }];

  it("shows current versus proposed, the reason, the affected shifts and the fixed sentence; Approve and Decline are actions; a decline needs a note", async () => {
    const { calls } = renderAt("/care-team", { role: "organization_owner", availability: { pending } });
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    const current = await screen.findByRole("region", { name: "Current hours" });
    const proposed = screen.getByRole("region", { name: "Proposed hours" });
    expect(within(current).getByText("8:00 AM – 8:00 PM")).toBeInTheDocument();
    expect(within(proposed).getByText("10:00 AM – 12:00 PM")).toBeInTheDocument();
    expect(screen.getByText(/Reason: Second job/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Affected shifts" })).toHaveTextContent("1 booked shift would fall outside the proposed hours. They stay booked and are flagged for review.");
    expect(screen.getByText("Approving availability does not assign work or change booked shifts.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    const decline = screen.getAllByRole("button", { name: "Decline" }).at(-1)!;
    expect(decline).toBeDisabled(); // a note is required
    fireEvent.change(screen.getByLabelText("Note to the caregiver (required)"), { target: { value: "Hours do not fit the client" } });
    expect(decline).toBeEnabled();
    fireEvent.click(decline);
    await waitFor(() => expect(posts(calls, "/v1/availability/requests/r1/review")).toHaveLength(1));
    expect(posts(calls, "/v1/availability/requests/r1/review")[0]!.body).toMatchObject({ decision: "decline", note: "Hours do not fit the client" });
  });

  it("a manager can read the request but has no Approve or Decline", async () => {
    renderAt("/care-team", { role: "manager", availability: { pending } });
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    expect(await screen.findByText("Only an administrator can approve or decline.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("an administrator approves with one click and the call is idempotent", async () => {
    const { calls } = renderAt("/care-team", { role: "organization_owner", availability: { pending } });
    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    const approve = await screen.findByRole("button", { name: "Approve" });
    fireEvent.click(approve);
    await waitFor(() => expect(posts(calls, "/v1/availability/requests/r1/review")).toHaveLength(1));
    expect(posts(calls, "/v1/availability/requests/r1/review")[0]!).toMatchObject({ body: { decision: "approve" } });
    expect(posts(calls, "/v1/availability/requests/r1/review")[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("the caregiver record shows approved and pending hours separately, and an administrator edit needs a reason", async () => {
    const { calls } = renderAt(`/care-team/${CG}`, { role: "organization_owner", availability: { pending } });
    fireEvent.click(await screen.findByRole("button", { name: "Edit availability" }));
    const form = await screen.findByRole("form", { name: "Edit availability" });
    expect(screen.getByRole("heading", { name: "Approved" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pending" })).toBeInTheDocument();
    const save = within(form).getByRole("button", { name: "Save change" });
    expect(save).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "Agreed by phone" } });
    fireEvent.click(save);
    await waitFor(() => expect(posts(calls, `/v1/caregivers/${CG}/availability`)).toHaveLength(1));
    expect(await screen.findByText(/Availability saved\. 1 future shift now falls outside the approved hours and is flagged for review\./)).toBeInTheDocument();
  });
});

describe("Approved services and Documents", () => {
  const approvals = [
    { approvalId: "a1", caregiverRecordId: CG, caregiverCode: "CG-0001", caregiverName: "Synthetic Alpha", serviceId: SVC, serviceCode: "PCS", serviceName: "Personal care", state: "approved", effectiveFrom: "2026-09-01", effectiveUntil: null, approvalReason: "Observed", approvedByName: "OWNER", revokedEffectiveOn: null, revocationReason: null },
    { approvalId: "a2", caregiverRecordId: CG, caregiverCode: "CG-0001", caregiverName: "Synthetic Alpha", serviceId: "s2", serviceCode: "RSP", serviceName: "Respite", state: "revoked", effectiveFrom: "2026-01-01", effectiveUntil: null, approvalReason: "Observed", approvedByName: "OWNER", revokedEffectiveOn: "2026-09-15", revocationReason: "Competency concern" },
  ];

  it("a caregiver sees their own approvals and documents, and cannot approve", async () => {
    renderAt("/profile", { role: "caregiver", approvals });
    expect(await screen.findByRole("heading", { name: "Approved services" })).toBeInTheDocument();
    expect(await screen.findByText("Personal care")).toBeInTheDocument();
    expect(screen.getByText("Revoked")).toBeInTheDocument();
    expect(screen.getByText(/Visits before that date keep their approval/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve a service" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
    expect(await screen.findByText("Needs review")).toBeInTheDocument(); // TB uploaded, not verified
    expect(screen.getByText("Current")).toBeInTheDocument(); // CPR
  });

  it("only an administrator approves or revokes; a revocation needs a reason and reports what was flagged", async () => {
    const { calls } = renderAt(`/care-team/${CG}`, { role: "organization_owner", approvals });
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    const form = await screen.findByRole("form", { name: "Revoke approval" });
    expect(within(form).getByRole("button", { name: "Revoke approval" })).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Reason for revoking"), { target: { value: "Competency concern" } });
    fireEvent.click(within(form).getByRole("button", { name: "Revoke approval" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/v1/caregiver-services/a1/revoke")).toHaveLength(1));
  });

  it("a manager sees approvals but cannot approve or revoke", async () => {
    renderAt(`/care-team/${CG}`, { role: "manager", approvals });
    expect(await screen.findByText("Personal care")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve a service" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });
});

describe("Review services (the move to approved services)", () => {
  const pairs = [
    { caregiverRecordId: CG, caregiverCode: "CG-0001", caregiverName: "Synthetic Alpha", serviceId: SVC, serviceCode: "PCS", serviceName: "Personal care", activeAssignments: 1, futureShifts: 2, pastVisits: 9, lastVisitOn: "2026-10-01", approvalState: "not_approved" },
    { caregiverRecordId: "cg2", caregiverCode: "CG-0002", caregiverName: "Synthetic Beta", serviceId: SVC, serviceCode: "PCS", serviceName: "Personal care", activeAssignments: 0, futureShifts: 1, pastVisits: 0, lastVisitOn: null, approvalState: "not_approved" },
  ];

  it("lists pairs with nothing selected, says being listed is not an approval, and approves exactly the ticked pairs after a count confirmation", async () => {
    const { calls } = renderAt("/care-team/services-review", { role: "organization_owner", reviewPairs: pairs });
    expect(await screen.findByText(/Being on this list is not an approval/)).toBeInTheDocument();
    const boxes = await screen.findAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes.every((b) => !(b as HTMLInputElement).checked)).toBe(true);
    expect(screen.queryByText(/Approve \d+ selected/)).toBeNull();
    fireEvent.click(screen.getByLabelText("Select Synthetic Alpha for Personal care"));
    expect(screen.getByText("Approve 1 selected")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Reviewed against training records" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByRole("alert")).toHaveTextContent("You are approving exactly 1 caregiver and service pair. Nothing else is approved.");
    expect(posts(calls, "/v1/caregiver-services/bulk-approve")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Confirm 1" }));
    await waitFor(() => expect(posts(calls, "/v1/caregiver-services/bulk-approve")).toHaveLength(1));
    expect(posts(calls, "/v1/caregiver-services/bulk-approve")[0]!.body).toMatchObject({ expectedCount: 1, pairs: [{ caregiverRecordId: CG, serviceId: SVC }] });
  });

  it("a manager can review the list but cannot select", async () => {
    renderAt("/care-team/services-review", { role: "manager", reviewPairs: pairs });
    expect(await screen.findByText("Synthetic Alpha (CG-0001) · Personal care")).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });
});

describe("Service checks and readiness on the Care Team page", () => {
  it("when Off it says so in the required words and offers 'Review services'; setup gaps are named", async () => {
    renderAt("/care-team", { role: "manager" });
    const card = await screen.findByRole("region", { name: "Service checks" }).catch(() => null);
    expect(card).not.toBeNull();
    expect(screen.getAllByText("Service checks: Off")).toHaveLength(1); // said once, not repeated
    expect(screen.getByText("Caregivers can be assigned without service approval.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Review services" })).toHaveAttribute("href", "/care-team/services-review");
    expect(screen.getByText(/CPR: document type not chosen \(setup incomplete\)/)).toBeInTheDocument();
    expect(screen.getByText(/TB: validity rule not set \(setup incomplete\)/)).toBeInTheDocument();
    expect(screen.getByText("Report-only. Readiness checks are NOT active.")).toBeInTheDocument();
    expect(screen.getByText(/Current verified CPR and TB are not being required yet\./)).toBeInTheDocument();
    // A manager cannot change settings.
    expect(screen.queryByRole("button", { name: /Activate readiness checks|Turn Service checks/ })).toBeNull();
  });

  it("only the administrator can activate; activation is blocked until setup is complete and needs a reason", async () => {
    const { calls } = renderAt("/care-team", { role: "organization_owner", readiness: { setupComplete: true, setupGaps: [] } });
    const activate = await screen.findByRole("button", { name: "Activate readiness checks" });
    expect(activate).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason (required for any change)"), { target: { value: "Reviewed the report" } });
    expect(activate).toBeEnabled();
    fireEvent.click(activate);
    await waitFor(() => expect(posts(calls, "/v1/readiness/activate")).toHaveLength(1));
    expect(posts(calls, "/v1/readiness/activate")[0]!.body).toMatchObject({ expectedAffectedShifts: 3, reason: "Reviewed the report" });
    expect(await screen.findByText("Readiness checks are active")).toBeInTheDocument();
  });

  it("with setup incomplete, activation stays disabled and says why", async () => {
    renderAt("/care-team", { role: "organization_owner" });
    fireEvent.change(await screen.findByLabelText("Reason (required for any change)"), { target: { value: "Reviewed the report" } });
    expect(screen.getByRole("button", { name: "Activate readiness checks" })).toBeDisabled();
    expect(screen.getByText("Finish the required documents setup before activating.")).toBeInTheDocument();
  });

  it("Service checks can be turned On or Off only after activation, with a reason, and the label changes", async () => {
    const { calls } = renderAt("/care-team", { role: "organization_owner", readiness: { enforcementActive: true, setupComplete: true, setupGaps: [] } });
    const turnOn = await screen.findByRole("button", { name: "Turn Service checks On" });
    expect(turnOn).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason (required for any change)"), { target: { value: "Approvals reviewed" } });
    fireEvent.click(turnOn);
    await waitFor(() => expect(posts(calls, "/v1/readiness/service-checks")).toHaveLength(1));
    expect(await screen.findByText("Service checks: On")).toBeInTheDocument();
    expect(screen.queryByText("Caregivers can be assigned without service approval.")).toBeNull();
  });
});

describe("Readiness table: issue, affected count, status, next action", () => {
  const rowOf = (issue: RegExp) => within(screen.getByRole("table", { name: /Readiness by issue/ })).getByRole("row", { name: issue });

  it("report-only: every issue says how many are affected, that it is Report only (not blocking), and the next step", async () => {
    renderAt("/care-team", { role: "manager" });
    await screen.findByRole("table", { name: /Readiness by issue/ });
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(expect.arrayContaining(["Issue", "Affected", "Status", "Next action"]));
    const docs = rowOf(/CPR or TB missing or expired/);
    expect(within(docs).getByText("3 of 4 caregivers")).toBeInTheDocument();
    expect(within(docs).getByText("Report only")).toBeInTheDocument();
    expect(within(docs).getByRole("link", { name: "Review documents" })).toHaveAttribute("href", "/documents");
    expect(within(rowOf(/Availability not provided/)).getByText("2 caregivers")).toBeInTheDocument();
    expect(within(rowOf(/Service approvals to review/)).getByText("5 caregiver and service pairs")).toBeInTheDocument();
    expect(within(rowOf(/Service approvals to review/)).getByText("Off")).toBeInTheDocument();
    const shifts = rowOf(/Booked shifts/);
    expect(within(shifts).getByText("3 of 6 future shifts")).toBeInTheDocument();
    expect(within(shifts).getByText("Would block if activated")).toBeInTheDocument();
    expect(within(shifts).getByRole("link", { name: "Open schedule" })).toHaveAttribute("href", "/schedule");
  });

  it("an inactive check is never described as blocking: no Active status and no blocked wording while report-only", async () => {
    renderAt("/care-team", { role: "manager" });
    const table = await screen.findByRole("table", { name: /Readiness by issue/ });
    expect(within(table).queryByText("Active")).toBeNull();
    expect(within(table).queryByText(/blocked|cannot be (newly )?assigned/i)).toBeNull();
    expect(screen.getByText("Nothing is blocked yet. Caregivers can still be assigned and can still start visits.")).toBeInTheDocument();
  });

  it("setup incomplete is separate from missing documents and is named in its own row", async () => {
    renderAt("/care-team", { role: "manager" });
    await screen.findByRole("table", { name: /Readiness by issue/ });
    const setup = rowOf(/Document setup/);
    expect(within(setup).getByText("Setup incomplete")).toBeInTheDocument();
    expect(within(setup).getByText("2 rules")).toBeInTheDocument();
    expect(within(setup).getByText("Ask an administrator")).toBeInTheDocument(); // a manager cannot set it up
  });

  it("active: the same rows say Active / Needs attention and the banner says the checks are active", async () => {
    renderAt("/care-team", { role: "organization_owner", readiness: { enforcementActive: true, setupComplete: true, setupGaps: [] } });
    const table = await screen.findByRole("table", { name: /Readiness by issue/ });
    expect(screen.getByText("Readiness checks are active")).toBeInTheDocument();
    expect(within(rowOf(/CPR or TB missing or expired/)).getByText("Active")).toBeInTheDocument();
    expect(within(rowOf(/Booked shifts/)).getByText("Needs attention")).toBeInTheDocument();
    expect(within(table).queryByText("Report only")).toBeNull();
    expect(within(rowOf(/Document setup/)).getByText("Set")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing is blocked yet/)).toBeNull();
  });

  it("long explanations are behind Details, and the plain status words stay visible", async () => {
    renderAt("/care-team", { role: "manager" });
    await screen.findByRole("table", { name: /Readiness by issue/ });
    const docs = rowOf(/CPR or TB missing or expired/);
    const details = docs.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(within(details as HTMLElement).getByText(/Current verified CPR and TB are not being required yet\./)).toBeInTheDocument();
  });
});

describe("Assignment checks on the schedule", () => {
  async function chooseAll() {
    fireEvent.click(await screen.findByRole("button", { name: /Add shift|Schedule a shift|New shift/ }));
    await screen.findByRole("option", { name: /C-104/ }); // the client list has loaded, so choosing it really sets the client
    fireEvent.change(await screen.findByLabelText("Client"), { target: { value: "cccccccc-0000-4000-8000-000000000001" } });
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: SVC } });
    fireEvent.change(screen.getByLabelText(/Caregiver/), { target: { value: CG } });
  }

  it("shows Availability / Approved services / Documents / Conflicts separately, with the exact failure words, and blocks Schedule shift", async () => {
    const checks = okChecks().map((c) => (c.check === "availability" ? { ...c, status: "blocked", code: "availability_outside", message: "Outside approved hours.", blocking: true }
      : c.check === "cpr" ? { ...c, status: "blocked", code: "expired", message: "CPR expired.", blocking: true }
      : c.check === "tb" ? { ...c, status: "blocked", code: "awaiting_review", message: "TB needs review.", blocking: true } : c));
    renderAt("/schedule", { role: "manager", evaluation: { ready: false, checks } });
    await chooseAll();
    const panel = await screen.findByRole("region", { name: "Assignment checks" });
    expect(within(panel).getByText(/Availability:/).parentElement).toHaveTextContent("Outside approved hours.");
    expect(within(panel).getByText(/Documents:/).parentElement).toHaveTextContent("CPR expired. TB needs review.");
    expect(within(panel).getByText(/Approved services:/).parentElement).toHaveTextContent("OK");
    expect(within(panel).getByText(/Conflicts:/).parentElement).toHaveTextContent("OK");
    expect(within(panel).getByText("Cannot be assigned yet")).toBeInTheDocument();
    expect(within(panel).queryByText("Ready to assign")).toBeNull();
    expect(screen.getByRole("button", { name: "Schedule shift" })).toBeDisabled();
    // A manager has no override.
    expect(within(panel).queryByRole("button", { name: /Override availability/ })).toBeNull();
  });

  it("'Ready to assign' appears only when the required checks pass; a not-yet-required failure is shown as such and does not block", async () => {
    const checks = okChecks().map((c) => (c.check === "service" ? { ...c, status: "blocked", code: "service_not_approved", message: "Not approved for this service.", enforced: false, blocking: false } : c));
    renderAt("/schedule", { role: "manager", evaluation: { ready: true, wouldBlockAfterActivation: true, checks } });
    await chooseAll();
    const panel = await screen.findByRole("region", { name: "Assignment checks" });
    expect(within(panel).getByText("Assignment allowed with unenforced checks. Review the warnings above.")).toBeInTheDocument();
    expect(within(panel).queryByText("Ready to assign")).toBeNull();
    expect(within(panel).getByText(/Approved services:/).parentElement).toHaveTextContent("Not approved for this service.");
    expect(within(panel).getByText(/Not blocking yet\. This will be required after readiness checks are activated and Service checks are On\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Schedule shift" })).toBeEnabled();
  });

  it("report-only with missing CPR says it does NOT meet the CPR/TB requirement and is never 'Ready to assign'", async () => {
    const checks = okChecks().map((c) => (c.check === "cpr" ? { ...c, status: "blocked", code: "missing", message: "CPR missing.", enforced: false, blocking: false } : c));
    renderAt("/schedule", { role: "manager", evaluation: { ready: true, wouldBlockAfterActivation: true, checks } });
    await chooseAll();
    const panel = await screen.findByRole("region", { name: "Assignment checks" });
    expect(within(panel).getByText(/does NOT meet the requirement for current, verified CPR and TB/)).toBeInTheDocument();
    expect(within(panel).queryByText("Ready to assign")).toBeNull();
  });

  it("an administrator can override the availability check only, with a reason", async () => {
    const checks = okChecks().map((c) => (c.check === "availability" ? { ...c, status: "blocked", code: "availability_not_provided", message: "Availability not provided.", blocking: true } : c));
    const { calls } = renderAt("/schedule", { role: "organization_owner", evaluation: { ready: false, checks } });
    await chooseAll();
    fireEvent.click(await screen.findByRole("button", { name: "Override availability…" }));
    const form = await screen.findByRole("group", { name: "Override availability" });
    expect(within(form).getByText(/One-time override of the availability check/)).toBeInTheDocument();
    expect(within(form).getByText(/this one shift/)).toBeInTheDocument();
    expect(within(form).getByText(/does not change the caregiver's recorded availability/)).toBeInTheDocument();
    const go = within(form).getByRole("button", { name: "Override availability" });
    expect(go).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Reason for the override"), { target: { value: "Caregiver agreed by phone" } });
    fireEvent.click(go);
    await waitFor(() => expect(posts(calls, "/v1/availability/overrides")).toHaveLength(1));
    expect(posts(calls, "/v1/availability/overrides")[0]!.body).toMatchObject({ caregiverRecordId: CG, clientId: expect.any(String), reason: "Caregiver agreed by phone", rangeStart: "2026-10-14T16:00:00+00:00" });
    expect(await screen.findByText("Ready to assign")).toBeInTheDocument();
    expect(screen.getByText(/Availability overridden by an administrator\./)).toBeInTheDocument();
  });

  it("without a client there is no override button (an override is for one client)", async () => {
    const checks = okChecks().map((c) => (c.check === "availability" ? { ...c, status: "blocked", code: "availability_not_provided", message: "Availability not provided.", blocking: true } : c));
    renderAt("/schedule", { role: "organization_owner", evaluation: { ready: false, checks } });
    // The schedule form only evaluates once a client is chosen, so no checks panel (and no override) exists before that.
    expect(screen.queryByRole("button", { name: "Override availability…" })).toBeNull();
  });

  it("a shift assigned under an Admin override says so, with the reason", async () => {
    renderAt("/schedule", { role: "manager", shiftOverride: true });
    expect(await screen.findByText(/Assigned with Admin override \(availability was No Match\): Caregiver agreed by phone/)).toBeInTheDocument();
  });
});

describe("Matches on care requests", () => {
  it("lists eligible caregivers with Send offer, shows 'Score incomplete', explains the components, and keeps blocked caregivers out of reach", async () => {
    const { calls } = renderAt("/care-requests", { role: "manager" });
    fireEvent.click((await screen.findAllByRole("button", { name: /Select|Open|View|Candidates|Match/ }))[0]!);
    const sendOffer = await screen.findByRole("button", { name: "Send offer" });
    expect(screen.getByText(/Already assigned to this client/)).toBeInTheDocument();
    expect(screen.getAllByText(/Score incomplete/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Will be required after readiness checks are activated: CPR missing\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Why" }));
    expect(screen.getAllByText((_, el) => el?.tagName === "LI" && /Location missing: Distance data is not loaded\./.test(el.textContent ?? "")).length).toBeGreaterThan(0);
    expect(screen.getAllByText((_, el) => el?.tagName === "LI" && /Experience not counted: The client has no experience wishes recorded\./.test(el.textContent ?? "")).length).toBeGreaterThan(0);
    expect(screen.getByText(/The score only orders caregivers who are already eligible/)).toBeInTheDocument();
    // Blocked caregiver: listed under 'Not available' with the reason and no Send offer button.
    const details = screen.getByText(/Not available \(1\)/).closest("details")!;
    expect(within(details).getByText(/Availability not provided\./)).toBeInTheDocument();
    expect(within(details).queryByRole("button", { name: "Send offer" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Send offer" })).toHaveLength(1);
    // Excluded only because approved availability is missing: an administrator may still offer manually; the gate decides at assignment.
    expect(within(details).getByText(/Excluded from Matches, but an administrator may still offer this work\./)).toBeInTheDocument();
    expect(within(details).getByRole("button", { name: "Offer manually" })).toBeInTheDocument();
    fireEvent.click(sendOffer);
    await waitFor(() => expect(posts(calls, `/v1/care-requests/${REQ}/offers`)).toHaveLength(1));
    expect(posts(calls, `/v1/care-requests/${REQ}/offers`)[0]!.body).toMatchObject({ caregiverRecordId: CG });
  });
});

describe("review follow-ups: report-only wording and My experience", () => {
  it("caregiver profile: My experience reports tags as a note until the agency confirms; no location data is read", async () => {
    const { calls } = renderAt("/profile", { role: "caregiver" });
    const card = await screen.findByRole("region", { name: "My experience" });
    expect(within(card).getByText(/An administrator confirms it; until then it is only a note\./)).toBeInTheDocument();
    fireEvent.click(await within(card).findByRole("checkbox", { name: /ABA experience/ }));
    fireEvent.click(within(card).getByRole("button", { name: "Save my experience" }));
    await waitFor(() => expect(posts(calls, "/v1/experience/me")).toHaveLength(1));
    expect(posts(calls, "/v1/experience/me")[0]!.body.tagIds).toEqual([SVC]);
    expect(calls.some((c) => c.path.endsWith("/zip"))).toBe(false);
  });
});

describe("My experience cannot erase what was reported earlier", () => {
  const existing = [{ tagId: SVC, label: "ABA experience", status: "reported" }];
  const save = () => screen.getByRole("button", { name: /Save my experience|Saving/ });

  it("existing experience fails to load: the form is disabled, an empty submission sends nothing, and after a retry the earlier answers are kept", async () => {
    const { calls } = renderAt("/profile", { role: "caregiver", myExperience: existing, failFirst: { "GET /v1/experience/me": 1 } });
    const card = await screen.findByRole("region", { name: "My experience" });
    expect(await within(card).findByRole("alert")).toHaveTextContent(/Nothing can be saved until it loads/);
    expect(save()).toBeDisabled();
    expect(within(card).getByRole("checkbox", { name: /ABA experience/ })).toBeDisabled();
    fireEvent.submit(within(card).getByRole("form", { name: "Report my experience" })); // even a forced submit is ignored
    expect(posts(calls, "/v1/experience/me")).toHaveLength(0);
    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(save()).toBeEnabled());
    expect(within(card).getByRole("checkbox", { name: /ABA experience/ })).toBeChecked(); // the existing report is there
    fireEvent.click(save());
    await waitFor(() => expect(posts(calls, "/v1/experience/me")).toHaveLength(1));
    expect(posts(calls, "/v1/experience/me")[0]!.body.tagIds).toEqual([SVC]); // not []
  });

  it("the agency's tags fail to load: nothing can be saved until a retry works", async () => {
    const { calls } = renderAt("/profile", { role: "caregiver", myExperience: existing, failFirst: { "GET /v1/experience-tags": 1 } });
    const card = await screen.findByRole("region", { name: "My experience" });
    expect(await within(card).findByRole("alert")).toHaveTextContent(/Nothing can be saved until it loads/);
    expect(within(card).queryByRole("button", { name: "Save my experience" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(save()).toBeEnabled());
    expect(posts(calls, "/v1/experience/me")).toHaveLength(0);
  });

  it("slow loading: submission stays disabled while either request is pending, then becomes available with the existing answers", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const { calls } = renderAt("/profile", { role: "caregiver", myExperience: existing, hold: { "GET /v1/experience/me": hold } });
    const card = await screen.findByRole("region", { name: "My experience" });
    const form = await within(card).findByRole("form", { name: "Report my experience" }); // tags have arrived, experience has not
    expect(within(card).getByRole("status")).toHaveTextContent("Loading…");
    expect(save()).toBeDisabled();
    fireEvent.submit(form);
    expect(posts(calls, "/v1/experience/me")).toHaveLength(0);
    release();
    await waitFor(() => expect(save()).toBeEnabled());
    expect(within(card).getByRole("checkbox", { name: /ABA experience/ })).toBeChecked();
  });

  it("edits survive a failed save and a retry (nothing is reset by the error)", async () => {
    const { calls } = renderAt("/profile", { role: "caregiver", myExperience: existing, failFirst: { "POST /v1/experience/me": 1 } });
    const card = await screen.findByRole("region", { name: "My experience" });
    await waitFor(() => expect(save()).toBeEnabled());
    const box = within(card).getByRole("checkbox", { name: /ABA experience/ });
    fireEvent.click(box); // the caregiver deliberately removes it
    expect(box).not.toBeChecked();
    fireEvent.click(save());
    expect(await within(card).findByRole("alert")).toHaveTextContent(/Your changes are kept/);
    expect(within(card).getByRole("checkbox", { name: /ABA experience/ })).not.toBeChecked(); // still the caregiver's edit
    fireEvent.click(save());
    await waitFor(() => expect(posts(calls, "/v1/experience/me")).toHaveLength(2));
    expect(posts(calls, "/v1/experience/me")[1]!.body.tagIds).toEqual([]); // an intentional, loaded-and-edited removal is allowed
    expect(posts(calls, "/v1/experience/me")[0]!.key).not.toBeNull();
  });
});
