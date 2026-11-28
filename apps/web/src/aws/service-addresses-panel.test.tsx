// 0126: the service address panel. SYNTHETIC data. The API is a recorder: the screen must send the right request for each action and show every state in plain words.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/aws-api";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CLIENT = "cccccccc-0000-4000-8000-000000000001";
type Call = { method: string; path: string; body?: Record<string, unknown> };
let calls: Call[] = [];
let addresses: Array<Record<string, unknown>> = [];
let legacy = false;
let failPost: ((c: Call) => Error | null) | null = null;
let history: Array<Record<string, unknown>> = [];

const api = {
  get: vi.fn(async (path: string) => {
    calls.push({ method: "GET", path });
    if (path.endsWith("/service-addresses")) { if (legacy) throw new ApiRequestError(404, "not_found", "No such endpoint."); return { addresses }; }
    if (path.endsWith("/service-addresses/history")) return { history };
    if (path.endsWith("/service-locations")) return { locations: addresses.filter((a) => a.addressState === "current" || a.addressState === undefined) };
    return {};
  }),
  post: vi.fn(async (path: string, body?: Record<string, unknown>) => { const c = { method: "POST", path, ...(body ? { body } : {}) }; calls.push(c); const e = failPost?.(c); if (e) throw e; return {}; }),
};
vi.mock("./aws-workspace", () => ({ useAwsApi: () => api }));
vi.mock("@/providers/organization-provider", () => ({ useOrganization: () => ({ activeOrganizationId: ORG, hasPermission: () => true, activeOrganization: null }) }));
vi.mock("./home-labels-data", async (orig) => ({ ...(await orig<typeof import("./home-labels-data")>()), useHomeLabelsAvailable: () => ({ available: true }) }));
import { HomeLabelsPanel } from "./home-labels-panel";

const addr = (over: Record<string, unknown>) => ({ locationId: "l-x", kind: "home", name: "Client home", street: "1 Synthetic Way", city: "Synthetictown", state: "CA", zip: "90001", geoStatus: "located", needsAttention: false, radiusM: 150,
  isCurrent: false, addressState: "alternate", inactiveAt: "2026-11-20T10:00:00Z", inactiveReason: "Added while another address is current", labelId: null, labelCode: null, labelInstalledAt: null, canDelete: true, ...over });
function show() {
  render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><HomeLabelsPanel clientId={CLIENT} /></QueryClientProvider></MemoryRouter>);
}
afterEach(() => { cleanup(); calls = []; addresses = []; legacy = false; failPost = null; history = []; vi.clearAllMocks(); });

describe("service address states", () => {
  it("shows current and alternate in words, the one-current rule, and a sticker note that says it only works when current", async () => {
    addresses = [addr({ locationId: "l-a", addressState: "current", isCurrent: true, inactiveAt: null, inactiveReason: null, street: "10 Parent One Rd", canDelete: true }),
      addr({ locationId: "l-b", street: "20 Parent Two Ave", labelId: "lab1", labelCode: "OGL-7K3M9XQ2", labelInstalledAt: "2026-11-21T10:00:00Z", canDelete: false })];
    show();
    const rows = await screen.findAllByTestId("location-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Current address");
    expect(rows[1]).toHaveTextContent("Alternate (not current)");
    expect(screen.getByTestId("address-rule")).toHaveTextContent(/Only one home address is current at a time/);
    expect(rows[1]).toHaveTextContent(/only works when this address is the current one/);
    expect(within(rows[1]!).getByRole("button", { name: "Make this the current address" })).toBeInTheDocument();
    expect(within(rows[1]!).queryByRole("button", { name: /Delete/ })).toBeNull();          // it has had a sticker: no delete
    expect(within(rows[0]!).getByRole("button", { name: /Delete \(entered by mistake\)/ })).toBeInTheDocument();
  });

  it("making an address current sends one request and refreshes; a failure is shown in plain words", async () => {
    addresses = [addr({ locationId: "l-a", addressState: "current", isCurrent: true, inactiveAt: null, inactiveReason: null }), addr({ locationId: "l-b" })];
    show();
    const rows = await screen.findAllByTestId("location-row");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Make this the current address" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toBeTruthy());
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: "/v1/service-locations/l-b/state", body: { organizationId: ORG, state: "active" } });
    failPost = () => new Error("You do not have permission to manage client locations");
    fireEvent.click(within((await screen.findAllByTestId("location-row"))[1]!).getByRole("button", { name: "Make this the current address" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent(/permission/);
  });

  it("marking the current address inactive needs a reason, asks alternate or historical, and warns that sticker clock-in is refused meanwhile", async () => {
    addresses = [addr({ locationId: "l-a", addressState: "current", isCurrent: true, inactiveAt: null, inactiveReason: null })];
    show();
    const row = (await screen.findAllByTestId("location-row"))[0]!;
    fireEvent.click(within(row).getByRole("button", { name: "Mark inactive…" }));
    expect(within(row).getByText(/no current address until you make another one current/)).toBeInTheDocument();
    const save = within(row).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.click(within(row).getByLabelText(/Historical/));
    fireEvent.change(within(row).getByLabelText(/Reason/), { target: { value: "Moved out" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toBeTruthy());
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: "/v1/service-locations/l-a/state", body: { organizationId: ORG, state: "historical", reason: "Moved out" } });
  });

  it("an address entered by mistake can be deleted with a reason; the words say why it is allowed", async () => {
    addresses = [addr({ locationId: "l-w", addressState: "current", isCurrent: true, inactiveAt: null, inactiveReason: null, street: "999 Wrong St" })];
    show();
    const row = (await screen.findAllByTestId("location-row"))[0]!;
    fireEvent.click(within(row).getByRole("button", { name: /Delete \(entered by mistake\)/ }));
    expect(within(row).getByText(/only possible because this address never had a sticker/)).toBeInTheDocument();
    const go = within(row).getByRole("button", { name: "Delete this address" });
    expect(go).toBeDisabled();
    fireEvent.change(within(row).getByLabelText(/Reason/), { target: { value: "Typed the wrong street" } });
    fireEvent.click(go);
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toBeTruthy());
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: "/v1/service-locations/l-w/delete", body: { organizationId: ORG, reason: "Typed the wrong street" } });
  });

  it("a historical address shows it has no sticker, can be used again, and cannot take a sticker or be deleted", async () => {
    addresses = [addr({ locationId: "l-h", addressState: "historical", inactiveReason: "Moved out", canDelete: false })];
    show();
    const row = (await screen.findAllByTestId("location-row"))[0]!;
    expect(row).toHaveTextContent("Historical (no longer used)");
    expect(row).toHaveTextContent("Moved out");
    expect(within(row).queryByRole("button", { name: "Assign a sticker" })).toBeNull();
    expect(within(row).queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(within(row).getByRole("button", { name: "Use this address again" })).toBeInTheDocument();
  });

  it("the history list opens on request, newest first as the API returns it, shows the previous address of an edit and no address text for a deleted one", async () => {
    addresses = [addr({ locationId: "l-a", addressState: "current", isCurrent: true, inactiveAt: null, inactiveReason: null })];
    history = [
      { occurredAt: "2026-11-25T10:00:00Z", action: "deleted", actorName: "Synthetic Admin", reason: "Typed the wrong street", locationId: "l-w", details: { kind: "home" } },
      { occurredAt: "2026-11-24T10:00:00Z", action: "updated", actorName: "Synthetic Admin", reason: null, locationId: "l-a", details: { before: { street: "10 Old Street", city: "Synthetictown", zip: "90001" }, city: "Synthetictown", zip: "90001" } },
      { occurredAt: "2026-11-20T10:00:00Z", action: "created", actorName: null, reason: null, locationId: "l-w", details: { scrubbed: true } },
    ];
    show();
    await screen.findAllByTestId("location-row");
    expect(screen.queryByTestId("address-history")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show address history" }));
    const list = await screen.findByTestId("address-history");
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    expect(list).toHaveTextContent("Address deleted");
    expect(list).toHaveTextContent("Reason: Typed the wrong street");
    expect(list).toHaveTextContent("was 10 Old Street, Synthetictown 90001");
    expect(list).not.toHaveTextContent("999");
  });

  it("where the switch is off the earlier list is used, no address controls or rule appear, and the page still works", async () => {
    legacy = true;
    addresses = [addr({ locationId: "l-a", addressState: undefined })];
    show();
    const row = (await screen.findAllByTestId("location-row"))[0]!;
    expect(row).toHaveAttribute("data-state", "legacy");
    expect(screen.queryByTestId("address-controls")).toBeNull();
    expect(screen.queryByTestId("address-rule")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show address history" })).toBeNull();
    expect(within(row).getByRole("button", { name: "Assign a sticker" })).toBeInTheDocument();
    expect(calls.map((c) => c.path)).toEqual(expect.arrayContaining([`/v1/clients/${CLIENT}/service-addresses`, `/v1/clients/${CLIENT}/service-locations`]));
  });
});
