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

describe("ApplyPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows a not-found state for an unknown organization slug", async () => {
    mockedRpc.mockResolvedValue({ data: [], error: null } as never);

    renderAt("/apply/not-a-real-org");

    await waitFor(() => expect(screen.getByText("Application not found")).toBeInTheDocument());
  });

  it("loads the organization and renders the application form", async () => {
    mockedRpc.mockResolvedValue({
      data: [{ id: ORG_ID, display_name: "Acme Home Care" }],
      error: null
    } as never);

    renderAt("/apply/acme");

    await waitFor(() => expect(screen.getByText("Acme Home Care")).toBeInTheDocument());
    expect(screen.getByLabelText("First name")).toBeInTheDocument();
    expect(screen.getByText("Submit application")).toBeInTheDocument();
  });

  it("submits the application and its availability, then shows a thank-you message", async () => {
    mockedRpc.mockResolvedValue({
      data: [{ id: ORG_ID, display_name: "Acme Home Care" }],
      error: null
    } as never);

    const applicantSingleMock = vi.fn().mockResolvedValue({ data: { id: "applicant-1" }, error: null });
    const applicantSelectMock = vi.fn(() => ({ single: applicantSingleMock }));
    const applicantInsertMock = vi.fn(() => ({ select: applicantSelectMock }));
    const availabilityInsertMock = vi.fn().mockResolvedValue({ error: null });

    mockedFrom.mockImplementation((table: string) => {
      if (table === "job_applicants") return { insert: applicantInsertMock } as never;
      if (table === "job_applicant_availability") return { insert: availabilityInsertMock } as never;
      return {} as never;
    });

    renderAt("/apply/acme");

    await waitFor(() => expect(screen.getByLabelText("First name")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Ashley" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Rivera" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ashley@example.com" } });

    fireEvent.click(screen.getByText("Submit application"));

    await waitFor(() => expect(screen.getByText("Thanks for applying!")).toBeInTheDocument());
    expect(applicantInsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ organization_id: ORG_ID, first_name: "Ashley", last_name: "Rivera" })
    );
    // No day was checked, so no availability rows should have been submitted.
    expect(availabilityInsertMock).not.toHaveBeenCalled();
  });
});
