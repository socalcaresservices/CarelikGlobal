// Environment marker, print letterhead settings and the overnight availability editor. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { createAwsServiceVerificationBackend } from "@/lib/sv-backend-aws";
import { AwsRoutes } from "./aws-root";
import { createAwsRuntime, loadRuntimeEnv } from "./aws-runtime";
import { EnvironmentProvider } from "./environment-marker";
import { resolveEnvironmentMarker, TEST_MARKER_LABEL, UNVERIFIED_MARKER_LABEL } from "./environment";
import { letterheadProblem, EMPTY_LETTERHEAD } from "./letterhead-validation";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
type Role = "organization_owner" | "manager" | "caregiver";
const PERMS: Record<Role, string[]> = {
  organization_owner: ["visits.read", "visits.manage", "organization.update", "clients.names.read", "authorizations.read", "billing.visits.read"],
  manager: ["visits.read", "visits.manage", "clients.names.read", "authorizations.read"],
  caregiver: ["availability.manage_own", "documents.manage_own"],
};
const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
type Posted = { path: string; body: Record<string, unknown>; key: string | null };

function renderApp(path: string, role: Role, opts: { env?: string | null; windows?: unknown[]; branding?: Record<string, unknown> } = {}) {
  const posts: Posted[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      posts.push({ path: url.pathname, body: JSON.parse(String(init.body ?? "{}")), key: new Headers(init.headers).get("idempotency-key") });
      return json(200, { letterhead: {} });
    }
    switch (url.pathname) {
      case "/v1/me":
        return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role, permissions: PERMS[role] }], profile: { displayName: "Synthetic Person" } });
      case "/v1/branding":
        return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null, ...(opts.branding ?? {}) } });
      case "/v1/attention":
        return json(200, { summary: null });
      case "/v1/clients":
        return json(200, { clients: [] });
      case "/v1/client-types":
        return json(200, { clientTypes: [] });
      case "/v1/availability/me":
        return json(200, { windows: opts.windows ?? [] });
      case "/v1/care-opportunities":
        return json(200, { opportunities: [] });
      default:
        return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  const auth = {
    subscribe: vi.fn(() => () => {}),
    getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "person@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn(),
  };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: fetchImpl as never });
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}>
          <AwsRoutes api={client} publicApi={client} />
        </CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
  render(opts.env === undefined ? tree : <EnvironmentProvider marker={resolveEnvironmentMarker(opts.env)}>{tree}</EnvironmentProvider>);
  return { posts };
}
afterEach(() => cleanup());

describe("environment marker: explicit configuration only", () => {
  it.each([
    ["test", "test", TEST_MARKER_LABEL],
    ["development", "development", TEST_MARKER_LABEL],
    ["  TEST  ", "test", TEST_MARKER_LABEL],
    ["production", "production", null],
    [undefined, "unverified", UNVERIFIED_MARKER_LABEL],
    ["", "unverified", UNVERIFIED_MARKER_LABEL],
    ["prod", "unverified", UNVERIFIED_MARKER_LABEL],
    ["staging", "unverified", UNVERIFIED_MARKER_LABEL],
    ["pilot-test", "unverified", UNVERIFIED_MARKER_LABEL],
    [42, "unverified", UNVERIFIED_MARKER_LABEL],
    [null, "unverified", UNVERIFIED_MARKER_LABEL],
  ])("%j -> %s", (value, kind, label) => {
    expect(resolveEnvironmentMarker(value)).toEqual({ kind, label });
  });

  it("an unknown or missing value is never labelled TEST", () => {
    for (const v of [undefined, "", "prod", "staging", "tset", "tests", {}, []]) expect(resolveEnvironmentMarker(v).label ?? "").not.toMatch(/TEST/);
  });

  it("the deployed /config.json can set it, overrides the build value, and non-text values are ignored", async () => {
    const ok = async (body: unknown) => (await loadRuntimeEnv({ VITE_APP_ENV: "production" } as never, (async () => new Response(JSON.stringify(body), { status: 200 })) as never)).VITE_APP_ENV;
    expect(await ok({ VITE_APP_ENV: "test" })).toBe("test");
    expect(await ok({})).toBe("production"); // no key in config.json: the build value stays
    expect(await ok({ VITE_APP_ENV: 7 })).toBe("production");
    const missing = await loadRuntimeEnv({} as never, (async () => new Response("{}", { status: 200 })) as never);
    expect(missing.VITE_APP_ENV).toBeUndefined();
  });

  it("the runtime carries the marker and refuses nothing about it (a bad value is shown as not verified, not an error)", () => {
    const base = {
      VITE_COGNITO_REGION: "us-west-2", VITE_COGNITO_USER_POOL_ID: "us-west-2_TESTPOOL1", VITE_COGNITO_CLIENT_ID: "testclient0000000000000000",
      VITE_COGNITO_DOMAIN: "https://ogevia-test.auth.us-west-2.amazoncognito.com", VITE_COGNITO_REDIRECT_URI: "https://app.example.test/auth/callback",
      VITE_COGNITO_LOGOUT_URI: "https://app.example.test/", VITE_SV_API_BASE_URL: "https://api.example.test",
    };
    expect(createAwsRuntime({ ...base, VITE_APP_ENV: "test" } as never).environment.kind).toBe("test");
    expect(createAwsRuntime({ ...base, VITE_APP_ENV: "typo" } as never).environment.kind).toBe("unverified");
    expect(createAwsRuntime(base as never).environment.kind).toBe("unverified");
  });

  it("test shows the banner on Home and on another page, and the old hard-coded Clients sentence is gone", async () => {
    renderApp("/clients", "manager", { env: "test" });
    expect(await screen.findByTestId("environment-banner")).toHaveTextContent("TEST — synthetic data only");
    expect(screen.getByTestId("environment-banner")).toHaveAttribute("data-environment", "test");
    expect(screen.queryByText(/synthetic clients only until the security approval/)).toBeNull();
    cleanup();
    renderApp("/", "manager", { env: "development" });
    expect(await screen.findByTestId("environment-banner")).toHaveTextContent("TEST — synthetic data only");
  });

  it("production shows no TEST banner, and nothing about the environment", async () => {
    renderApp("/clients", "manager", { env: "production" });
    await screen.findByRole("heading", { name: "Clients" });
    expect(screen.queryByTestId("environment-banner")).toBeNull();
    expect(screen.queryByText(/TEST —/)).toBeNull();
  });

  it("a missing or invalid value says 'Environment not verified', never TEST", async () => {
    renderApp("/clients", "manager", { env: "staging" });
    const banner = await screen.findByTestId("environment-banner");
    expect(banner).toHaveTextContent("Environment not verified");
    expect(banner).not.toHaveTextContent("TEST");
    expect(banner).toHaveAttribute("data-environment", "unverified");
  });

  it("with no environment context at all (the older build) nothing is claimed", async () => {
    renderApp("/clients", "manager");
    await screen.findByRole("heading", { name: "Clients" });
    expect(screen.queryByTestId("environment-banner")).toBeNull();
  });

  it("the banner is hidden when printing (reports carry the label in their own page header)", async () => {
    renderApp("/clients", "manager", { env: "test" });
    expect((await screen.findByTestId("environment-banner")).className).toMatch(/print:hidden/);
  });
});

describe("print letterhead settings", () => {
  it("the Administrator sees the section pre-filled from saved values and saves to the separate route for the current agency", async () => {
    const { posts } = renderApp("/settings/branding", "organization_owner", { branding: { legalName: "Synthetic Home Care LLC", addressCity: "Exampleville", addressState: "CA" } });
    expect(await screen.findByRole("heading", { name: "Print letterhead" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Legal name (as printed)")).toHaveValue("Synthetic Home Care LLC"));
    expect(screen.getByLabelText("City")).toHaveValue("Exampleville");
    expect(screen.getByText(/never enter client or caregiver information/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Street address"), { target: { value: "100 Example Way" } });
    fireEvent.change(screen.getByLabelText("ZIP code"), { target: { value: "90001" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "(555) 010-0100" } });
    fireEvent.click(screen.getByRole("button", { name: "Save letterhead" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Letterhead saved");
    const p = posts.find((x) => x.path === "/v1/branding/letterhead")!;
    expect(p.body).toMatchObject({ organizationId: ORG, legalName: "Synthetic Home Care LLC", addressStreet: "100 Example Way", addressCity: "Exampleville", addressState: "CA", addressZip: "90001", contactPhone: "(555) 010-0100", contactEmail: null });
    expect(p.key).toMatch(/^[0-9a-f-]{36}$/);
    // The branding route was not used for this.
    expect(posts.some((x) => x.path === "/v1/branding")).toBe(false);
  });

  it("a mistake is explained before anything is sent", async () => {
    const { posts } = renderApp("/settings/branding", "organization_owner", { branding: { legalName: "Synthetic Home Care LLC" } });
    await waitFor(() => expect(screen.getByLabelText("Legal name (as printed)")).toHaveValue("Synthetic Home Care LLC")); // saved values have loaded
    fireEvent.change(screen.getByLabelText("ZIP code"), { target: { value: "9000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save letterhead" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/ZIP code must be 5 digits/);
    expect(posts).toHaveLength(0);
  });

  it("a manager cannot reach it", async () => {
    renderApp("/settings/branding", "manager");
    expect(await screen.findByText(/Only the agency Administrator can change branding/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Print letterhead" })).toBeNull();
  });

  it("the validation matches the database rules", () => {
    const ok = { ...EMPTY_LETTERHEAD, legalName: "Synthetic Home Care LLC", addressState: "ca", addressZip: "90001-1234", contactPhone: "+1 (555) 010-0100", contactEmail: "a@b.test" };
    expect(letterheadProblem(ok)).toBeNull();
    expect(letterheadProblem(EMPTY_LETTERHEAD)).toBeNull(); // blank prints nothing
    for (const bad of [{ addressState: "CAL" }, { addressZip: "9000" }, { contactPhone: "abc" }, { contactEmail: "no-at-sign" }, { legalName: "A" }, { addressStreet: "x".repeat(121) }]) {
      expect(letterheadProblem({ ...EMPTY_LETTERHEAD, ...bad })).not.toBeNull();
    }
  });

  it("the print header gets only what the agency entered: nothing is invented, the legal name falls back to the agency name", async () => {
    const api = { get: vi.fn(async (path: string) => (path === "/v1/branding" ? { branding: { displayName: "Synthetic Care Co", logoSha256: null, addressCity: "Exampleville", contactEmail: "office@example.test" } } : {})) } as never;
    const backend = createAwsServiceVerificationBackend(api, () => null);
    const l = await backend.getLetterhead(ORG);
    expect(l).toMatchObject({ legal_name: "Synthetic Care Co", display_name: "Synthetic Care Co", address_city: "Exampleville", contact_email: "office@example.test", address_street: null, address_state: null, address_zip: null, contact_phone: null, logo_url: null });
  });
});

// The caregiver availability editor moved to request-and-approve (0039); its tests are in readiness/availability.test.tsx.
