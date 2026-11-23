// Client directory: List and Cards views, remembered per signed-in person; same rows, search, filters, sort and access in
// both. In-memory fake of the AWS API. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";
import type { AdminClient } from "./client-admin";
import { defaultView, filterClients, readViewPreference, sortClients, viewStorageKey, writeViewPreference } from "./client-view";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const PERSON_A = "11111111-2222-4333-8444-55555555aaaa";
const PERSON_B = "11111111-2222-4333-8444-55555555bbbb";
type Role = "caregiver" | "manager";

const client = (over: Partial<AdminClient> & { clientId: string; clientCode: string }): AdminClient => ({
  caregiverDisplayCode: null, status: "active", legalFirstName: "Synthetic", legalLastName: "Client", city: null, clientTypeId: null, clientTypeName: null, currentAuthorizations: 1, openVisits: 0, ...over,
});
const CLIENTS: AdminClient[] = [
  client({ clientId: "c1", clientCode: "CL-1111111111", legalLastName: "Charlie", currentAuthorizations: 1, city: "Riverside" }),
  client({ clientId: "c2", clientCode: "CL-2222222222", legalLastName: "Alpha", currentAuthorizations: 0 }),
  client({ clientId: "c3", clientCode: "CL-3333333333", legalLastName: "Bravo", currentAuthorizations: 2, openVisits: 1 }),
  client({ clientId: "c4", clientCode: "CL-4444444444", legalLastName: "Delta", status: "inactive", currentAuthorizations: 0 }),
];

function renderAt(role: Role, sub = PERSON_A) {
  const permissions = role === "manager" ? ["clients.manage", "clients.names.manage", "clients.names.read", "visits.read"] : ["availability.manage_own"];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    switch (`${init?.method ?? "GET"} ${url.pathname}`) {
      case "GET /v1/me": return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role, permissions }], profile: { displayName: "Synthetic Person" } });
      case "GET /v1/branding": return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "GET /v1/attention": return json(200, { summary: null });
      case "GET /v1/clients": return json(200, { clients: CLIENTS });
      case "GET /v1/client-types": return json(200, { clientTypes: [] });
      default: return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  const auth = {
    subscribe: vi.fn(() => () => {}),
    getSession: vi.fn(async () => ({ user: { id: sub, email: "person@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn(),
  };
  const api = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: fetchImpl as never });
  render(
    <MemoryRouter initialEntries={["/clients"]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}>
          <AwsRoutes api={api} publicApi={api} />
        </CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const wide = (isWide: boolean) => { window.matchMedia = ((q: string) => ({ matches: isWide, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never; };
const COLD = 15_000;
const names = (el: HTMLElement) => within(el).getAllByText(/Synthetic (Alpha|Bravo|Charlie|Delta)|Alpha|Bravo|Charlie|Delta/).map((n) => n.textContent ?? "");

beforeEach(() => { window.localStorage.clear(); wide(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("helpers", () => {
  it("defaults to List on a wide screen and Cards on a phone", () => {
    expect(defaultView(true)).toBe("list");
    expect(defaultView(false)).toBe("cards");
  });
  it("saves and reads the view per person; ignores junk; survives blocked storage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(writeViewPreference(PERSON_A, "cards", storage)).toBe(true);
    expect(readViewPreference(PERSON_A, storage)).toBe("cards");
    expect(readViewPreference(PERSON_B, storage)).toBeNull();
    store.set(viewStorageKey(PERSON_B), "<script>");
    expect(readViewPreference(PERSON_B, storage)).toBeNull();
    expect(readViewPreference(null, storage)).toBeNull();
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readViewPreference(PERSON_A, blocked)).toBeNull();
    expect(writeViewPreference(PERSON_A, "list", blocked)).toBe(false);
    expect(writeViewPreference(PERSON_A, "list", null)).toBe(false);
  });
  it("one set of rules for both views: filter, then sort (none-first by authorization)", () => {
    expect(filterClients(CLIENTS, { search: "", status: "active", authorization: "none" }).map((c) => c.clientId)).toEqual(["c2"]);
    expect(filterClients(CLIENTS, { search: "riverside", status: "all", authorization: "all" }).map((c) => c.clientId)).toEqual(["c1"]);
    expect(filterClients(CLIENTS, { search: "CL-3333", status: "all", authorization: "current" }).map((c) => c.clientId)).toEqual(["c3"]);
    expect(sortClients(CLIENTS, "name").map((c) => c.clientId)).toEqual(["c2", "c3", "c1", "c4"]);
    expect(sortClients(CLIENTS, "status").map((c) => c.clientId)).toEqual(["c2", "c3", "c1", "c4"]);
    expect(sortClients(CLIENTS, "authorization").map((c) => c.clientId)).toEqual(["c2", "c4", "c3", "c1"]);
  });
});

describe("Clients page views", () => {
  it("wide screen with no saved choice opens as List, sorted by name, with status and authorization columns and one action per row", async () => {
    renderAt("manager");
    const table = await screen.findByRole("table", { name: "Clients as a list" }, { timeout: COLD });
    expect(within(table).getAllByRole("row").slice(1).map((r) => r.querySelector("th")?.textContent)).toEqual([
      expect.stringContaining("Alpha"), expect.stringContaining("Bravo"), expect.stringContaining("Charlie"),
    ]); // Active only by default: Delta is inactive
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Cards" })).toHaveAttribute("aria-pressed", "false");
    const alpha = within(table).getByRole("row", { name: /Alpha/ });
    expect(within(alpha).getByText("None current")).toBeInTheDocument();
    expect(within(alpha).getByRole("link", { name: /Add authorized hours/ })).toHaveTextContent("Add authorized hours →");
    expect(within(table).getByRole("row", { name: /Bravo/ })).toHaveTextContent("2 current authorizations");
  });

  it("the list has a No. column numbered 1..n in the order shown, renumbered when the filter changes", async () => {
    renderAt("manager");
    const table = await screen.findByRole("table", { name: "Clients as a list" }, { timeout: COLD });
    expect(within(table).getAllByRole("columnheader")[0]).toHaveTextContent("No.");
    expect(within(table).getAllByTestId("row-no").map((c) => c.textContent)).toEqual(["1", "2", "3"]);
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "none" } });
    const filtered = screen.getByRole("table", { name: "Clients as a list" });
    expect(within(filtered).getAllByTestId("row-no").map((c) => c.textContent)).toEqual(["1", "2"]);   // Alpha, Delta: numbered from 1 again
    expect(within(filtered).getAllByRole("row").slice(1).map((r) => r.querySelector("td")?.textContent)).toEqual(["1", "2"]);
  });

  it("phone width with no saved choice opens as Cards", async () => {
    wide(false);
    renderAt("manager");
    expect(await screen.findByRole("list", { name: "Clients as cards" }, { timeout: COLD })).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Clients as a list" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cards" })).toHaveAttribute("aria-pressed", "true");
  });

  it("choosing Cards is saved for this signed-in person, reopens as Cards, and another person on the device is not affected", async () => {
    renderAt("manager", PERSON_A);
    await screen.findByRole("table", { name: "Clients as a list" }, { timeout: COLD });
    fireEvent.click(screen.getByRole("button", { name: "Cards" }));
    expect(await screen.findByRole("list", { name: "Clients as cards" })).toBeInTheDocument();
    expect(window.localStorage.getItem(viewStorageKey(PERSON_A))).toBe("cards");
    expect(window.localStorage.getItem(viewStorageKey(PERSON_B))).toBeNull();
    cleanup();
    renderAt("manager", PERSON_A);
    expect(await screen.findByRole("list", { name: "Clients as cards" }, { timeout: COLD })).toBeInTheDocument();
    cleanup();
    renderAt("manager", PERSON_B);
    expect(await screen.findByRole("table", { name: "Clients as a list" }, { timeout: COLD })).toBeInTheDocument();
  });

  it("both views show the same clients for the same search, status, authorization filter and sort", async () => {
    renderAt("manager");
    await screen.findByRole("table", { name: "Clients as a list" }, { timeout: COLD });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Authorization"), { target: { value: "none" } });
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "name" } });
    const list = screen.getByRole("table", { name: "Clients as a list" });
    const inList = within(list).getAllByRole("row").slice(1).map((r) => r.querySelector("th")?.textContent?.match(/Alpha|Bravo|Charlie|Delta/)?.[0]); // names, not codes, in the administrator list
    expect(inList).toEqual(["Alpha", "Delta"]);
    fireEvent.click(screen.getByRole("button", { name: "Cards" }));
    const cards = await screen.findByRole("list", { name: "Clients as cards" });
    const inCards = within(cards).getAllByRole("listitem").map((r) => r.textContent?.match(/Alpha|Bravo|Charlie|Delta/)?.[0]);
    expect(inCards).toEqual(inList);
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "delta" } });
    expect(within(await screen.findByRole("list", { name: "Clients as cards" })).getAllByRole("listitem")).toHaveLength(1);
    expect(names(screen.getByRole("list", { name: "Clients as cards" }))[0]).toMatch(/Delta/);
  });

  it("still works when browser storage is blocked: the view changes, nothing is saved, nothing breaks", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    renderAt("manager");
    await screen.findByRole("table", { name: "Clients as a list" }, { timeout: COLD });
    fireEvent.click(screen.getByRole("button", { name: "Cards" }));
    expect(await screen.findByRole("list", { name: "Clients as cards" })).toBeInTheDocument();
  });

  it("a person without access to client names sees no list in either view and no view switch", async () => {
    renderAt("caregiver");
    expect(await screen.findByText("You do not have access to client records.", undefined, { timeout: COLD })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cards" })).toBeNull();
    expect(screen.queryByText(/Alpha|Bravo|Charlie/)).toBeNull();
    await waitFor(() => expect(screen.queryByRole("table")).toBeNull());
  });
});
