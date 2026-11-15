/* eslint-disable @typescript-eslint/no-explicit-any -- a test double: request bodies are free-form JSON */
// Shared by the closure tests: the whole AWS app against an in-memory fake of the API. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

export const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
export type Call = { method: string; path: string; query: URLSearchParams; body: Record<string, any> | null; key: string | null };
export type Handler = (ctx: { url: URL; body: Record<string, any> | null }) => Response | undefined;
export const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });

export function renderAws(path: string, permissions: string[], handlers: Record<string, Handler> = {}, role = "manager") {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = (init?.body ? JSON.parse(String(init.body)) : null) as Record<string, any> | null;
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, query: url.searchParams, body, key: new Headers(init?.headers).get("idempotency-key") });
    const custom = handlers[`${method} ${url.pathname}`]?.({ url, body });
    if (custom) return custom;
    switch (`${method} ${url.pathname}`) {
      case "GET /v1/me": return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role, permissions }], profile: { displayName: "Morgan Manager" } });
      case "GET /v1/branding": return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "GET /v1/attention": return json(200, { summary: null });
      case "GET /v1/attention/overview": return json(200, { overview: { asOf: new Date().toISOString(), urgentWindowHours: 48, urgent: null, upcoming: { count: 0, nextStartsAt: null, shifts: [] }, documents: null, visitReview: null } });
      case "GET /v1/action-issues": return json(200, { asOf: new Date().toISOString(), matching: 0, limit: 50, offset: 0, counts: { total: 0, critical: 0, urgent: 0, routine: 0, actionNeeded: 0, byQueue: {} }, issues: [] });
      case "GET /v1/notifications": return json(200, { notifications: { asOf: new Date().toISOString(), unread: 0, items: [] } });
      case "GET /v1/notification-settings": return json(200, { settings: { urgentInApp: true, criticalInApp: true, routine: "listed in Action needed only", outboundChannels: "none" } });
      case "GET /v1/shifts": return json(200, { shifts: [] });
      case "GET /v1/clients": return json(200, { clients: [] });
      case "GET /v1/services": return json(200, { services: [] });
      case "GET /v1/caregivers": return json(200, { caregivers: [] });
      case "GET /v1/reports/utilisation": return json(200, { services: [] });
      default: return json(404, { error: { code: "not_found", message: `No such endpoint: ${method} ${url.pathname}` } });
    }
  });
  const auth = { subscribe: vi.fn(() => () => {}), getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "m@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })), getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn() };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: fetchImpl as never });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter initialEntries={[path]}><QueryClientProvider client={queryClient}><CognitoAuthProvider client={auth as unknown as CognitoAuthClient}><AwsRoutes api={client} publicApi={client} /></CognitoAuthProvider></QueryClientProvider></MemoryRouter>);
  return { calls, queryClient };
}
