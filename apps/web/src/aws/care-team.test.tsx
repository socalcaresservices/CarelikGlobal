// Care Team and Services screens (0023) against an in-memory fake of the AWS
// API, through the real API client and routes. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CG = "abababab-0000-4000-8000-000000000001";
const SVC = "dddddddd-0000-4000-8000-000000000001";
type Role = "caregiver" | "manager" | "organization_owner";
type Call = { method: string; path: string; body: Record<string, unknown> | null; headers: Record<string, string> };

function fakeApi(role: Role) {
  const calls: Call[] = [];
  const permissions =
    role === "manager" ? ["authorizations.read", "caregivers.manage", "visits.manage", "visits.read"]
    : role === "organization_owner" ? ["authorizations.read", "caregivers.manage", "caregivers.compliance.manage", "readiness.read", "services.manage", "visits.manage", "visits.read", "organization.update"]
    : ["availability.manage_own", "documents.manage_own"];
  let status = "active";
  let invited: { email: string; at: string; count: number } | null = null;
  let contact: string | null = null;
  let approved = false;
  let extended: string | null = null;
  const canApproveNew = role !== "caregiver" && (globalThis as { __ready?: boolean }).__ready === true;
  const NEW = "abababab-0000-4000-8000-000000000009";
  const item = (requirement: string, label: string, kind: string, state: string, detail: string, extra: Record<string, unknown> = {}) =>
    ({ requirement, label, kind, state, detail, dueDate: null, metOn: null, actorName: null, blocksShifts: false, nextAction: "none", extra, ...extra });
  const readinessFor = (id: string) => {
    if (id === CG) {
      return { caregiverRecordId: CG, caregiverCode: "CG-1A2B3C4D", status: "active", approved: true, approvedAt: "2026-10-01T18:00:00Z", approvedByName: "Olivia Owner", approvalSource: "approval", met: 5, total: 5, waitingOn: [], canApprove: false,
        hireDate: "2026-09-01", graceDays: 30, cprTbDueDate: "2026-10-01", enforcementActive: false,
        items: [item("background", "Background check", "hard", "met", "Verified", { metOn: "2026-10-30", actorName: "ogeviamanager", nextAction: "view" }), item("training", "Required training", "hard", "met", "Done", { metOn: "2026-10-18", nextAction: "reopen", extra: { requirementId: "r1" } }),
          item("signin", "App sign-in", "followup", "met", "Signed in"), item("cpr", "CPR certificate", "flexible", "met", "Verified"), item("tb", "TB clearance", "flexible", "met", "Verified")] };
    }
    const signinDetail = contact || invited ? (invited ? "Invited, has not signed in yet" : "Not invited yet") : "No email on file";
    const signinAction = contact || invited ? (invited ? "resend_link" : "send_link") : "add_contact";
    return { caregiverRecordId: NEW, caregiverCode: "CG-NEW00001", status: approved ? "approved" : "not_ready", approved, approvedAt: approved ? "2026-10-30T18:00:00Z" : null, approvedByName: approved ? "Mia Manager" : null, approvalSource: approved ? "approval" : null,
      met: approved ? 5 : (canApproveNew ? 2 : 1), total: 5, waitingOn: approved || canApproveNew ? [] : ["Required training"], canApprove: !approved && canApproveNew, hireDate: "2026-10-01", graceDays: 30, cprTbDueDate: "2026-10-31", enforcementActive: false,
      items: [item("background", "Background check", "hard", "met", "Verified", { metOn: "2026-10-30", actorName: "ogeviamanager", nextAction: "view" }), item("training", "Required training", "hard", approved || canApproveNew ? "met" : "unmet", approved || canApproveNew ? "Done" : "Not recorded", approved || canApproveNew ? { metOn: "2026-10-18", nextAction: "reopen" } : { nextAction: "record" }),
        { ...item("signin", "App sign-in", "followup", "unmet", signinDetail, { nextAction: signinAction, extra: { lastSentAt: invited?.at ?? null, sendCount: invited?.count ?? null } }) },
        { ...item("cpr", "CPR certificate", "flexible", "pending", "Not uploaded"), dueDate: extended ?? "2026-10-31", nextAction: "upload" }, { ...item("tb", "TB clearance", "flexible", "pending", "Not uploaded"), dueDate: "2026-10-31", nextAction: "upload" }] };
  };
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = (init?.body ? JSON.parse(String(init.body)) : null) as Record<string, unknown> | null;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body, headers: (init?.headers ?? {}) as Record<string, string> });
    switch (`${init?.method ?? "GET"} ${url.pathname}`) {
      case "GET /v1/me":
        return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role, permissions }], profile: { displayName: "Synthetic Person" } });
      case "GET /v1/branding":
        return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "GET /v1/attention":
        return json(200, { summary: null });
      case `GET /v1/caregivers/${CG}/onboarding`:
      case `GET /v1/caregivers/${NEW}/onboarding`:
        return json(200, { onboarding: { caregiverRecordId: CG, status: "active", onboardingRequired: false, done: 0, total: 0, complete: true, items: [] } });
      case "GET /v1/caregivers":
        return json(200, { caregivers: [
          { caregiverRecordId: NEW, caregiverCode: "CG-NEW00001", firstName: "Synthetic", lastName: "Newcomer", preferredName: null, status: approved ? "ready" : "onboarding", workStatus: approved ? "approved" : "not_ready", readinessMet: approved ? 5 : 2, readinessTotal: 5, signedIn: false, hasContact: !!contact || !!invited,
            hasSignIn: !!invited, signInStatus: invited ? "active" : null, activeAssignments: 1, plannedAssignments: invited ? 0 : 1, openVisits: 0, invitationEmail: invited?.email ?? null, invitedAt: invited?.at ?? null, invitationLastSentAt: invited?.at ?? null, invitationSendCount: invited?.count ?? null, firstSignedInAt: null },
          { caregiverRecordId: CG, caregiverCode: "CG-1A2B3C4D", firstName: "Synthetic", lastName: "Caregiver One", preferredName: null, status, workStatus: status === "inactive" ? "inactive" : "active", readinessMet: 5, readinessTotal: 5, signedIn: true, hasContact: true,
            hasSignIn: true, signInStatus: status === "inactive" ? "suspended" : "active", activeAssignments: status === "inactive" ? 0 : 2, openVisits: 0 }] });
      case `GET /v1/caregivers/${NEW}/readiness`:
        return json(200, { readiness: readinessFor(NEW) });
      case `GET /v1/caregivers/${CG}/readiness`:
        return json(200, { readiness: readinessFor(CG) });
      case `POST /v1/caregivers/${NEW}/contact`:
        contact = String(body?.email);
        return json(200, { contact: { hasEmail: true } });
      case `POST /v1/caregivers/${NEW}/signin-link`:
        if (!contact && !invited) return json(409, { error: { code: "conflict", message: "Add an email address first" } });
        invited = invited ? { ...invited, count: invited.count + 1 } : { email: contact!, at: "2026-10-04T20:00:00Z", count: 1 };
        return json(invited.count === 1 ? 200 : 200, { invitation: { sendCount: invited.count } });
      case `POST /v1/caregivers/${NEW}/approve`:
        approved = true;
        return json(200, { readiness: readinessFor(NEW) });
      case `POST /v1/caregivers/${NEW}/cpr-tb/extend`:
        extended = String(body?.newDueDate);
        return json(200, { readiness: readinessFor(NEW) });
      case `POST /v1/caregivers/${NEW}/background-check/verify`:
        return json(200, { compliance: {} });
      case "POST /v1/caregivers":
        return json(201, { caregiver: { caregiverRecordId: "abababab-0000-4000-8000-000000000002", caregiverCode: "CG-99999999" } });
      case `POST /v1/caregivers/${CG}/status`:
        status = String(body?.status);
        return json(200, { result: { endedAssignments: 2, signInStatus: "suspended" } });
      case `POST /v1/caregivers/${NEW}/invitation`:
        invited = { email: String(body?.email), at: "2026-10-04T20:00:00Z", count: 1 };
        return json(201, { invitation: { invitationId: "i1", existingAccount: false } });
      case `POST /v1/caregivers/${NEW}/invitation/resend`:
        invited = { ...invited!, count: invited!.count + 1 };
        return json(200, { invitation: { sendCount: invited.count } });
      case "GET /v1/services":
        return json(200, { services: [{ serviceId: SVC, code: "PCS", name: "Personal care", isActive: true }] });
      case "POST /v1/services":
        return json(201, { serviceId: "s2" });
      case `POST /v1/services/${SVC}/status`:
        return json(409, { error: { code: "conflict", message: "Clients still have current authorizations for this service; let them end or amend them first" } });
      case "GET /v1/assignments":
        return json(200, { assignments: [] });
      default:
        return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  return { calls, fetchImpl };
}

function renderAt(path: string, role: Role) {
  const api = fakeApi(role);
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

afterEach(() => vi.clearAllMocks());

describe("Care Team", () => {
  it("manager lists caregivers with sign-in state and adds one with an idempotency key", async () => {
    const api = renderAt("/care-team", "manager");
    expect(await screen.findByText(/Synthetic Caregiver One/)).toBeInTheDocument();
    expect(screen.getByText(/Sign-in active · 2 active assignments/)).toBeInTheDocument();
    // one status vocabulary: calculated by the server, identical to the detail page
    const newcomerRow = screen.getByText(/Synthetic Newcomer/).closest("tr")!;
    expect(within(newcomerRow).getByText("Not ready")).toBeInTheDocument();
    expect(within(newcomerRow).getByText("2 of 5 done")).toBeInTheDocument();
    expect(within(screen.getByText(/Synthetic Caregiver One/).closest("tr")!).getByText("Active")).toBeInTheDocument();
    expect(screen.queryByText("Pending documents")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add caregiver" }));
    fireEvent.click(screen.getByRole("button", { name: "Add caregiver" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("first and last name");
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Synthetic" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Caregiver Two" } });
    fireEvent.change(screen.getByLabelText("Starting status"), { target: { value: "onboarding" } });
    expect(Array.from((screen.getByLabelText("Starting status") as HTMLSelectElement).options).map((o) => o.value)).toEqual(["applicant", "onboarding"]); // Approved/Active are never chosen here
    fireEvent.click(screen.getByRole("button", { name: "Add caregiver" }));
    expect(await screen.findByText(/Caregiver added/)).toBeInTheDocument();
    const post = api.calls.find((c) => c.method === "POST" && c.path === "/v1/caregivers")!;
    expect(post.body).toMatchObject({ organizationId: ORG, firstName: "Synthetic", lastName: "Caregiver Two", preferredName: null, status: "onboarding" });
    expect(Object.keys(post.headers).map((h) => h.toLowerCase())).toContain("idempotency-key");
  });

  it("the caregiver list has a No. column numbered 1..n in the order shown", async () => {
    renderAt("/care-team", "manager");
    const table = await screen.findByRole("table", { name: "Caregivers" });
    expect(within(table).getAllByRole("columnheader")[0]).toHaveTextContent("No.");
    const numbers = within(table).getAllByTestId("row-no").map((c) => Number(c.textContent));
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  // The TEST line's "caregiver page opens with the overall outcome" test described the page that the readiness release replaces (its
  // caregiver-outcome panel is gone by design); the readiness test below covers the page now.
  it("the caregiver page is one checklist: five requirements and a single Approve for work step that says what it is waiting on", async () => {
    renderAt("/care-team/abababab-0000-4000-8000-000000000009", "manager");
    const list = await screen.findByTestId("readiness-checklist");
    await waitFor(() => expect(list).toHaveTextContent("1 of 5 done"));
    expect(list).toHaveTextContent("Not ready");
    expect(list).toHaveTextContent("Hired");
    expect(list).toHaveTextContent("CPR/TB due");
    const rows = within(list).getByRole("list", { name: "Requirements" }).querySelectorAll("li");
    expect(Array.from(rows).map((r) => r.getAttribute("data-requirement"))).toEqual(["background", "training", "signin", "cpr", "tb", "approve"]);
    expect(within(list).getByText("No email on file")).toBeInTheDocument();
    expect(within(list).getAllByText(/Not uploaded · due/)).toHaveLength(2);
    // Approve is disabled and says why; no form ever opens that then errors
    const approve = within(list).getByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    expect(within(list).getByText("Waiting on: Required training")).toBeInTheDocument();
    expect(approve).toHaveAccessibleDescription("Waiting on: Required training");
    // the sections the brief removed are gone
    for (const gone of ["Compliance", "Onboarding", "Not eligible under the rules", "Compliance clearance", "Change status"]) expect(screen.queryByText(gone)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Status" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Name" })).toHaveLength(1); // the one Name field now lives inside Details
  });

  it("an approved, signed-in caregiver shows Active with every row done and no Approve button", async () => {
    renderAt(`/care-team/${CG}`, "manager");
    const list = await screen.findByTestId("readiness-checklist");
    await waitFor(() => expect(list).toHaveTextContent("Active"));
    expect(list).not.toHaveTextContent("of 5 done");
    expect(within(list).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(within(list).getByText(/Approved .* by Olivia Owner/)).toBeInTheDocument();
    expect(within(list).getByText(/Verified .* by ogeviamanager/)).toBeInTheDocument();
  });

  it("deactivating a caregiver (the one manual status) needs a reason and reports ended assignments and the suspended sign-in", async () => {
    renderAt(`/care-team/${CG}`, "manager");
    expect(await screen.findByRole("heading", { name: "Synthetic Caregiver One" })).toBeInTheDocument();
    const form = await screen.findByRole("form", { name: "Deactivate caregiver" });
    fireEvent.click(within(form).getByRole("button", { name: "Deactivate" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("reason");
    fireEvent.change(within(form).getByLabelText(/Reason/), { target: { value: "Left the agency (synthetic)" } });
    fireEvent.click(within(form).getByRole("button", { name: "Deactivate" }));
    expect(await screen.findByText(/2 assignments ended\. Their sign-in is suspended for this agency\./)).toBeInTheDocument();
  });

  it("caregivers have no Care Team or Services menu and the pages refuse", async () => {
    renderAt("/care-team", "caregiver");
    expect(await screen.findByText("You do not have access to the Care Team.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Care Team" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Services" })).not.toBeInTheDocument();
  });
});

describe("Sign-in link (0086, email through the Cognito invitation)", () => {
  it("with no email on file the row offers Add email first; the link is sent after the email is saved, then it can be resent and shows Last sent", async () => {
    const api = renderAt("/care-team/abababab-0000-4000-8000-000000000009", "manager");
    const list = await screen.findByTestId("readiness-checklist");
    expect(await within(list).findByText("No email on file")).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /sign-in link/ })).not.toBeInTheDocument();
    fireEvent.click(within(list).getByRole("button", { name: "Add email" }));
    fireEvent.click(within(list).getByRole("button", { name: "Save and send sign-in link" }));
    expect(await within(list).findByRole("alert")).toHaveTextContent("own email");
    fireEvent.change(within(list).getByLabelText("Caregiver's own email"), { target: { value: "newcomer@example.test" } });
    fireEvent.click(within(list).getByRole("button", { name: "Save and send sign-in link" }));
    expect(await within(list).findByText("Email saved and sign-in link sent.")).toBeInTheDocument();
    const contactCall = api.calls.find((c) => c.path.endsWith("/contact"))!;
    expect(contactCall.body).toEqual({ organizationId: ORG, email: "newcomer@example.test" });
    expect(api.calls.some((c) => c.path.endsWith("/signin-link"))).toBe(true);
    expect(await within(list).findByText("Invited, has not signed in yet")).toBeInTheDocument();
    expect(await within(list).findByText(/Last sent/)).toBeInTheDocument();
    fireEvent.click(await within(list).findByRole("button", { name: "Resend sign-in link" }));
    expect(await within(list).findByText("Sign-in link sent.")).toBeInTheDocument();
    expect(api.calls.filter((c) => c.path.endsWith("/signin-link"))).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/password:\s*\S/i);
  });

  it("the Caregivers list offers Add email / Send sign-in link only to people who have not signed in; one click sends it and shows the result", async () => {
    const api = renderAt("/care-team", "manager");
    const row = (await screen.findByText(/Synthetic Newcomer/)).closest("tr")!;
    expect(within(row).getByRole("link", { name: "Add email" })).toHaveAttribute("href", `/care-team/abababab-0000-4000-8000-000000000009`);
    expect(within(screen.getByText(/Synthetic Caregiver One/).closest("tr")!).queryByText(/sign-in link|Add email/i)).not.toBeInTheDocument();
    expect(api.calls.some((c) => c.path.endsWith("/signin-link"))).toBe(false);
  });

  it("a caregiver who has signed in shows no send-link control on the page", async () => {
    renderAt(`/care-team/${CG}`, "manager");
    const list = await screen.findByTestId("readiness-checklist");
    await waitFor(() => expect(list).toHaveTextContent("Signed in"));
    expect(screen.queryByRole("button", { name: /sign-in link/ })).not.toBeInTheDocument();
  });
});

describe("Approve for work and CPR/TB extensions (0086)", () => {
  afterEach(() => { delete (globalThis as { __ready?: boolean }).__ready; });

  it("Approve is enabled only when the server says every hard requirement is met; a double-click sends ONE request with an Idempotency-Key", async () => {
    (globalThis as { __ready?: boolean }).__ready = true;
    const api = renderAt("/care-team/abababab-0000-4000-8000-000000000009", "manager");
    const list = await screen.findByTestId("readiness-checklist");
    const approve = await within(list).findByRole("button", { name: "Approve" });
    await waitFor(() => expect(approve).toBeEnabled());
    expect(within(list).getByText("Every required item is done")).toBeInTheDocument();
    fireEvent.click(approve);
    fireEvent.click(approve);
    await waitFor(() => expect(within(list).getByText(/Approved .* by Mia Manager/)).toBeInTheDocument());
    const posts = api.calls.filter((c) => c.method === "POST" && c.path.endsWith("/approve"));
    expect(posts).toHaveLength(1);
    expect(Object.keys(posts[0]!.headers).map((h) => h.toLowerCase())).toContain("idempotency-key");
    expect(posts[0]!.body).toEqual({ organizationId: ORG });
    expect(within(list).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("only an administrator sees Extend and Verify; extending needs a date and a reason, then posts both and shows the new due date", async () => {
    renderAt("/care-team/abababab-0000-4000-8000-000000000009", "manager");
    const asManager = await screen.findByTestId("readiness-checklist");
    await within(asManager).findByText("CPR certificate");
    expect(within(asManager).queryByRole("button", { name: "Extend" })).not.toBeInTheDocument();
    cleanup();

    const api = renderAt("/care-team/abababab-0000-4000-8000-000000000009", "organization_owner");
    const list = await screen.findByTestId("readiness-checklist");
    const cprRow = (await within(list).findByText("CPR certificate")).closest("li")!;
    fireEvent.click(within(cprRow).getByRole("button", { name: "Extend" }));
    fireEvent.click(within(cprRow).getAllByRole("button", { name: "Extend" }).at(-1)!); // the form's own Extend button, with nothing filled in
    expect(await within(cprRow).findByRole("alert")).toHaveTextContent("Choose the new due date");
    fireEvent.change(within(cprRow).getByLabelText("New due date"), { target: { value: "2026-11-15" } });
    fireEvent.click(within(cprRow).getAllByRole("button", { name: "Extend" }).at(-1)!);
    expect(await within(cprRow).findByRole("alert")).toHaveTextContent("reason");
    fireEvent.change(within(cprRow).getByLabelText("Reason (required)"), { target: { value: "Clinic booked (synthetic)" } });
    fireEvent.click(within(cprRow).getAllByRole("button", { name: "Extend" }).at(-1)!);
    await waitFor(() => expect(api.calls.some((c) => c.path.endsWith("/cpr-tb/extend"))).toBe(true));
    expect(api.calls.find((c) => c.path.endsWith("/cpr-tb/extend"))!.body).toEqual({ organizationId: ORG, requirement: "cpr", newDueDate: "2026-11-15", reason: "Clinic booked (synthetic)" });
    await waitFor(() => expect(cprRow).toHaveTextContent(/due .*11\/15\/2026|due .*Nov.*15/i));
  });

  it("every action button is at least 44px high on a phone and the checklist is one column", async () => {
    renderAt("/care-team/abababab-0000-4000-8000-000000000009", "organization_owner");
    const list = await screen.findByTestId("readiness-checklist");
    await within(list).findByText("CPR certificate");
    for (const control of [...within(list).getAllByRole("button"), ...within(list).getAllByRole("link")]) expect(control.className, control.textContent ?? "").toMatch(/min-h-\[44px\]/);
    expect(list.querySelector("table")).toBeNull();
  });
});

describe("Services", () => {
  it("manager sees the list read-only", async () => {
    renderAt("/services", "manager");
    expect(await screen.findByText(/Personal care/)).toBeInTheDocument();
    expect(screen.getByText(/Only the agency Administrator can change this list/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add service" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
  });

  it("Administrator adds a service; deactivating one in use shows the server's reason", async () => {
    const api = renderAt("/services", "organization_owner");
    fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "bad code!" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Synthetic Respite" } });
    fireEvent.click(screen.getByRole("button", { name: "Add service" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("1 to 20 letters");
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "RSP" } });
    fireEvent.click(screen.getByRole("button", { name: "Add service" }));
    expect(await screen.findByText("Service added.")).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === "POST" && c.path === "/v1/services")!.body).toMatchObject({ code: "RSP", name: "Synthetic Respite" });
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    fireEvent.change(screen.getByLabelText("Reason to deactivate PCS"), { target: { value: "No longer offered" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Deactivate" }).at(-1)!);
    expect(await screen.findByText(/still have current authorizations/)).toBeInTheDocument();
  });
});
