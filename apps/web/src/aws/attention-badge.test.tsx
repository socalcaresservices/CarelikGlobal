// ACTION NEEDED badge and Home banner: red with a confirmed count, green only for a confirmed
// zero, neutral while checking or when the check failed. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
type Role = "caregiver" | "manager";
const PERMS: Record<Role, string[]> = {
  manager: ["visits.read", "visits.manage", "billing.visits.read", "shifts.manage", "care_requests.read", "clients.names.read", "caregivers.manage",
    "authorizations.read", "documents.read", "continuity.export"],
  caregiver: ["availability.manage_own", "documents.manage_own"],
};

function renderAt(path: string, role: Role, attention: () => Promise<Response> | Response) {
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/me") {
      return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role, permissions: PERMS[role] }], profile: { displayName: "Synthetic Person" } });
    }
    if (url.pathname === "/v1/branding") return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
    if (url.pathname === "/v1/attention") return attention();
    return json(404, { error: { code: "not_found", message: "No such endpoint." } });
  });
  const auth = {
    subscribe: vi.fn(() => () => {}),
    getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "person@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn(),
  };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: fetchImpl as never });
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}>
          <AwsRoutes api={client} publicApi={client} />
        </CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

async function currentItems() {
  const nav = await screen.findByRole("navigation", { name: "Main" });
  return within(nav).queryAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent);
}

afterEach(() => vi.clearAllMocks());
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
const summary = (total: number) => ({ missingTimeOut: total, notConfirmed: 0, needsReview: 0, billingReadyUnapproved: 0, total });

describe("ACTION NEEDED badge", () => {
  it("count above zero: red ACTION NEEDED with the count and a warning icon", async () => {
    renderAt("/", "manager", () => json(200, { summary: summary(2) }));
    const badge = await screen.findByRole("link", { name: "Action needed: 2" });
    expect(badge).toHaveTextContent("⚠");
    expect(badge).toHaveTextContent("2");
    expect(badge.className).toMatch(/text-red-700/);
    expect(badge.className).not.toMatch(/emerald/);
  });

  it("confirmed zero: green ALL CLEAR — 0 with a checkmark", async () => {
    renderAt("/", "manager", () => json(200, { summary: summary(0) }));
    const badge = await screen.findByRole("link", { name: "All clear: nothing needs action" });
    expect(badge).toHaveTextContent("✓");
    expect(badge).toHaveTextContent("All clear");
    expect(badge).toHaveTextContent("0");
    expect(badge.className).toMatch(/emerald/);
  });

  it("while loading: neutral Checking…, never green", async () => {
    renderAt("/", "manager", () => new Promise<Response>(() => {}));
    const badge = await screen.findByRole("link", { name: "Checking items that need action" });
    expect(badge).toHaveTextContent("Checking…");
    expect(badge.className).not.toMatch(/emerald|red/);
  });

  it("failed check: neutral Unable to check, never green", async () => {
    renderAt("/", "manager", () => json(500, { error: { code: "internal", message: "Synthetic failure" } }));
    const badge = await screen.findByRole("link", { name: "Unable to check items that need action" });
    expect(badge).toHaveTextContent("Unable to check");
    expect(badge.className).not.toMatch(/emerald|red/);
    await waitFor(() => expect(screen.queryByText("All clear")).toBeNull());
  });
});

describe("navigation highlight", () => {
  it("marks only the current section with aria-current=page, including nested routes", async () => {
    renderAt("/", "manager", () => json(200, { summary: summary(0) }));
    expect(await currentItems()).toEqual(["Home"]);
  });

  it("a nested route highlights its own section only, not its parent", async () => {
    renderAt("/service-verification/reports", "manager", () => json(200, { summary: summary(0) }));
    await waitFor(async () => expect(await currentItems()).toEqual(["Visit records"]));
  });
});

// The same total on the header badge and the Home banner, from the same summary.
const full = {
  missingTimeOut: 1, notConfirmed: 2, needsReview: 3, lateResponsesToReview: 4, uncoveredShifts: 12,
  documentsBlocking: 5, documentsToReview: 6, billingReadyUnapproved: 3,
  // Reminders: must never change the total.
  awaitingSignature: 7, documentsExpiring: 1,
  // The old server total (without Ready for Approval): the client must not use it.
  total: 33,
};
const FULL_TOTAL = 1 + 2 + 3 + 4 + 12 + 5 + 6 + 3; // 36

describe("ACTION NEEDED: one total for the badge and the Home banner", () => {
  it("badge and banner both show the sum of the eight category counts, ignoring the stale server total and the reminders", async () => {
    renderAt("/", "manager", () => json(200, { summary: full }));
    const badge = await screen.findByRole("link", { name: `Action needed: ${FULL_TOTAL}` });
    expect(badge).toHaveTextContent(String(FULL_TOTAL));
    const banner = await screen.findByTestId("action-needed-banner");
    expect(banner).toHaveTextContent(`Action needed: ${FULL_TOTAL}`);
    expect(banner.className).toMatch(/text-red-700/);
    // The eight categories, with the new labels and their own counts.
    const list = screen.getByRole("heading", { name: "Action needed" }).closest("section")!;
    for (const [label, n] of [["Missing Clock-Out", 1], ["Awaiting Confirmation", 2], ["Visits to Review", 3], ["Signatures to Review", 4], ["Unfilled Shifts", 12],
      ["Overdue Documents", 5], ["Documents to Review", 6], ["Ready for Approval", 3]] as const) {
      const row = within(list).getByText(label).closest("a")!;
      expect(row).toHaveTextContent(String(n));
    }
    // Reminders are shown, outside the total.
    const reminders = within(list).getByText(/Reminders/).closest("section, div") ? within(list) : within(list);
    expect(reminders.getByText("Waiting for a Signature")).toBeInTheDocument();
    expect(reminders.getByText("Documents Expiring Soon")).toBeInTheDocument();
    expect(within(list).queryByText("Billing ready, not approved")).toBeNull();
  });

  it("example: 12 Unfilled Shifts + 3 Ready for Approval, everything else 0 = 15; an expiring document stays a reminder", async () => {
    renderAt("/", "manager", () => json(200, { summary: { missingTimeOut: 0, notConfirmed: 0, needsReview: 0, lateResponsesToReview: 0, uncoveredShifts: 12,
      documentsBlocking: 0, documentsToReview: 0, billingReadyUnapproved: 3, awaitingSignature: 0, documentsExpiring: 1, total: 12 } }));
    expect(await screen.findByRole("link", { name: "Action needed: 15" })).toBeInTheDocument();
    expect(await screen.findByTestId("action-needed-banner")).toHaveTextContent("Action needed: 15");
    expect(screen.getByText("Documents Expiring Soon")).toBeInTheDocument();
  });

  it("zero is a green all-clear banner while reminders remain visible", async () => {
    renderAt("/", "manager", () => json(200, { summary: { ...summary(0), lateResponsesToReview: 0, uncoveredShifts: 0, documentsBlocking: 0, documentsToReview: 0, awaitingSignature: 2, documentsExpiring: 1 } }));
    const banner = await screen.findByTestId("action-needed-banner");
    await waitFor(() => expect(banner).toHaveTextContent("All clear: nothing needs action"));
    expect(banner.className).toMatch(/emerald/);
    expect(screen.getByText("Waiting for a Signature")).toBeInTheDocument();
  });

  it("loading and failed states are neutral on the banner too, never a false zero", async () => {
    renderAt("/", "manager", () => json(500, { error: { code: "internal", message: "Synthetic failure" } }));
    const banner = await screen.findByTestId("action-needed-banner");
    await waitFor(() => expect(banner).toHaveTextContent("Unable to check"));
    expect(banner.className).not.toMatch(/emerald|text-red/);
    expect(banner).not.toHaveTextContent(/all clear|: 0/i);
  });

  it("a viewer without the billing permission has no Ready for Approval category and it adds nothing", async () => {
    renderAt("/", "manager", () => json(200, { summary: { ...summary(0), missingTimeOut: 2, billingReadyUnapproved: null, uncoveredShifts: null, documentsBlocking: null, documentsToReview: null } }));
    expect(await screen.findByRole("link", { name: "Action needed: 2" })).toBeInTheDocument();
    expect(screen.queryByText("Ready for Approval")).toBeNull();
  });
});
