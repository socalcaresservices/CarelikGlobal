/* eslint-disable @typescript-eslint/no-explicit-any -- a test double: request bodies are free-form JSON */
// Invitation email look (0114): editor, preview, validation, and the switch-off state. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const NORTH = "dddddddd-0000-4000-8000-000000000001";
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });

function renderOffices(opts: { on: boolean; perms?: string[] }) {
  const posts: Array<{ path: string; body: any }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === "POST") { posts.push({ path: url.pathname, body: JSON.parse(String(init.body)) }); return json(200, { branding: {} }); }
    switch (url.pathname) {
      case "/v1/me": return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role: "owner", permissions: opts.perms ?? ["organization.update", "visits.read"] }], profile: { displayName: "Synthetic Person" } });
      case "/v1/branding": return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "/v1/offices": return json(200, { offices: [{ officeId: NORTH, name: "North Office", isActive: true, clientCount: 0 }] });
      case "/v1/office-branding": return opts.on ? json(200, { offices: [{ officeId: NORTH, officeName: "North Office", accentColor: "#14532d", logoUrl: null, supportEmail: null }] }) : (() => { throw new TypeError("Failed to fetch"); })();
      default: return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  const auth = { subscribe: vi.fn(() => () => {}), getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "p@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn() };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: fetchImpl as never });
  render(
    <MemoryRouter initialEntries={["/settings/offices"]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}><AwsRoutes api={client} publicApi={client} /></CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { posts };
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("invitation email look", () => {
  it("shows the office's saved colour in a sandboxed preview of the invitation, switches to the password reset, and never shows a real address or code", async () => {
    renderOffices({ on: true });
    const frame = await screen.findByTestId("look-preview", {}, { timeout: 15000 }) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("#14532d"); expect(frame.getAttribute("srcdoc")).toContain("North Office"); expect(frame.getAttribute("srcdoc")).toContain("Sample-Temp-1234!");
    expect(frame.getAttribute("srcdoc")).not.toContain("{####}");
    expect(screen.getByTestId("look-subject")).toHaveTextContent("You're invited to Synthetic Care Co on Ogevia");
    fireEvent.click(screen.getByRole("button", { name: "Password reset" }));
    expect(screen.getByTestId("look-subject")).toHaveTextContent("Reset your Synthetic Care Co password");
    expect((screen.getByTestId("look-preview") as HTMLIFrameElement).getAttribute("srcdoc")).toContain("Reset your password");
  });
  it("updates the preview as the colour is typed, refuses a bad colour, and saves the look", async () => {
    const { posts } = renderOffices({ on: true });
    const color = await screen.findByTestId("look-color", {}, { timeout: 15000 });
    fireEvent.change(color, { target: { value: "teal" } });
    fireEvent.click(screen.getByRole("button", { name: "Save look" }));
    expect(await screen.findByText("Colour must look like #0F5F66.")).toBeInTheDocument();
    expect(posts).toHaveLength(0);
    fireEvent.change(color, { target: { value: "#9a3412" } });
    expect((screen.getByTestId("look-preview") as HTMLIFrameElement).getAttribute("srcdoc")).toContain("#9a3412");
    fireEvent.change(screen.getByTestId("look-mail"), { target: { value: "help@example.org" } });
    fireEvent.click(screen.getByRole("button", { name: "Save look" }));
    await waitFor(() => expect(posts).toContainEqual({ path: `/v1/offices/${NORTH}/branding`, body: { organizationId: ORG, accentColor: "#9a3412", logoUrl: null, supportEmail: "help@example.org" } }));
  });
  it("is absent where the switch is off", async () => {
    renderOffices({ on: false });
    await screen.findByText(/North Office/, {}, { timeout: 15000 });
    expect(screen.queryByText("Invitation email look")).not.toBeInTheDocument();
  });
});
