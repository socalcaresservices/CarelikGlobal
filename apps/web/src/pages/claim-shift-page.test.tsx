import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/lib/supabase";
import { ClaimShiftPage } from "./claim-shift-page";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn()
  }
}));

const mockedRpc = vi.mocked(supabase.rpc);

const VIEW = {
  organization: { display_name: "Acme Home Care" },
  client_name: "Jordan R.",
  starts_at: "2026-08-25T16:00:00.000Z",
  ends_at: "2026-08-25T18:00:00.000Z",
  already_claimed: false,
  still_available: true
};

function mockRpcByFn(overrides?: { view?: unknown; claimError?: Error }) {
  mockedRpc.mockImplementation((fn: string) => {
    if (fn === "get_shift_claim") {
      return Promise.resolve({ data: overrides?.view ?? VIEW, error: null }) as never;
    }
    if (fn === "claim_shift") {
      if (overrides?.claimError) return Promise.resolve({ data: null, error: overrides.claimError }) as never;
      return Promise.resolve({ data: null, error: null }) as never;
    }
    return Promise.resolve({ data: null, error: null }) as never;
  });
}

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/claim/:token" element={<ClaimShiftPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("ClaimShiftPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows the shift details and lets a caregiver claim it", async () => {
    mockRpcByFn();

    renderAt("/claim/raw-token-abc");

    await waitFor(() => expect(screen.getByText("Jordan R.")).toBeInTheDocument());
    expect(screen.getByText("Acme Home Care")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take this shift" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Take this shift" }));

    await waitFor(() =>
      expect(mockedRpc).toHaveBeenCalledWith("claim_shift", { target_token: "raw-token-abc" })
    );
    await waitFor(() => expect(screen.getByText(/You're confirmed for this shift/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Take this shift" })).not.toBeInTheDocument();
  });

  it("shows an already-taken state instead of a claim button when another caregiver got there first", async () => {
    mockRpcByFn({ view: { ...VIEW, still_available: false } });

    renderAt("/claim/raw-token-abc");

    await waitFor(() => expect(screen.getByText("Jordan R.")).toBeInTheDocument());
    expect(screen.getByText(/already been covered/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Take this shift" })).not.toBeInTheDocument();
  });

  it("shows the caregiver's own already-claimed confirmation without a claim button", async () => {
    mockRpcByFn({ view: { ...VIEW, already_claimed: true, still_available: false } });

    renderAt("/claim/raw-token-abc");

    await waitFor(() => expect(screen.getByText("Jordan R.")).toBeInTheDocument());
    expect(screen.getByText(/You're confirmed for this shift/)).toBeInTheDocument();
  });

  it("shows an unavailable state for an invalid or expired token", async () => {
    mockedRpc.mockImplementation((fn: string) => {
      if (fn === "get_shift_claim") {
        return Promise.resolve({ data: null, error: new Error("This shift offer is no longer available.") }) as never;
      }
      return Promise.resolve({ data: null, error: null }) as never;
    });

    renderAt("/claim/expired-token");

    await waitFor(() => expect(screen.getByText("This offer is unavailable")).toBeInTheDocument());
  });

  it("shows an error message when claiming fails (e.g. someone else claimed it first)", async () => {
    mockRpcByFn({ claimError: new Error("This shift has already been covered.") });

    renderAt("/claim/raw-token-abc");

    await waitFor(() => expect(screen.getByRole("button", { name: "Take this shift" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Take this shift" }));

    await waitFor(() => expect(screen.getByText("This shift has already been covered.")).toBeInTheDocument());
  });
});
