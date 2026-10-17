/* eslint-disable @typescript-eslint/no-explicit-any -- a test double: request bodies and appearance fixtures are free-form JSON */
// Interface simplification (migration 0054 + web): document cards, financial empty states, appearance preferences, charts. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";
import { documentStatusLabel, isDueSoon, isOverdue, matchesFilter, type StaffDocument } from "./document-status";
import { financeView } from "./finance-view";
import type { UtilisationRow } from "./aws-workspace";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const USER = "11111111-2222-4333-8444-555555555555";
type Role = "manager" | "organization_owner" | "caregiver";
const PERMS: Record<Role, string[]> = {
  manager: ["visits.read", "visits.manage", "documents.read", "documents.manage", "caregivers.manage", "shifts.manage", "authorizations.read"],
  organization_owner: ["visits.read", "visits.manage", "documents.read", "documents.manage", "documents.requirements.manage", "billing.read", "organization.update", "caregivers.manage", "shifts.manage", "authorizations.read"],
  caregiver: ["documents.manage_own", "availability.manage_own"],
};
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });

const doc = (over: Partial<StaffDocument> = {}): StaffDocument => ({
  documentId: "d1", caregiverRecordId: "r1", personName: "Pilot Caregiver A", documentTypeId: "t1", documentTypeName: "CPR card", requiresExpiry: true, dueOn: null,
  latestVersionId: "v1", latestVersionNumber: 2, latestContentType: "application/pdf", latestUploadedAt: "2026-10-02T17:00:00Z", latestReviewStatus: "verified", latestRejectionReason: null,
  issuedOn: "2025-10-01", expiresOn: "2027-10-01", verifiedExpiresOn: "2027-10-01", displayStatus: "verified", daysUntil: 300, reviewState: "verified", currencyStatus: "current",
  reviewedByName: "Synthetic Owner", reviewedAt: "2026-10-03T17:00:00Z", reminderDays: [90, 60, 30], reminderStage: null, ...over,
});
const DOCS = [
  doc(),
  doc({ documentId: "d2", documentTypeName: "TB test", displayStatus: "expiring", daysUntil: 12, verifiedExpiresOn: "2026-10-30", currencyStatus: "expiring", reminderStage: 30 }),
  doc({ documentId: "d3", documentTypeName: "First aid", displayStatus: "expired", daysUntil: -3, verifiedExpiresOn: "2026-10-12", currencyStatus: "expired" }),
  doc({ documentId: "d4", documentTypeName: "Driver license", displayStatus: "overdue", dueOn: "2026-10-10", daysUntil: -5, latestVersionId: null, latestVersionNumber: null, latestUploadedAt: null, latestReviewStatus: null, verifiedExpiresOn: null, reviewState: "overdue", currencyStatus: "not_verified", reviewedByName: null, reviewedAt: null }),
  doc({ documentId: "d5", documentTypeName: "Training", displayStatus: "awaiting_review", latestReviewStatus: "awaiting_review", reviewState: "awaiting_review", currencyStatus: "not_verified", reviewedByName: null, reviewedAt: null }),
];

const ROW: UtilisationRow = {
  serviceId: "s1", serviceCode: "862", serviceName: "Respite Care", clientCount: 2, authorizedMinutes: 6000, scheduledMinutes: 240, workedMinutes: 1590, billableMinutes: 1470, reviewMinutes: 120,
  approvedMinutes: 0, remainingMinutes: 4530, lineagesWithoutRate: 0, billableValueCents: null, approvedValueCents: null, unusedValueCents: null,
};

interface Setup { role: Role; rows?: UtilisationRow[]; appearance?: Record<string, unknown>; missingRate?: Record<string, unknown>[] }
function renderApp(path: string, { role, rows = [ROW], appearance, missingRate = [] }: Setup) {
  const calls: { method: string; path: string; body: any }[] = [];
  let state = { organization: { background: null, accent: null, density: null, textSize: null, chartType: null }, mine: { background: null, accent: null, density: null, textSize: null, chartType: null }, ...appearance } as any;
  const system = { background: "light", accent: "teal", density: "comfortable", textSize: "standard", chartType: "bar" };
  const view = () => {
    const effective = { ...system } as any;
    for (const level of [state.organization, state.mine]) for (const [k, v] of Object.entries(level)) if (v) effective[k] = v;
    return { appearance: { system, organization: state.organization, mine: state.mine, effective, canSetOrganizationDefaults: PERMS[role].includes("organization.update") } };
  };
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method: init?.method ?? "GET", path: url.pathname + url.search, body });
    switch (`${init?.method ?? "GET"} ${url.pathname}`) {
      case "GET /v1/me": return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role, permissions: PERMS[role] }], profile: { displayName: "Synthetic Person" } });
      case "GET /v1/branding": return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "GET /v1/attention/overview": return json(200, { overview: { asOf: "2026-10-18T12:00:00Z", urgentWindowHours: 24,
        urgent: { items: [], itemCount: 0, issueCount: 0, shifts: 0, visits: 0 }, upcoming: { count: 0, nextStartsAt: null, shifts: [] },
        documents: { overdue: 2, dueSoon: 1, awaitingReview: 1, rejected: 0, caregiversOnHold: 1, caregiversWithPendingRequirements: 0 },
        visitReview: { visitsNeedingAttention: 0, awaitingConfirmation: 0, needsReview: 0, lateResponses: 0, readyForApproval: null, reviewIssues: 0, awaitingResponse: 0 } } });
      case "GET /v1/reports/utilisation": return json(200, { services: rows });
      case "GET /v1/documents": return json(200, { documents: DOCS });
      case "GET /v1/document-types": return json(200, { types: [] });
      case "GET /v1/documents/people": return json(200, { people: [] });
      case "GET /v1/document-requirements": return json(200, { setup: { requirements: [] } });
      case "GET /v1/continuity/status": return json(200, { status: null });
      case "GET /v1/authorizations/missing-rate": return json(200, { authorizations: missingRate });
      case "GET /v1/appearance": return json(200, view());
      case "POST /v1/appearance/me": state = { ...state, mine: { background: body.background ?? null, accent: body.accent ?? null, density: body.density ?? null, textSize: body.textSize ?? null, chartType: body.chartType ?? null } }; return json(200, view());
      case "POST /v1/appearance/organization": state = { ...state, organization: { background: body.background ?? null, accent: body.accent ?? null, density: body.density ?? null, textSize: body.textSize ?? null, chartType: body.chartType ?? null } }; return json(200, view());
      default: return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  const auth = { subscribe: vi.fn(() => () => {}), getSession: vi.fn(async () => ({ user: { id: USER, email: "p@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn() };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: fetchImpl as never });
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}><AwsRoutes api={client} publicApi={client} /></CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { calls };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => { cleanup(); vi.clearAllMocks(); for (const a of ["bg", "accent", "density", "text"]) document.documentElement.removeAttribute(`data-og-${a}`); });

describe("document status rules", () => {
  it("one short label, with the tone that says whether it blocks", () => {
    expect(documentStatusLabel(DOCS[0]!)).toEqual({ label: "Current", tone: "neutral" });
    expect(documentStatusLabel(DOCS[1]!)).toEqual({ label: "Expires in 12 days", tone: "amber" });
    expect(documentStatusLabel(DOCS[2]!)).toEqual({ label: "Expired 3 days ago", tone: "red" });
    expect(documentStatusLabel(DOCS[3]!)).toEqual({ label: "Overdue 5 days", tone: "red" });
    expect(documentStatusLabel(DOCS[4]!)).toEqual({ label: "Awaiting review", tone: "neutral" });
  });
  it("Due soon and Overdue are separate: expired and overdue are blocking, expiring is not", () => {
    expect(DOCS.filter(isOverdue).map((d) => d.documentId)).toEqual(["d3", "d4"]);
    expect(DOCS.filter(isDueSoon).map((d) => d.documentId)).toEqual(["d2"]);
    expect(DOCS.filter((d) => matchesFilter(d, "to_review")).map((d) => d.documentId)).toEqual(["d5"]);
    expect(DOCS.filter((d) => matchesFilter(d, "all"))).toHaveLength(5);
  });
});

describe("Documents & compliance page", () => {
  it("each card keeps the name, caregiver, one status label, View and Replace; the rest is behind Details", async () => {
    renderApp("/documents", { role: "manager" });
    expect(await screen.findByRole("heading", { name: "Documents & compliance" })).toBeInTheDocument();
    const card = (await screen.findByText("TB test", { selector: "p" })).closest("li")!;
    expect(within(card).getByText("Pilot Caregiver A")).toBeInTheDocument();
    expect(within(card).getByText("Expires in 12 days")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "View" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Replace" })).toBeInTheDocument();
    expect(card).not.toHaveTextContent("Open file");
    expect(card).not.toHaveTextContent("Upload a new version");
    // Reviewer, review time, upload time, version and the exact date are in the details, which are closed until opened.
    const details = card.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details).toHaveTextContent("Synthetic Owner");
    expect(details).toHaveTextContent("Version 2");
    expect(details).toHaveTextContent("Expires 10/30/2026 (12 days left)");
    expect(details).toHaveTextContent("Earlier versions are kept");
    // The visible part (outside details) carries no reviewer or timestamp text.
    const clone = card.cloneNode(true) as HTMLElement;
    clone.querySelector("details")!.remove();
    expect(clone).not.toHaveTextContent("Synthetic Owner");
    expect(clone).not.toHaveTextContent("uploaded");
  });

  it("the Details control is a native keyboard-operable summary, not hover", async () => {
    renderApp("/documents", { role: "manager" });
    const card = (await screen.findByText("TB test", { selector: "p" })).closest("li")!;
    const summary = card.querySelector("summary")!;
    expect(summary.tagName).toBe("SUMMARY");
    expect(summary.className).toMatch(/min-h-\[44px\]/);
    expect(card.innerHTML).not.toMatch(/onmouse|title=/);
  });

  it("filters: All, Overdue, Due soon, To review each list their own documents, with counts", async () => {
    renderApp("/documents", { role: "manager" });
    await screen.findByText("TB test", { selector: "p" });
    const group = screen.getByRole("group", { name: "Show" });
    expect(within(group).getByRole("button", { name: /^All 5$/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).queryByRole("button", { name: /Needs action/ })).toBeNull();
    fireEvent.click(within(group).getByRole("button", { name: /^Overdue 2$/ }));
    expect(screen.getAllByRole("listitem").filter((li) => li.tagName === "LI" && li.querySelector("p.font-semibold")).map((li) => li.querySelector("p.font-semibold")!.textContent)).toEqual(["First aid", "Driver license"]);
    fireEvent.click(within(group).getByRole("button", { name: /^Due soon 1$/ }));
    expect(screen.queryByText("First aid", { selector: "p" })).toBeNull();
    expect(screen.getByText("TB test", { selector: "p" })).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("button", { name: /^To review 1$/ }));
    expect(screen.getByText("Training", { selector: "p" })).toBeInTheDocument();
  });

  it("blocking compliance is never hidden: an overdue card shows a red status with a word and symbol, and the strip links to the holds", async () => {
    renderApp("/documents", { role: "manager" });
    const card = (await screen.findByText("Driver license", { selector: "p" })).closest("li")!;
    const chip = within(card).getByText("Overdue 5 days").closest("span")!;
    expect(chip.className).toMatch(/red/);
    expect(chip).toHaveTextContent("●");
    const strip = await screen.findByTestId("compliance-strip");
    expect(strip).toHaveTextContent("1 caregiver is on a compliance hold");
    expect(within(strip).getByRole("link", { name: "Review compliance" })).toHaveAttribute("href", "/compliance");
  });

  it("a caregiver sees their own documents without management filters or review", async () => {
    renderApp("/documents", { role: "caregiver" });
    expect(await screen.findByRole("heading", { name: "My documents" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Show" })).toBeNull();
  });
});

describe("financial section", () => {
  it("rules: values are shown only when the server returned them; empty states say why; a missing rate is stated once", () => {
    const none = financeView([ROW]);
    expect(none.items.map((i) => [i.key, i.value, i.empty])).toEqual([["billable", null, null], ["approved", null, "Nothing approved yet"], ["unused", null, null]]);
    const noHours = financeView([{ ...ROW, billableMinutes: 0, remainingMinutes: 0 }]);
    expect(noHours.items.map((i) => i.empty)).toEqual(["No billable hours yet", "Nothing approved yet", "No unused hours"]);
    const valued = financeView([{ ...ROW, billableValueCents: 73500, approvedMinutes: 600, approvedValueCents: 30000, unusedValueCents: 226500, lineagesWithoutRate: 3 }]);
    expect(valued.items.map((i) => i.value)).toEqual(["$735", "$300", "$2,265"]);
    expect(valued.missingRates).toBe(3);
  });

  it("missing rates: one concise message with the count and a working action; no four Unavailable cards; no zero", async () => {
    renderApp("/", { role: "organization_owner", rows: [{ ...ROW, lineagesWithoutRate: 2 }] });
    const msg = await screen.findByTestId("missing-rate-message");
    expect(msg).toHaveTextContent("2 authorizations have no hourly rate");
    expect(within(msg).getByRole("link", { name: "Review authorizations" }).getAttribute("href")).toMatch(/^\/authorizations\/rates\?month=\d{4}-\d{2}$/);
    expect(screen.queryByText("Unavailable")).toBeNull();
    expect(screen.queryByText(/^\$0$/)).toBeNull();
    expect(screen.getByText("Nothing approved yet")).toBeInTheDocument();
  });

  it("the review page lists exactly what the API returned for that month, with the count", async () => {
    const { calls } = renderApp("/authorizations/rates?month=2026-10", { role: "organization_owner", missingRate: [
      { authorizationId: "a1", clientId: "c1", clientCode: "C-AAA111", clientName: "Synthetic Client", serviceCode: "862", serviceName: "Respite Care", payer: "Synthetic RC", periodStart: "2026-01-01", periodEnd: "2026-12-31", monthlyAuthorizedMinutes: 1800 },
      { authorizationId: "a2", clientId: "c2", clientCode: "C-BBB222", clientName: null, serviceCode: "862", serviceName: "Respite Care", payer: null, periodStart: "2026-01-01", periodEnd: "2026-12-31", monthlyAuthorizedMinutes: 600 }] });
    expect(await screen.findByTestId("missing-rate-count")).toHaveTextContent("2 authorizations to review");
    expect(screen.getAllByRole("link", { name: "Open client" }).map((a) => a.getAttribute("href"))).toEqual(["/clients/c1", "/clients/c2"]);
    expect(calls.find((c) => c.path.startsWith("/v1/authorizations/missing-rate"))!.path).toContain("monthStart=2026-10-01");
  });

  it("a manager gets no rate list", async () => {
    renderApp("/authorizations/rates", { role: "manager" });
    expect(await screen.findByText(/visible to the agency Administrator only/)).toBeInTheDocument();
  });
});

describe("appearance preferences", () => {
  it("a person saves their own view; it is applied to the page, remembered for the next first paint, and sent without the agency's", async () => {
    const { calls } = renderApp("/settings/appearance", { role: "manager" });
    expect(await screen.findByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Agency defaults" })).toBeNull(); // only administrators set agency defaults
    const mine = await screen.findByRole("form", { name: "My view" });
    for (const label of ["Warm cream", "Indigo", "Compact", "Large", "Donut"]) fireEvent.click(within(mine).getByLabelText(label));
    fireEvent.click(within(mine).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(document.documentElement.getAttribute("data-og-bg")).toBe("cream"));
    const post = calls.find((c) => c.method === "POST" && c.path === "/v1/appearance/me")!;
    expect(post.body).toMatchObject({ organizationId: ORG, background: "cream", accent: "indigo", density: "compact", textSize: "large", chartType: "donut" });
    expect(document.documentElement.getAttribute("data-og-accent")).toBe("indigo");
    expect(document.documentElement.getAttribute("data-og-density")).toBe("compact");
    expect(document.documentElement.getAttribute("data-og-text")).toBe("large");
    expect(window.localStorage.getItem(`ogevia.appearance.${USER}.${ORG}`)).toContain('"background":"cream"');
    expect(calls.some((c) => c.path === "/v1/appearance/organization")).toBe(false);
  });

  it("saved choices come back after a reload (read from the server)", async () => {
    renderApp("/", { role: "manager", appearance: { mine: { background: "dark", accent: "blue", density: null, textSize: null, chartType: null } } });
    await waitFor(() => expect(document.documentElement.getAttribute("data-og-bg")).toBe("dark"));
    expect(document.documentElement.getAttribute("data-og-accent")).toBe("blue");
    expect(document.documentElement.getAttribute("data-og-density")).toBe("comfortable");
  });

  it("agency defaults apply to everyone until a person chooses their own; the override affects only that person", async () => {
    renderApp("/", { role: "manager", appearance: { organization: { background: "gray", accent: "plum", density: "compact", textSize: null, chartType: null }, mine: { background: "cream", accent: null, density: null, textSize: null, chartType: null } } });
    await waitFor(() => expect(document.documentElement.getAttribute("data-og-bg")).toBe("cream")); // own choice wins
    expect(document.documentElement.getAttribute("data-og-accent")).toBe("plum"); // agency default fills the rest
    expect(document.documentElement.getAttribute("data-og-density")).toBe("compact");
  });

  it("an administrator also sees and saves Agency defaults, through the organization endpoint", async () => {
    const { calls } = renderApp("/settings/appearance", { role: "organization_owner" });
    const org = await screen.findByRole("form", { name: "Agency defaults" });
    fireEvent.click(within(org).getByLabelText("Soft gray"));
    fireEvent.click(within(org).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/v1/appearance/organization")).toBe(true));
    expect(calls.find((c) => c.path === "/v1/appearance/organization")!.body).toMatchObject({ organizationId: ORG, background: "gray" });
    await waitFor(() => expect(document.documentElement.getAttribute("data-og-bg")).toBe("gray"));
  });

  it("choices are labelled radio inputs, reachable by keyboard", async () => {
    renderApp("/settings/appearance", { role: "manager" });
    const mine = await screen.findByRole("form", { name: "My view" });
    expect(within(mine).getAllByRole("radio")).toHaveLength(5 + 6 + 3 + 3 + 4);
    expect(within(mine).getByRole("group", { name: "Background" })).toBeInTheDocument();
  });
});

describe("charts follow the preference only where honest, and keep data, labels, units and totals", () => {
  const rows = [ROW, { ...ROW, serviceId: "s2", serviceName: "Personal Care", serviceCode: "PC", workedMinutes: 600 }];
  const kinds = async (chartType: string) => {
    renderApp("/", { role: "manager", rows, appearance: { mine: { background: null, accent: null, density: null, textSize: null, chartType } } });
    return screen.findByLabelText("Worked hours by service");
  };

  it("bar (default): labels, hour values and the total", async () => {
    const chart = await kinds("bar");
    expect(chart).toHaveAttribute("data-chart-kind", "bar");
    expect(chart).toHaveTextContent("Total 36.5 h worked hours");
    expect(within(chart).getByRole("table", { name: "Worked hours by service" })).toHaveTextContent("26.5 h");
    expect(within(chart).queryByTestId("chart-note")).toBeNull();
  });

  it("donut: parts of a whole, same values, plus percentages", async () => {
    const chart = await kinds("donut");
    expect(chart).toHaveAttribute("data-chart-kind", "donut");
    expect(chart).toHaveTextContent("26.5 h · 73%");
    expect(chart).toHaveTextContent("10 h · 27%");
    expect(chart).toHaveTextContent("Total 36.5 h worked hours");
  });

  it("line is not honest for categories: shown as bars, and the chart says so", async () => {
    const chart = await kinds("line");
    expect(chart).toHaveAttribute("data-chart-kind", "bar");
    expect(within(chart).getByTestId("chart-note")).toHaveTextContent("Line charts show change over time");
    expect(chart).toHaveTextContent("Total 36.5 h worked hours");
  });
});
