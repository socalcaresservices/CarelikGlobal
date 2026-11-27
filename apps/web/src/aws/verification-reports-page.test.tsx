// 0124: Visit verification reports, exception actions, follow-up actions, the label inventory and the printed label. SYNTHETIC data; the fake API records every request.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";
import { LabelSheet } from "./home-labels-panel";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
const STAFF = ["visits.read", "visits.manage", "clients.manage", "clients.names.manage", "reports.export", "clients.names.read", "billing.visits.read"];
type Req = { method: string; path: string; query: URLSearchParams; body: Record<string, unknown> };

function renderPage(opts: { perms?: string[]; on?: boolean; reports?: Record<string, unknown[]>; post?: (r: Req) => Response | null } = {}) {
  const requests: Req[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const req: Req = { method: init?.method ?? "GET", path: url.pathname, query: url.searchParams, body: (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown> };
    if (req.path !== "/v1/me") requests.push(req);
    if (req.method === "POST") { const r = opts.post?.(req); if (r) return r; }
    if (req.path === "/v1/me") return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: "manager", permissions: opts.perms ?? STAFF }], profile: { displayName: "Synthetic Person" } });
    if (req.path === "/v1/branding") return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: "#0a7c86", logoSha256: null } });
    if (req.path === "/v1/verification-settings") return opts.on === false ? json(404, { error: { code: "not_found", message: "No such endpoint." } }) : json(200, { settings: { earlyCheckoutMinutes: 30 } });
    const m = /^\/v1\/verification-reports\/(.+)$/.exec(req.path);
    if (m) return req.query.get("format") === "csv" ? json(200, { csv: "\"A\"\r\n\"1\"", filename: `${m[1]}.csv`, rowCount: 1 }) : json(200, { rows: opts.reports?.[m[1]!] ?? [] });
    if (req.path === "/v1/home-labels" && req.method === "GET") return json(200, { labels: opts.reports?.labels ?? [] });
    return json(404, { error: { code: "not_found", message: "No such endpoint." } });
  });
  const auth = { subscribe: vi.fn(() => () => {}), getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "p@example.test", emailVerified: true }, access_token: "t", expires_at: Date.now() + 3_600_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn() };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: fetchImpl as never });
  render(
    <MemoryRouter initialEntries={["/verification"]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}><AwsRoutes api={client} publicApi={client} /></CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { requests };
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const T = { timeout: 15000 };

describe("Visit verification page", () => {
  it("is not shown where the switch is off: the page says it is not turned on and the menu has no link", async () => {
    renderPage({ on: false });
    await screen.findByText(/not turned on for your agency yet/, undefined, T);
    expect(screen.queryByRole("tab", { name: "Visit exceptions" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Visit verification" })).toBeNull();
  });
  it("shows the six reports, reads the open exceptions first and lets a reviewer start and finish a review with a note", async () => {
    const exception = { exceptionId: "e1", kind: "location_issue", status: "open", openedAt: "2026-11-23T17:00:00Z", ageHours: 3, caregiverName: "Synthetic CG", clientCode: "CL-1", scheduledStart: "2026-11-23T16:00:00Z", actualTimeIn: "2026-11-23T16:01:00Z", actualTimeOut: null, visitId: "v1" };
    const { requests } = renderPage({ reports: { visit_exceptions: [exception] } });
    await screen.findByRole("tab", { name: "Visit exceptions" }, T);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Visit exceptions", "Checked out without signature", "Visit time and signature register", "Corrections and audit", "Payroll and billing review", "Home label inventory"]);
    const table = await screen.findByRole("table", { name: "Visit exceptions" });
    expect(within(table).getByText("Location issue")).toBeInTheDocument();
    expect(requests.find((r) => r.path === "/v1/verification-reports/visit_exceptions")!.query.get("status")).toBe("open");
    fireEvent.click(within(table).getByRole("button", { name: "Resolve" }));
    const save = within(table).getByRole("button", { name: "Save decision" });
    expect(save).toBeDisabled();
    fireEvent.change(within(table).getByLabelText("What was decided?"), { target: { value: "Client confirmed by phone" } });
    fireEvent.click(save);
    await waitFor(() => expect(requests.some((r) => r.method === "POST" && r.path === "/v1/visit-exceptions/e1/resolve")).toBe(true));
    expect(requests.find((r) => r.path === "/v1/visit-exceptions/e1/resolve")!.body).toEqual({ organizationId: ORG, action: "resolved", note: "Client confirmed by phone" });
  });
  it("a visit checked out without a signature can be owned and sent a signing link; the link is shown once and the delivery is logged without it", async () => {
    const row = { visitId: "v9", visitNumber: "V-9", state: "pending", reason: "signing_later", directRequired: false, caregiverName: "Synthetic CG", clientCode: "CL-9", pendingHours: 4, lastRequestAt: null };
    const writes: string[] = [];
    const { requests } = renderPage({ reports: { unsigned_checkouts: [row] },
      post: (r) => { writes.push(r.path); return r.path === "/v1/visits/v9/confirmation-requests" ? json(201, { requestId: "r1", token: "ab".repeat(32), code: "123456", expiresAt: "2026-11-30T00:00:00Z" }) : json(200, { saved: true, logged: true }); } });
    fireEvent.click(await screen.findByRole("tab", { name: "Checked out without signature" }, T));
    const table = await screen.findByRole("table", { name: "Checked out without signature" });
    fireEvent.click(within(table).getByRole("button", { name: "Take ownership" }));
    await waitFor(() => expect(requests.find((r) => r.path === "/v1/visits/v9/signature-followup/owner")?.body).toEqual({ organizationId: ORG, assignToMe: true }));
    fireEvent.click(within(table).getByRole("button", { name: "Send signing link" }));
    fireEvent.change(within(table).getByLabelText("Name"), { target: { value: "Synthetic Parent" } });
    fireEvent.change(within(table).getByLabelText("How you checked who they are"), { target: { value: "Called the number on file" } });
    fireEvent.click(within(table).getByRole("button", { name: "Create link" }));
    const shown = await screen.findByTestId("signing-link");
    expect(shown.textContent).toContain(`/confirm-visit#${"ab".repeat(32)}`);
    expect(shown.textContent).toContain("code 123456");
    const delivery = requests.filter((r) => r.path === "/v1/visits/v9/signature-followup/delivery");
    expect(delivery.map((d) => d.body.action)).toEqual(["request_created"]);
    expect(JSON.stringify(delivery.map((d) => d.body))).not.toMatch(/ab{4}|123456|token|code/);
    const create = requests.find((r) => r.path === "/v1/visits/v9/confirmation-requests")!;
    expect(create.body).toMatchObject({ channel: "link", recipientName: "Synthetic Parent", recipientRole: "client", expiresInDays: 7 });
  });
  it("a missed clock-out can be corrected through a request; another reviewer approves it with a note and the location decision is sent", async () => {
    const rows = [
      { exceptionId: "e2", kind: "overdue_clock_out", status: "open", visitId: "v2", openedAt: "2026-11-23T17:00:00Z", ageHours: 5, caregiverName: "Synthetic CG", clientCode: "CL-2" },
      { exceptionId: "e3", kind: "correction_request", status: "open", visitId: "v3", openedAt: "2026-11-23T17:00:00Z", ageHours: 1, caregiverName: "Synthetic CG", clientCode: "CL-3", detail: { reason_code: "lost_tag", request_id: "dddddddd-0000-4000-8000-000000000004" } },
    ];
    const { requests } = renderPage({ reports: { visit_exceptions: rows }, post: () => json(200, { requestId: "r", visitId: "v" }) });
    const table = await screen.findByRole("table", { name: "Visit exceptions" }, T);
    const [overdue, correction] = within(table).getAllByRole("row").slice(1);
    fireEvent.click(within(overdue!).getByRole("button", { name: "Request time correction" }));
    fireEvent.change(within(overdue!).getByLabelText("Actual clock-out time"), { target: { value: "2026-11-23T10:30" } });
    fireEvent.change(within(overdue!).getByLabelText("Details"), { target: { value: "Sticker was missing; caregiver called the office" } });
    fireEvent.click(within(overdue!).getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(requests.some((r) => r.path === "/v1/visits/v2/punch-corrections")).toBe(true));
    expect(requests.find((r) => r.path === "/v1/visits/v2/punch-corrections")!.body).toMatchObject({ reasonCode: "poor_connectivity", reasonNote: "Sticker was missing; caregiver called the office" });
    expect(String((requests.find((r) => r.path === "/v1/visits/v2/punch-corrections")!.body as { requestedTimeOut: string }).requestedTimeOut)).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    const approve = within(correction!).getByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    fireEvent.change(within(correction!).getByLabelText("Decision note"), { target: { value: "Verified with the caregiver" } });
    fireEvent.click(approve);
    await waitFor(() => expect(requests.some((r) => r.path === "/v1/punch-corrections/dddddddd-0000-4000-8000-000000000004/decide")).toBe(true));
    expect(requests.find((r) => r.path.endsWith("/decide"))!.body).toEqual({ organizationId: ORG, approve: true, note: "Verified with the caregiver", locationDecision: "accepted" });
  });
  it("the CSV button appears only with the export permission and asks the server for the file", async () => {
    const created: string[] = [];
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b) => { created.push(String(b.size)); return "blob:x"; };
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    const { requests } = renderPage({ reports: { visit_exceptions: [] } });
    fireEvent.click(await screen.findByRole("button", { name: "Download CSV" }, T));
    await waitFor(() => expect(requests.some((r) => r.query.get("format") === "csv")).toBe(true));
    expect(screen.getByRole("button", { name: "Download Excel" })).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Print" })).toBeInTheDocument();
    cleanup();
    renderPage({ perms: ["visits.read", "visits.manage", "billing.visits.read"] });
    await screen.findByRole("tab", { name: "Visit exceptions" }, T);
    expect(screen.queryByRole("button", { name: "Download CSV" })).toBeNull(); expect(screen.queryByRole("button", { name: "Download Excel" })).toBeNull();
  });
  it("a person without visit access sees nothing", async () => {
    renderPage({ perms: ["clients.manage"] });
    await screen.findByText(/do not have access to this page/, undefined, T);
  });
});

describe("home label inventory and the printed label", () => {
  it("registers a batch, offers the supplier file with sticker IDs only, and lists stickers with their status", async () => {
    const labels = [
      { labelId: "l1", labelCode: "OGL-AAAAAAAA", status: "active", clientCode: "CL-7", locationName: "Client home", locationCity: "Synthetictown", installedAt: "2026-11-01T10:00:00Z", lastUsedAt: null, replacedByCode: null },
      { labelId: "l2", labelCode: "OGL-BBBBBBBB", status: "unassigned", clientCode: null, locationName: null, locationCity: null, installedAt: null, lastUsedAt: null, replacedByCode: null },
    ];
    const { requests } = renderPage({ reports: { labels }, post: (r) => r.path === "/v1/home-labels" ? json(200, { batchId: "b1", codes: ["OGL-CCCCCCCC", "OGL-DDDDDDDD"] }) : null });
    fireEvent.click(await screen.findByRole("tab", { name: "Home label inventory" }, T));
    const rows = await screen.findAllByTestId("label-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("OGL-AAAAAAAA");
    expect(rows[0]).toHaveTextContent("Client CL-7");
    expect(rows[1]).toHaveTextContent(/not assigned/);
    fireEvent.change(screen.getByLabelText("How many"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Register stickers" }));
    await screen.findByText(/2 stickers registered/);
    expect(requests.find((r) => r.method === "POST" && r.path === "/v1/home-labels")!.body).toEqual({ organizationId: ORG, count: 2 });
    expect(screen.getByRole("button", { name: /Download the supplier file \(IDs only\)/ })).toBeInTheDocument();
  });
  it("a printed label shows the QR code, the sticker ID and an instruction: no client name or address; three layouts", () => {
    for (const layout of ["discreet", "agency", "large"] as const) {
      const { unmount, container } = render(<LabelSheet token={"cd".repeat(32)} code="OGL-AAAAAAAA" layout={layout} agencyName="Synthetic Care Co" accent="#0a7c86" />);
      const sheet = screen.getByTestId("label-sheet");
      expect(sheet).toHaveTextContent("OGL-AAAAAAAA");
      expect(sheet).toHaveTextContent(/Tap your phone here, or scan, to clock in or out/);
      expect(sheet).toHaveTextContent(layout === "agency" ? "Synthetic Care Co" : "Ogevia");
      expect(sheet.textContent).not.toMatch(/Way|Street|CL-|Client/);
      expect(container.querySelector("svg")).not.toBeNull();
      unmount();
    }
  });
});
