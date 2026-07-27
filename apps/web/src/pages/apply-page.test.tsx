import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/lib/supabase";
import { ApplyPage } from "./apply-page";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn()
  }
}));

const mockedRpc = vi.mocked(supabase.rpc);
const mockedFrom = vi.mocked(supabase.from);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const SERVICE_ID = "33333333-3333-4333-8333-333333333333";

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/apply/:orgSlug" element={<ApplyPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function mockRpcByFn(services: Array<{ id: string; name: string }> = []) {
  mockedRpc.mockImplementation((fn: string) => {
    if (fn === "get_organization_by_slug") {
      return Promise.resolve({ data: [{ id: ORG_ID, display_name: "Acme Home Care" }], error: null }) as never;
    }
    if (fn === "list_public_organization_services") {
      return Promise.resolve({ data: services, error: null }) as never;
    }
    return Promise.resolve({ data: [], error: null }) as never;
  });
}

describe("ApplyPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-found state for an unknown organization slug", async () => {
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderAt("/apply/not-a-real-org");

    await waitFor(() => expect(screen.getByText("Application not found")).toBeInTheDocument());
  });

  it("loads the organization and renders the application form, including the agency's configured services", async () => {
    mockRpcByFn([{ id: SERVICE_ID, name: "Companion Care" }]);

    renderAt("/apply/acme");

    await waitFor(() => expect(screen.getByText("Acme Home Care")).toBeInTheDocument());
    expect(screen.getByLabelText("First name")).toBeInTheDocument();
    expect(screen.getByLabelText("ZIP code")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Companion Care")).toBeInTheDocument());
    expect(screen.getByText("Submit application")).toBeInTheDocument();
  });

  it("submits the application, its availability, and its selected services, then shows a thank-you message", async () => {
    mockRpcByFn([{ id: SERVICE_ID, name: "Companion Care" }]);

    // No `.select()` chain: the applicant id is generated client-side
    // (crypto.randomUUID()) rather than read back from the insert, so
    // the mock only needs to resolve the plain insert call itself.
    const applicantInsertMock = vi.fn().mockResolvedValue({ error: null });
    const availabilityInsertMock = vi.fn().mockResolvedValue({ error: null });
    const servicesInsertMock = vi.fn().mockResolvedValue({ error: null });

    mockedFrom.mockImplementation((table: string) => {
      if (table === "job_applicants") return { insert: applicantInsertMock } as never;
      if (table === "job_applicant_availability") return { insert: availabilityInsertMock } as never;
      if (table === "job_applicant_services") return { insert: servicesInsertMock } as never;
      return {} as never;
    });

    renderAt("/apply/acme");

    await waitFor(() => expect(screen.getByLabelText("First name")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Companion Care")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Ashley" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Rivera" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ashley@example.com" } });
    fireEvent.change(screen.getByLabelText("ZIP code"), { target: { value: "92879" } });
    fireEvent.click(screen.getByLabelText("Companion Care"));

    fireEvent.click(screen.getByText("Submit application"));

    await waitFor(() => expect(screen.getByText("Thanks for applying!")).toBeInTheDocument());
    expect(applicantInsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        organization_id: ORG_ID,
        first_name: "Ashley",
        last_name: "Rivera",
        address_zip: "92879"
      })
    );
    expect(servicesInsertMock).toHaveBeenCalledWith([
      expect.objectContaining({ organization_id: ORG_ID, service_id: SERVICE_ID })
    ]);
    // No day was checked, so no availability rows should have been submitted.
    expect(availabilityInsertMock).not.toHaveBeenCalled();
  });
});
