import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/lib/supabase";
import { useTenantContext } from "./use-tenant-context";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn()
  }
}));

const mockedRpc = vi.mocked(supabase.rpc);

function setHostname(hostname: string) {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, hostname }
  });
}

function renderTenantContext() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useTenantContext(), {
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  });
}

describe("useTenantContext", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("resolves an Ogevia subdomain synchronously, without calling the RPC", () => {
    setHostname("acme.ogevia.com");

    const { result } = renderTenantContext();

    expect(result.current).toEqual({ context: { type: "tenant", slug: "acme" }, loading: false });
    expect(mockedRpc).not.toHaveBeenCalled();
  });

  it("resolves the admin host synchronously, without calling the RPC", () => {
    setHostname("admin.ogevia.com");

    const { result } = renderTenantContext();

    expect(result.current).toEqual({ context: { type: "admin" }, loading: false });
    expect(mockedRpc).not.toHaveBeenCalled();
  });

  it("shows loading, then resolves a matching custom domain to its tenant", async () => {
    setHostname("app.acme-agency.com");
    mockedRpc.mockResolvedValue({
      data: [{ slug: "acme", display_name: "Acme" }],
      error: null
    } as never);

    const { result } = renderTenantContext();

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.context).toEqual({ type: "tenant", slug: "acme" });
    expect(mockedRpc).toHaveBeenCalledWith("resolve_tenant_domain", { hostname: "app.acme-agency.com" });
  });

  it("falls back to marketing for a hostname that matches no custom domain", async () => {
    setHostname("app.unrelated-example.com");
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    const { result } = renderTenantContext();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.context).toEqual({ type: "marketing" });
  });

  it("fails closed to marketing when the lookup errors", async () => {
    setHostname("app.broken-example.com");
    mockedRpc.mockResolvedValue({ data: null, error: new Error("network error") } as never);

    const { result } = renderTenantContext();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.context).toEqual({ type: "marketing" });
  });
});
