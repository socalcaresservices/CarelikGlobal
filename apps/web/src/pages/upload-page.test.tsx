import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/lib/supabase";
import { submitDocumentUpload } from "@/lib/document-uploads";
import { UploadPage } from "./upload-page";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn()
  }
}));

vi.mock("@/lib/document-uploads", () => ({
  submitDocumentUpload: vi.fn()
}));

const mockedRpc = vi.mocked(supabase.rpc);
const mockedSubmit = vi.mocked(submitDocumentUpload);

const BATCH = {
  batch_id: "batch-1",
  organization_id: "org-1",
  organization_display_name: "Acme Home Care",
  organization_logo_url: null,
  organization_primary_color: "#0f172a",
  organization_accent_color: null,
  organization_show_powered_by: true,
  subject_name: "Jordan Applicant",
  message: "Please upload these before your interview.",
  expires_at: null
};

const DOCS = [
  {
    id: "req-1",
    document_type_name: "Resume",
    category: "application",
    requires_expiration: false,
    status: "requested",
    uploaded_at: null,
    rejection_reason: null
  },
  {
    id: "req-2",
    document_type_name: "CPR Certification",
    category: "certification",
    requires_expiration: true,
    status: "verified",
    uploaded_at: "2026-07-01T00:00:00Z",
    rejection_reason: null
  }
];

function mockRpcByFn(overrides?: { batch?: unknown[]; docs?: unknown[] }) {
  mockedRpc.mockImplementation((fn: string) => {
    if (fn === "get_document_request_batch") {
      return Promise.resolve({ data: overrides?.batch ?? [BATCH], error: null }) as never;
    }
    if (fn === "list_document_requests_for_token") {
      return Promise.resolve({ data: overrides?.docs ?? DOCS, error: null }) as never;
    }
    return Promise.resolve({ data: [], error: null }) as never;
  });
}

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/upload/:token" element={<UploadPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("UploadPage", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows an invalid-link state for an unknown token", async () => {
    mockRpcByFn({ batch: [] });

    renderAt("/upload/does-not-exist");

    await waitFor(() => expect(screen.getByText("Link not found")).toBeInTheDocument());
  });

  it("shows the organization name, message, and each requested document with its status", async () => {
    mockRpcByFn();

    renderAt("/upload/valid-token");

    await waitFor(() => expect(screen.getByText("Acme Home Care")).toBeInTheDocument());
    expect(screen.getByText("Document request for Jordan Applicant")).toBeInTheDocument();
    expect(screen.getByText("Please upload these before your interview.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Resume")).toBeInTheDocument());
    expect(screen.getByText("CPR Certification")).toBeInTheDocument();
    expect(screen.getByText("1 document still needed.")).toBeInTheDocument();
  });

  it("only shows an upload control for documents that aren't already verified", async () => {
    mockRpcByFn();

    renderAt("/upload/valid-token");

    await waitFor(() => expect(screen.getByText("Resume")).toBeInTheDocument());
    // The verified CPR Certification row has no upload control - only the
    // requested Resume row gets one.
    expect(screen.getAllByRole("button", { name: /Upload/ })).toHaveLength(1);
  });

  it("uploads the chosen file for a requested document", async () => {
    mockRpcByFn();
    mockedSubmit.mockResolvedValue(undefined);

    renderAt("/upload/valid-token");

    await waitFor(() => expect(screen.getByText("Upload file")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Upload file"));

    const file = new File(["hello"], "resume.pdf", { type: "application/pdf" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() =>
      expect(mockedSubmit).toHaveBeenCalledWith({ token: "valid-token", documentRequestId: "req-1", file })
    );
  });

  it("shows an error message when the upload fails", async () => {
    mockRpcByFn();
    mockedSubmit.mockRejectedValue(new Error("Files must be 15MB or smaller"));

    renderAt("/upload/valid-token");

    await waitFor(() => expect(screen.getByText("Upload file")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Upload file"));

    const file = new File(["hello"], "resume.pdf", { type: "application/pdf" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText("Files must be 15MB or smaller")).toBeInTheDocument());
  });

  it("shows the rejection reason on a rejected document", async () => {
    mockRpcByFn({
      docs: [
        {
          id: "req-3",
          document_type_name: "TB Test",
          category: "medical",
          requires_expiration: true,
          status: "rejected",
          uploaded_at: "2026-07-01T00:00:00Z",
          rejection_reason: "Image was blurry, please retake."
        }
      ]
    });

    renderAt("/upload/valid-token");

    await waitFor(() => expect(screen.getByText("Image was blurry, please retake.")).toBeInTheDocument());
    expect(screen.getByText("Upload a different file")).toBeInTheDocument();
  });

  it("prefers the organization's accent color over its primary color for the upload button", async () => {
    mockRpcByFn({ batch: [{ ...BATCH, organization_accent_color: "#ff6600" }] });

    renderAt("/upload/valid-token");

    await waitFor(() => expect(screen.getByText("Upload file")).toBeInTheDocument());
    expect(screen.getByText("Upload file")).toHaveStyle({ backgroundColor: "#ff6600" });
  });

  it("shows the Secured by CareLik footer by default", async () => {
    mockRpcByFn();

    renderAt("/upload/valid-token");

    await waitFor(() => expect(screen.getByText("Acme Home Care")).toBeInTheDocument());
    expect(screen.getByText("Secured by CareLik")).toBeInTheDocument();
  });

  it("hides the Secured by CareLik footer when the organization has turned it off", async () => {
    mockRpcByFn({ batch: [{ ...BATCH, organization_show_powered_by: false }] });

    renderAt("/upload/valid-token");

    await waitFor(() => expect(screen.getByText("Acme Home Care")).toBeInTheDocument());
    expect(screen.queryByText("Secured by CareLik")).not.toBeInTheDocument();
  });
});
