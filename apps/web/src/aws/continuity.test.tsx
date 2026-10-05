// Continuity pack (0027) and outage visit records (0028) against an in-memory
// fake of the AWS API, through the real API client and routes. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";
import { buildContinuityHtml, continuityFileName, continuityState, outageNumber, type ContinuityPack } from "./continuity-pack";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CLIENT = "cccccccc-0000-4000-8000-000000000001";
const SVC = "dddddddd-0000-4000-8000-000000000001";
const CG1 = "abababab-0000-4000-8000-000000000001";
type Role = "caregiver" | "manager";
type Call = { method: string; path: string; body: Record<string, unknown> | null; headers: Record<string, string> };

const PACK: ContinuityPack = {
  agency: "Synthetic Care Co", timezone: "America/Los_Angeles", data_as_of: "2026-10-05T16:05:00Z", exported_by: "Synthetic Manager",
  includes_client_names: true, outage_numbers: { first: 26, last: 50 },
  shifts: [{ local_date: "2026-10-06", start: "09:00", end: "11:00", client_code: "CL-1", client_label: "Alpha", client_name: "Synthetic <b>Client</b>", service: "Personal care", caregiver: null, caregiver_code: null, coverage: "needs_coverage" }],
  clients: [{ client_code: "CL-1", client_label: "Alpha", city: "Synthetic City", client_name: "Synthetic <b>Client</b>" }],
  authorizations: [{ client_code: "CL-1", client_label: "Alpha", service: "Personal care", period_start: "2026-10-01", period_end: "2026-10-31", authorized_minutes: 1800, reserved_minutes: 120, billable_minutes: 300, review_minutes: 0, remaining_minutes: 1380 }],
  caregivers: [{ caregiver_code: "CG-1", name: "Synthetic Caregiver One", status: "active" }],
};

function fakeApi(role: Role, opts: { lastDownloadedHoursAgo?: number | null } = {}) {
  const calls: Call[] = [];
  const permissions = role === "manager"
    ? ["authorizations.read", "caregivers.manage", "clients.names.read", "continuity.export", "shifts.manage", "visits.manage", "visits.read"]
    : ["availability.manage_own", "documents.manage_own"];
  let hours = opts.lastDownloadedHoursAgo === undefined ? 30 : opts.lastDownloadedHoursAgo;
  const entered = new Set<number>();
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
      case "GET /v1/document-alerts":
        return json(200, { alerts: null });
      case "GET /v1/reports/utilisation":
        return json(200, { services: [] });
      case "GET /v1/continuity/status":
        return json(200, { status: hours === null
          ? { lastDownloadedAt: null, lastDownloadedBy: null, hoursSince: null, downloadsLast7Days: 0, outageNumbersIssued: 0 }
          : { lastDownloadedAt: "2026-10-04T10:00:00Z", lastDownloadedBy: "Synthetic Manager", hoursSince: String(hours), downloadsLast7Days: 1, outageNumbersIssued: 25 } });
      case "POST /v1/continuity/pack":
        hours = 0;
        return json(200, { pack: PACK });
      case "GET /v1/outage-visits/reconciliation":
        return json(200, { records: [26, 27, 28].map((n) => entered.has(n)
          ? { outageNumber: n, issuedAt: "x", state: "entered", visitId: "v", visitNumber: "CL1-PCS-051026-0900-AB", clientCode: "CL-1", caregiverName: "Synthetic Caregiver One", serviceDate: "2026-10-05", workedMinutes: 120, visitStatus: "administrator_review", authorizationStatus: "within_authorization", paperConfirmation: "signature_on_form", reasonNotUsed: null }
          : { outageNumber: n, issuedAt: "x", state: "missing", visitId: null, visitNumber: null, clientCode: null, caregiverName: null, serviceDate: null, workedMinutes: null, visitStatus: null, authorizationStatus: null, paperConfirmation: null, reasonNotUsed: null }) });
      case "POST /v1/outage-visits": {
        const n = Number(body?.outageNumber);
        if (entered.has(n)) return json(409, { error: { code: "conflict", message: `Outage record ${outageNumber(n)} was already entered (visit CL1-PCS-051026-0900-AB)` } });
        entered.add(n);
        return json(201, { visit: { visitId: "v", visitNumber: "CL1-PCS-051026-0900-AB", workedMinutes: 120, authorizationStatus: "within_authorization", outageNumber: n } });
      }
      case "GET /v1/clients":
        return json(200, { clients: [{ clientId: CLIENT, clientCode: "CL-1", caregiverDisplayCode: null, status: "active", legalFirstName: "Synthetic", legalLastName: "Client Alpha", city: null, clientTypeId: null, clientTypeName: null, currentAuthorizations: 1, openVisits: 0 }] });
      case "GET /v1/services":
        return json(200, { services: [{ serviceId: SVC, code: "PCS", name: "Personal care", isActive: true }] });
      case "GET /v1/caregivers":
        return json(200, { caregivers: [{ caregiverRecordId: CG1, caregiverCode: "CG-1", firstName: "Synthetic", lastName: "Caregiver One", preferredName: null, status: "active", hasSignIn: true, signInStatus: "active", activeAssignments: 1, openVisits: 0 }] });
      default:
        return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  return { calls, fetchImpl };
}

function renderAt(path: string, role: Role, opts?: Parameters<typeof fakeApi>[1]) {
  const api = fakeApi(role, opts);
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

afterEach(() => vi.restoreAllMocks());

describe("continuity pack file", () => {
  it("states its data-as-of time, escapes every value, lists the issued outage numbers and carries no money", () => {
    const html = buildContinuityHtml(PACK);
    expect(html).toContain("Data as of Monday, October 5, 2026 at 9:05 AM (America/Los_Angeles)");
    expect(html).toContain("Synthetic &lt;b&gt;Client&lt;/b&gt;");
    expect(html).not.toContain("<b>Client</b>");
    expect(html).toContain("OUT-000026");
    expect(html).toContain("OUT-000050");
    expect(html).not.toContain("OUT-000051");
    expect(html).toContain("NEEDS COVERAGE");
    expect(html).toContain("23 h 00 min");
    expect(html).not.toMatch(/\$|cents|rate/i);
  });

  it("names the file by agency-local time only (no client or caregiver names)", () => {
    expect(continuityFileName(PACK)).toBe("ogevia-continuity-20261005-0905.html");
  });

  it("is stale after 24 hours or when never downloaded", () => {
    expect(continuityState(null)).toEqual({ stale: true, text: "No continuity pack has been downloaded yet" });
    expect(continuityState({ lastDownloadedAt: "x", lastDownloadedBy: "A", hoursSince: "30.5", downloadsLast7Days: 1, outageNumbersIssued: 25 }).stale).toBe(true);
    expect(continuityState({ lastDownloadedAt: "x", lastDownloadedBy: "A", hoursSince: "2", downloadsLast7Days: 1, outageNumbersIssued: 25 })).toEqual({ stale: false, text: "Continuity pack last downloaded 2 hours ago by A" });
  });
});

describe("Continuity page", () => {
  it("warns on the home screen when the pack is stale, downloads a new pack with an idempotency key and reports its as-of time", async () => {
    const created: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => { created.push("blob"); return "blob:synthetic"; });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const api = renderAt("/", "manager");
    expect(await screen.findByText(/OUTAGE READINESS: Continuity pack last downloaded 30 hours ago by Synthetic Manager/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Continuity pack" }));
    fireEvent.click(await screen.findByRole("button", { name: "Download continuity pack" }));
    expect(await screen.findByText(/Downloaded: data as of .*; outage numbers OUT-000026 to OUT-000050\./)).toBeInTheDocument();
    expect(click).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    const post = api.calls.find((c) => c.path === "/v1/continuity/pack")!;
    expect(post.body).toEqual({ organizationId: ORG });
    expect(Object.keys(post.headers).map((h) => h.toLowerCase())).toContain("idempotency-key");
  });

  it("is not offered to caregivers", async () => {
    renderAt("/continuity", "caregiver");
    expect(await screen.findByText(/Only an Administrator or a manager can download the continuity pack/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Continuity" })).toBeNull();
  });
});

describe("Outage records page", () => {
  it("enters a numbered record, shows it in reconciliation, and shows the server's refusal of a duplicate", async () => {
    const api = renderAt("/outage-visits", "manager");
    expect(await screen.findByText(/3 numbers issued · 0 entered · 0 not used · 3 MISSING/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Enter outage record" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("record number printed on the form");
    fireEvent.change(screen.getByLabelText("Record number"), { target: { value: "OUT-000026" } });
    fireEvent.change(screen.getByLabelText("Date of the visit"), { target: { value: "2026-10-05" } });
    fireEvent.change(await screen.findByLabelText("Client"), { target: { value: CLIENT } });
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: SVC } });
    fireEvent.change(screen.getByLabelText("Caregiver"), { target: { value: CG1 } });
    fireEvent.change(screen.getByLabelText("Time In (as written)"), { target: { value: "09:00" } });
    fireEvent.change(screen.getByLabelText("Time Out (as written)"), { target: { value: "11:00" } });
    fireEvent.click(screen.getByLabelText("Signed on the form"));
    fireEvent.click(screen.getByRole("button", { name: "Enter outage record" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("name of the person who signed");
    fireEvent.change(screen.getByLabelText("Name of the person who signed or confirmed"), { target: { value: "Synthetic Representative" } });
    fireEvent.click(screen.getByRole("button", { name: "Enter outage record" }));
    expect(await screen.findByText(/OUT-000026 entered as visit CL1-PCS-051026-0900-AB \(120 min\)\. It is in administrator review with 0 billable minutes\./)).toBeInTheDocument();
    expect(await screen.findByText(/3 numbers issued · 1 entered · 0 not used · 2 MISSING/)).toBeInTheDocument();
    const post = api.calls.find((c) => c.path === "/v1/outage-visits")!;
    expect(post.body).toMatchObject({ organizationId: ORG, outageNumber: 26, clientId: CLIENT, serviceId: SVC, caregiverRecordId: CG1, date: "2026-10-05", timeIn: "09:00", timeOut: "11:00", paperConfirmation: "signature_on_form", signerName: "Synthetic Representative" });

    fireEvent.change(screen.getByLabelText("Record number"), { target: { value: "26" } });
    fireEvent.change(screen.getByLabelText("Client"), { target: { value: CLIENT } });
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: SVC } });
    fireEvent.change(screen.getByLabelText("Caregiver"), { target: { value: CG1 } });
    fireEvent.change(screen.getByLabelText("Time In (as written)"), { target: { value: "13:00" } });
    fireEvent.change(screen.getByLabelText("Time Out (as written)"), { target: { value: "14:00" } });
    fireEvent.click(screen.getByLabelText("Verbal confirmation noted"));
    fireEvent.change(screen.getByLabelText("Name of the person who signed or confirmed"), { target: { value: "Synthetic Representative" } });
    fireEvent.click(screen.getByRole("button", { name: "Enter outage record" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("OUT-000026 was already entered");
  });
});
