// Token links: the token lives in the URL fragment (never sent to the web
// server / CloudFront logs) and public calls carry no Authorization header.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createAwsApiClient, createAwsPublicApiClient } from "@/lib/aws-api";
import { PublicCareOfferPage, PublicCareRequestPage } from "./care-public-pages";

vi.mock("@/providers/organization-provider", () => ({ useOrganization: () => ({ activeOrganizationId: "aaaaaaaa-0000-4000-8000-000000000001" }) }));
import { CareRequestsPage } from "./care-requests-page";

const TOKEN = "cd".repeat(32);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function harness(handler: (url: URL, init: RequestInit) => Response) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function renderAt(path: string, element: JSX.Element, routePath: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Routes>
          <Route path={routePath} element={element} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("public care links", () => {
  it("reads the portal token from the fragment and calls the API anonymously", async () => {
    const h = harness(() => json({ services: [{ organizationName: "Synthetic Care Co", clientCode: "TEST-C01", serviceId: "s1", serviceCode: "RSP", serviceName: "Respite", periodEnd: "2026-12-31" }] }));
    renderAt("/care#" + TOKEN, <PublicCareRequestPage api={createAwsPublicApiClient("https://api.example.test", h.fetchImpl)} />, "/care");
    expect(await screen.findByText(/Synthetic Care Co/)).toBeInTheDocument();
    expect(h.calls[0]!.url.pathname).toBe("/v1/public/care-portals/" + TOKEN);
    expect((h.calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("a token in the path (old format) or a malformed fragment is not accepted and nothing is called", async () => {
    const h = harness(() => json({}));
    renderAt("/care/" + TOKEN, <PublicCareRequestPage api={createAwsPublicApiClient("https://api.example.test", h.fetchImpl)} />, "/care/*");
    renderAt("/care#not-a-token", <PublicCareRequestPage api={createAwsPublicApiClient("https://api.example.test", h.fetchImpl)} />, "/care");
    expect(await screen.findAllByText(/invalid or no longer active/)).toHaveLength(2);
    expect(h.calls).toHaveLength(0);
  });

  it("a revoked/expired link (API 404) shows the invalid-link message", async () => {
    const h = harness(() => json({ error: { code: "not_found", message: "This link is not valid or is no longer active" } }, 404));
    renderAt("/care-offer#" + TOKEN, <PublicCareOfferPage api={createAwsPublicApiClient("https://api.example.test", h.fetchImpl)} />, "/care-offer");
    expect(await screen.findByText(/invalid or no longer active/)).toBeInTheDocument();
  });
});

describe("staff care-request page link handling", () => {
  it("creates fragment links and can revoke a client's links", async () => {
    const h = harness((url, init) => {
      if (url.pathname === "/v1/care-portals/clients") return json({ clients: [{ clientId: "c1", clientCode: "TEST-C01" }] });
      if (url.pathname === "/v1/care-portals" && init.method === "POST") return json({ portal: { portalId: "p1", token: TOKEN } }, 201);
      if (url.pathname === "/v1/care-portals/revoke") return json({ revoked: 1 });
      if (url.pathname === "/v1/care-requests") return json({ requests: [] });
      if (url.pathname === "/v1/care-notifications") return json({ notifications: [] });
      if (url.pathname === "/v1/care-alert-staff") return json({ staff: [] });
      return json({});
    });
    const api = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: async () => "synthetic", fetch: h.fetchImpl });
    renderAt("/care-requests", <CareRequestsPage api={api} />, "/care-requests");
    const select = await screen.findByDisplayValue("Select client");
    await screen.findByRole("option", { name: "TEST-C01" });
    fireEvent.change(select, { target: { value: "c1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create request link" }));
    await waitFor(() => expect(screen.getByDisplayValue(window.location.origin + "/care#" + TOKEN)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Revoke this client's links" }));
    expect(await screen.findByRole("status")).toHaveTextContent("1 link(s) revoked");
    const revoke = h.calls.find((c) => c.url.pathname === "/v1/care-portals/revoke")!;
    expect(JSON.parse(String(revoke.init.body))).toEqual({ organizationId: "aaaaaaaa-0000-4000-8000-000000000001", clientId: "c1" });
  });
});
