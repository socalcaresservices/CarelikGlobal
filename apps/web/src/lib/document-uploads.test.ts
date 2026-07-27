import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/lib/supabase";
import { submitDocumentUpload } from "./document-uploads";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    functions: {
      invoke: vi.fn()
    }
  }
}));

const mockedInvoke = vi.mocked(supabase.functions.invoke);

describe("submitDocumentUpload", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("sends the token, document request id, and file as FormData", async () => {
    mockedInvoke.mockResolvedValue({ data: { ok: true }, error: null } as never);
    const file = new File(["hello"], "resume.pdf", { type: "application/pdf" });

    await submitDocumentUpload({ token: "abc123", documentRequestId: "req-1", file });

    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    const [name, options] = mockedInvoke.mock.calls[0]!;
    expect(name).toBe("submit-document-upload");
    const body = options?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("token")).toBe("abc123");
    expect(body.get("document_request_id")).toBe("req-1");
    expect(body.get("file")).toBe(file);
  });

  it("throws when the edge function returns an error", async () => {
    const error = new Error("Files must be 15MB or smaller");
    mockedInvoke.mockResolvedValue({ data: null, error } as never);
    const file = new File(["hello"], "resume.pdf", { type: "application/pdf" });

    await expect(
      submitDocumentUpload({ token: "abc123", documentRequestId: "req-1", file })
    ).rejects.toThrow(error.message);
  });

  it("reads the real reason out of the response body instead of the generic FunctionsHttpError message", async () => {
    const context = new Response(JSON.stringify({ error: "This link is invalid or has expired." }), {
      status: 404
    });
    const error = Object.assign(new Error("Edge Function returned a non-2xx status code"), { context });
    mockedInvoke.mockResolvedValue({ data: null, error } as never);
    const file = new File(["hello"], "resume.pdf", { type: "application/pdf" });

    await expect(
      submitDocumentUpload({ token: "expired-token", documentRequestId: "req-1", file })
    ).rejects.toThrow("This link is invalid or has expired.");
  });
});
