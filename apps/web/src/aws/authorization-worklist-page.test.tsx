// 0125 Authorization Worklist page: dashboard counts, filters sent to the server, exports, and hidden when the switch is off. SYNTHETIC data.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
const row = (o: Record<string, unknown>) => ({ clientId: "c" + o.clientCode, officeId: null, officeName: null, serviceId: "s1", serviceName: "Respite", program: "Regional Center", authorizationId: "a1", authorizationNumber: null, versionNumber: 1,
  periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-12-31T00:00:00.000Z", daysToExpiry: 30, authorizedMinutes: 600, usedMinutes: 60, scheduledMinutes: 0, remainingMinutes: 540, percentCommitted: 10, status: "ok", flags: [], ...o });
const ROWS = [
  row({ clientCode: "CL-M", status: "missing", authorizationId: null, authorizedMinutes: null, usedMinutes: null, scheduledMinutes: null, remainingMinutes: null, periodStart: null, periodEnd: null, program: null }),
  row({ clientCode: "CL-E", status: "expired", periodEnd: "2026-11-20T00:00:00.000Z", daysToExpiry: -7, officeName: "Temecula", officeId: "o1" }),
  row({ clientCode: "CL-N", status: "nearly_exhausted", usedMinutes: 480, remainingMinutes: 60, percentCommitted: 90, authorizedMinutes: 600, officeName: "Temecula", officeId: "o1" }),
  row({ clientCode: "CL-O", status: "ok", officeName: "San Diego", officeId: "o2" }),
];
type Req = { path: string; query: URLSearchParams };
function renderPage(opts: { on?: boolean; perms?: string[] } = {}) {
  const requests: Req[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input)); const req = { path: url.pathname, query: url.searchParams };
    if (req.path !== "/v1/me") requests.push(req);
    switch (req.path) {
      case "/v1/me": return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: "manager", permissions: opts.perms ?? ["authorizations.read", "visits.read", "organization.update"] }], profile: { displayName: "Synthetic Person" } });
      case "/v1/branding": return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "/v1/offices": return json(200, { offices: [{ officeId: "o1", name: "Temecula", isActive: true, clientCount: 2 }, { officeId: "o2", name: "San Diego", isActive: true, clientCount: 1 }] });
      case "/v1/authorization-worklist": {
        if (opts.on === false) return json(404, { error: { code: "not_found", message: "No such endpoint." } });
        if (req.query.get("clientId")) return json(200, { rows: [] });
        const s = req.query.get("status"); return json(200, { rows: s ? ROWS.filter((r) => r.status === s) : ROWS });
      }
      default: return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  const auth = { subscribe: vi.fn(() => () => {}), getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "p@example.test", emailVerified: true }, access_token: "t", expires_at: Date.now() + 3_600_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn() };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: fetchImpl as never });
  render(<MemoryRouter initialEntries={["/authorizations/worklist"]}><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}><AwsRoutes api={client} publicApi={client} /></CognitoAuthProvider></QueryClientProvider></MemoryRouter>);
  return { requests };
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const T = { timeout: 15000 };

describe("Authorization Worklist", () => {
  it("is not shown where the switch is off", async () => {
    renderPage({ on: false });
    await screen.findByText(/not turned on for your agency yet/, undefined, T);
    expect(screen.queryByRole("link", { name: "Authorization worklist" })).toBeNull();
  });
  it("shows the dashboard counts, the hours totals, the by-office table and every row worst first", async () => {
    renderPage();
    const rows = await screen.findAllByTestId("worklist-row", undefined, T);
    expect(rows.map((r) => within(r).getAllByRole("cell")[1]!.textContent)).toEqual(["CL-M", "CL-E", "CL-N", "CL-O"]);
    expect(screen.getByTestId("count-missing")).toHaveTextContent("1"); expect(screen.getByTestId("count-expired")).toHaveTextContent("1");
    expect(screen.getByTestId("count-nearly_exhausted")).toHaveTextContent("1"); expect(screen.getByTestId("count-ok")).toHaveTextContent("1"); expect(screen.getByTestId("count-exhausted")).toHaveTextContent("0");
    expect(within(screen.getByTestId("hours-summary")).getByText("Authorized (hours)").nextSibling).toHaveTextContent("30");        // 3 x 600 min
    expect(within(screen.getByRole("region", { name: "By office" })).getByText("Temecula")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("No authorization")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Authorization worklist" })).toBeInTheDocument();
  });
  it("a status card filters on the server and the other filters are sent as chosen", async () => {
    const { requests } = renderPage();
    await screen.findAllByTestId("worklist-row", undefined, T);
    fireEvent.click(screen.getByTestId("count-expired"));
    await waitFor(() => expect(screen.getAllByTestId("worklist-row")).toHaveLength(1));
    expect(requests.some((r) => r.path === "/v1/authorization-worklist" && r.query.get("status") === "expired")).toBe(true);
    fireEvent.change(screen.getByLabelText("Office"), { target: { value: "o1" } });
    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "2026-12" } });
    fireEvent.change(screen.getByLabelText("Program"), { target: { value: "Regional Center" } });
    await waitFor(() => expect(requests.some((r) => r.query.get("officeId") === "o1" && r.query.get("month") === "2026-12-01" && r.query.get("program") === "Regional Center")).toBe(true));
    expect(screen.getByTestId("count-ok")).toHaveTextContent("1");                      // the dashboard still counts the whole answer, not only the chosen status
  });
  it("exports CSV and Excel of the rows on screen and prints", async () => {
    const files: Array<{ name: string; type: string }> = [];
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b) => { files.push({ name: "", type: b.type }); return "blob:x"; };
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    const clicked: string[] = [];
    const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { clicked.push(this.download); };
    window.print = vi.fn();
    renderPage();
    await screen.findAllByTestId("worklist-row", undefined, T);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" })); fireEvent.click(screen.getByRole("button", { name: "Export Excel" })); fireEvent.click(screen.getByRole("button", { name: "Print" }));
    HTMLAnchorElement.prototype.click = orig;
    expect(clicked[0]).toMatch(/^authorization-worklist-\d{4}-\d{2}-\d{2}\.csv$/); expect(clicked[1]).toMatch(/\.xlsx$/);
    expect(files.map((f) => f.type)).toEqual(["text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
    expect(window.print).toHaveBeenCalled();
  });
  it("a person without authorization access sees nothing", async () => {
    renderPage({ perms: ["visits.read"] });
    await screen.findByText(/do not have access to authorizations/, undefined, T);
  });
});
