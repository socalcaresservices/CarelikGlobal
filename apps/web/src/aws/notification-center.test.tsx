// Notification centre (0113): inbox, filters, mark read, archive and restore, preferences, the office settings and history, the unavailable state, the shell link. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const N1 = "eeeeeeee-0000-4000-8000-000000000001";
const N2 = "eeeeeeee-0000-4000-8000-000000000002";
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
const item = (id: string, state: "unread" | "read" | "archived", n: number) => ({ id, category: "cover_shift", title: "A shift needs cover", body: `Personal care on Mon Dec ${n}, 9:00 AM to 11:00 AM. Open Ogevia to ask for it.`, link: "/schedule", shiftId: `ffffffff-0000-4000-8000-00000000000${n}`, createdAt: `2026-12-0${n}T17:00:00Z`, readAt: state === "unread" ? null : "2026-12-02T18:00:00Z", archivedAt: state === "archived" ? "2026-12-02T19:00:00Z" : null, state });

function renderAt(path: string, opts: { perms: string[]; on?: boolean; role?: string; emailAvailable?: boolean; settings?: Record<string, unknown> }) {
  const posts: Array<{ path: string; body: any }> = [];
  const gets: string[] = [];
  const store = { items: [item(N1, "unread", 1), item(N2, "read", 2)], prefs: { inApp: true, email: true }, settings: { enabled: false, emailEnabled: false, autoNotify: false, windowHours: 48, maxRecipients: 25, ...(opts.settings ?? {}) } };
  const on = opts.on ?? true;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)); posts.push({ path: url.pathname, body });
      if (!on) throw new TypeError("Failed to fetch");   // switch off: the browser sees a failed request, not a clean 404
      if (url.pathname === "/v1/notification-center/mark") {
        for (const n of store.items) if (body.ids.includes(n.id) || body.action === "read_all") {
          if (body.action === "archive") { n.state = "archived"; n.archivedAt = "x"; } else if (body.action === "unarchive") { n.state = "read"; n.archivedAt = null; } else if (n.state === "unread") { n.state = "read"; n.readAt = "x"; }
        }
        return json(200, { changed: 1 });
      }
      if (url.pathname === "/v1/notification-preferences") { store.prefs = { inApp: body.inApp, email: body.email }; return json(200, { preferences: { coverShift: store.prefs, emailAvailable: true } }); }
      if (url.pathname === "/v1/cover-notification-settings") { store.settings = { enabled: body.enabled, emailEnabled: body.emailEnabled, autoNotify: body.autoNotify, windowHours: body.windowHours, maxRecipients: body.maxRecipients }; return json(200, { settings: store.settings }); }
      return json(200, { status: "ok" });
    }
    gets.push(url.pathname + url.search);
    switch (url.pathname) {
      case "/v1/me": return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: opts.role ?? "caregiver", permissions: opts.perms }], profile: { displayName: "Synthetic Person" } });
      case "/v1/branding": return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "/v1/notification-center": {
        if (!on) throw new TypeError("Failed to fetch");
        const state = url.searchParams.get("state") ?? "inbox";
        const list = store.items.filter((n) => state === "all" ? true : state === "archived" ? n.state === "archived" : state === "unread" ? n.state === "unread" : n.state !== "archived");
        return json(200, { notifications: { asOf: "x", unread: store.items.filter((n) => n.state === "unread").length, items: list } });
      }
      case "/v1/notification-preferences": return on ? json(200, { preferences: { coverShift: store.prefs, emailAvailable: opts.emailAvailable ?? true } }) : (() => { throw new TypeError("Failed to fetch"); })();
      case "/v1/cover-notification-settings": return on ? json(200, { settings: store.settings }) : json(404, {});
      case "/v1/cover-notification-history": return on ? json(200, { history: [
        { notification_id: "h1", shift_id: null, caregiver_code: "CG-AAAA0001", created_at: "2026-12-01T17:00:00Z", in_app: true, read_at: null, email_status: "sent", email_attempts: 1, email_error: null, email_sent_at: "x" },
        { notification_id: "h2", shift_id: null, caregiver_code: "CG-AAAA0002", created_at: "2026-12-01T17:00:00Z", in_app: true, read_at: "x", email_status: "failed", email_attempts: 5, email_error: "throttling_exception", email_sent_at: null }] }) : json(404, {});
      case "/v1/action-issues": return json(200, { asOf: new Date().toISOString(), matching: 0, limit: 50, offset: 0, counts: { total: 0, critical: 0, urgent: 0, routine: 0, actionNeeded: 0 }, issues: [] });
      default: return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  const auth = { subscribe: vi.fn(() => () => {}), getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "p@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn() };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: fetchImpl as never });
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}><AwsRoutes api={client} publicApi={client} /></CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { posts, gets, store };
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const CG = ["visits.verify_own"];

describe("notification centre (caregiver)", () => {
  it("lists the inbox with unread marked and a count, marks one read, archives it, and restores it from Archived", async () => {
    const { posts } = renderAt("/notifications", { perms: CG });
    const items = await screen.findAllByTestId("center-item", {}, { timeout: 15000 });
    expect(items).toHaveLength(2);
    expect(screen.getByTestId("center-unread")).toHaveTextContent("1 unread");
    expect(items[0]).toHaveAttribute("data-state", "unread");
    fireEvent.click(within(items[0]!).getByRole("button", { name: "Mark read" }));
    await waitFor(() => expect(posts).toContainEqual({ path: "/v1/notification-center/mark", body: { organizationId: ORG, action: "read", ids: [N1] } }));
    await waitFor(() => expect(screen.getByTestId("center-unread")).toHaveTextContent("0 unread"));
    fireEvent.click(within(screen.getAllByTestId("center-item")[0]!).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(posts.at(-1)!.body).toMatchObject({ action: "archive", ids: [N1] }));
    await waitFor(() => expect(screen.getAllByTestId("center-item")).toHaveLength(1));
    fireEvent.change(screen.getByTestId("center-state"), { target: { value: "archived" } });
    const archived = await screen.findByRole("button", { name: "Restore" });
    fireEvent.click(archived);
    await waitFor(() => expect(posts.at(-1)!.body).toMatchObject({ action: "unarchive", ids: [N1] }));
  });
  it("filters by state and type through the server, and shows an empty state", async () => {
    const { gets } = renderAt("/notifications", { perms: CG });
    await screen.findAllByTestId("center-item", {}, { timeout: 15000 });
    fireEvent.change(screen.getByTestId("center-state"), { target: { value: "archived" } });
    expect(await screen.findByTestId("center-empty")).toHaveTextContent("Nothing archived.");
    fireEvent.change(screen.getByTestId("center-category"), { target: { value: "cover_shift" } });
    await waitFor(() => expect(gets.some((g) => g.includes("state=archived") && g.includes("category=cover_shift"))).toBe(true));
  });
  it("marks everything read", async () => {
    const { posts } = renderAt("/notifications", { perms: CG });
    await screen.findAllByTestId("center-item", {}, { timeout: 15000 });
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(posts).toContainEqual({ path: "/v1/notification-center/mark", body: { organizationId: ORG, action: "read_all", ids: [] } }));
  });
  it("saves preferences, warns when both are off, and disables email where the agency has not turned it on", async () => {
    const { posts } = renderAt("/notifications", { perms: CG });
    const email = await screen.findByTestId("pref-email", {}, { timeout: 15000 });
    fireEvent.click(email);
    await waitFor(() => expect(posts).toContainEqual({ path: "/v1/notification-preferences", body: { organizationId: ORG, category: "cover_shift", inApp: true, email: false } }));
    fireEvent.click(screen.getByTestId("pref-inapp"));
    expect(await screen.findByText(/you will not be told about open shifts/i)).toBeInTheDocument();
    cleanup();
    renderAt("/notifications", { perms: CG, emailAvailable: false });
    expect(await screen.findByText("Email is not turned on for your agency.", {}, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.getByTestId("pref-email")).toBeDisabled();
  });
  it("shows no office section to a caregiver", async () => {
    renderAt("/notifications", { perms: CG });
    await screen.findAllByTestId("center-item", {}, { timeout: 15000 });
    expect(screen.queryByText("Office: cover-shift notifications")).not.toBeInTheDocument();
  });
  it("where the switch is off it says so and shows no controls", async () => {
    renderAt("/notifications", { perms: CG, on: false });
    expect(await screen.findByTestId("center-unavailable", {}, { timeout: 15000 })).toHaveTextContent("not available in this environment yet");
    expect(screen.queryByTestId("center-state")).not.toBeInTheDocument();
  });
  it("the caregiver navigation shows the link with the unread count only where the switch is on", async () => {
    renderAt("/my-shifts", { perms: [...CG, "shifts.read_own"] });
    expect(await screen.findByRole("link", { name: /Notifications \(1\)/ }, { timeout: 15000 })).toBeInTheDocument();
    cleanup();
    renderAt("/my-shifts", { perms: [...CG, "shifts.read_own"], on: false });
    await screen.findAllByText(/My Schedule/i, {}, { timeout: 15000 });
    expect(screen.queryByRole("link", { name: /^Notifications/ })).not.toBeInTheDocument();
  });
});

describe("notification centre (office)", () => {
  const STAFF = ["shifts.manage", "visits.read", "organization.update"];
  it("the owner changes the settings with a reason; nothing is sent until the reason is given", async () => {
    const { posts } = renderAt("/notifications", { perms: STAFF, role: "owner" });
    fireEvent.click(await screen.findByTestId("set-enabled", {}, { timeout: 15000 }));
    fireEvent.click(screen.getByTestId("set-email"));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("A reason is required.")).toBeInTheDocument();
    expect(posts.some((p) => p.path === "/v1/cover-notification-settings")).toBe(false);
    fireEvent.change(screen.getByTestId("set-reason"), { target: { value: "Pilot with two caregivers" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(posts).toContainEqual({ path: "/v1/cover-notification-settings", body: { organizationId: ORG, enabled: true, emailEnabled: true, autoNotify: false, windowHours: 48, maxRecipients: 25, reason: "Pilot with two caregivers" } }));
  });
  it("a manager who is not the owner sees the history but no settings controls; the history is sortable and never shows an address", async () => {
    renderAt("/notifications", { perms: ["shifts.manage", "visits.read"], role: "manager" });
    const table = await screen.findByRole("table", { name: "Cover-shift notification history" }, { timeout: 15000 });
    expect(screen.queryByTestId("set-enabled")).not.toBeInTheDocument();
    expect(within(table).getByText("Sent")).toBeInTheDocument(); expect(within(table).getByText("Failed")).toBeInTheDocument(); expect(within(table).getByText("throttling exception")).toBeInTheDocument();
    fireEvent.click(within(table).getByRole("button", { name: /Attempts/ }));
    const rows = within(table).getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("CG-AAAA0001")).toBeInTheDocument();
    fireEvent.click(within(table).getByRole("button", { name: /Attempts/ }));
    expect(within(within(table).getAllByRole("row")[1]!).getByText("CG-AAAA0002")).toBeInTheDocument();
    expect(table.textContent).not.toContain("@");
  });
});
