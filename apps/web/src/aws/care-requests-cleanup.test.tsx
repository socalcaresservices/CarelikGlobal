// Owner screenshots 2026-11-17: a cancelled request counted as open, the "new alerts" pill could not be opened or cleared.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createAwsPublicApiClient } from "@/lib/aws-api";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: () => ({ activeOrganizationId: "aaaaaaaa-0000-4000-8000-000000000001" }) }));
import { CareRequestsPage } from "./care-requests-page";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const REQ = (requestId: string, status: string, clientName: string) => ({
  requestId, status, clientCode: "C-" + requestId, clientName, serviceCode: "RSP", serviceName: "Respite", startsAt: "2026-11-15T18:00:00Z", endsAt: "2026-11-15T23:00:00Z",
  requestedMinutes: 300, shortNotice: true, availableCount: 0, awaitingCount: 0, assignedCaregiverName: null,
});

function setup(opts: { requests: unknown[]; notifications?: unknown[]; readStatus?: number }) {
  const posts: Array<{ path: string; body: unknown }> = [];
  let notifications = opts.notifications ?? [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      posts.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
      if (url.pathname === "/v1/care-notifications/read") {
        if (opts.readStatus === 404) return json({ message: "Not Found" }, 404);
        notifications = []; return json({ marked: 2 });
      }
      return json({});
    }
    if (url.pathname === "/v1/care-requests") return json({ requests: opts.requests });
    if (url.pathname === "/v1/care-notifications") return json({ notifications });
    if (url.pathname.endsWith("/offers")) return json({ offers: [] });
    if (url.pathname === "/v1/care-alert-staff") return json({ staff: [] });
    if (url.pathname === "/v1/care-portals/clients") return json({ clients: [] });
    return json({});
  }) as unknown as typeof fetch;
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CareRequestsPage api={createAwsPublicApiClient("https://api.example.test", fetchImpl)} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { posts };
}

describe("care requests: closed requests are folded away", () => {
  it("a cancelled request is not counted or listed as needing action; it is under Closed and opens read-only", async () => {
    setup({ requests: [REQ("r1", "client_cancelled", "Conner Walker")] });
    expect(await screen.findByText(/No requests need action/)).toBeInTheDocument();
    expect(screen.getByText(/1 closed request is under Closed/)).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Request queue" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Closed 1" }));
    const table = await screen.findByRole("table", { name: "Request queue" });
    expect(within(table).getByText(/Conner Walker/)).toBeInTheDocument();
    fireEvent.click(within(table).getByRole("button", { name: "Open" }));
    expect(await screen.findByText(/Nothing to match or assign/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Matches" })).toBeNull();
  });

  it("an open request is listed under Needs action by default and counted", async () => {
    setup({ requests: [REQ("r1", "requested", "Ann Open"), REQ("r2", "client_cancelled", "Bea Closed")] });
    expect(await screen.findByText(/1 request needs action, 1 short notice/)).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "Request queue" });
    expect(within(table).getByText(/Ann Open/)).toBeInTheDocument();
    expect(within(table).queryByText(/Bea Closed/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All 2" }));
    expect(await within(screen.getByRole("table", { name: "Request queue" })).findByText(/Bea Closed/)).toBeInTheDocument();
  });
});

describe("care requests: the new-alerts pill opens and clears", () => {
  const notifications = [
    { notificationId: "n1", careRequestId: "r1", eventKey: "client_cancelled_short_notice", createdAt: "2026-11-15T13:00:00Z" },
    { notificationId: "n2", careRequestId: "r1", eventKey: "care_request_created", createdAt: "2026-11-15T12:00:00Z" },
  ];
  it("the pill is a button that lists each alert with its request; Mark all read clears them", async () => {
    const { posts } = setup({ requests: [REQ("r1", "client_cancelled", "Conner Walker")], notifications });
    fireEvent.click(await screen.findByRole("button", { name: "2 new alerts" }));
    const list = screen.getByLabelText("New alerts");
    expect(within(list).getByText("Client cancelled (short notice)")).toBeInTheDocument();
    expect(within(list).getAllByText(/Conner Walker/).length).toBe(2);
    fireEvent.click(within(list).getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(posts).toContainEqual({ path: "/v1/care-notifications/read", body: { organizationId: "aaaaaaaa-0000-4000-8000-000000000001", ids: null } }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /new alert/ })).toBeNull());
  });
  it("before the release switch is on, clearing says it is not available yet instead of failing silently", async () => {
    setup({ requests: [REQ("r1", "requested", "Conner Walker")], notifications, readStatus: 404 });
    fireEvent.click(await screen.findByRole("button", { name: "2 new alerts" }));
    fireEvent.click(within(screen.getByLabelText("New alerts")).getAllByRole("button", { name: "Mark read" })[0]!);
    expect(await screen.findByRole("alert")).toHaveTextContent("not available in this environment yet");
  });
});
