import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/lib/supabase";
import { uploadOrganizationLogo } from "./organization-branding";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    storage: {
      from: vi.fn()
    }
  }
}));

const mockedFrom = vi.mocked(supabase.storage.from);

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function mockStorage({
  uploadError = null,
  publicUrl = "https://cdxxpdyobsqvqveabsda.supabase.co/storage/v1/object/public/organization-branding/logo.png"
}: {
  uploadError?: Error | null;
  publicUrl?: string;
} = {}) {
  const upload = vi.fn().mockResolvedValue({ data: uploadError ? null : { path: "x" }, error: uploadError });
  const getPublicUrl = vi.fn().mockReturnValue({ data: { publicUrl } });
  mockedFrom.mockReturnValue({ upload, getPublicUrl } as never);
  return { upload, getPublicUrl };
}

describe("uploadOrganizationLogo", () => {
  beforeEach(() => {
    mockedFrom.mockReset();
  });

  it("rejects a file type outside the allowlist without calling storage", async () => {
    const { upload } = mockStorage();
    const file = new File(["x"], "logo.gif", { type: "image/gif" });

    await expect(uploadOrganizationLogo(ORG_ID, file)).rejects.toThrow(
      "Logo must be a PNG, JPEG, SVG, or WebP image."
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects a file over 5MB without calling storage", async () => {
    const { upload } = mockStorage();
    const file = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "logo.png", { type: "image/png" });

    await expect(uploadOrganizationLogo(ORG_ID, file)).rejects.toThrow("Logo must be 5MB or smaller.");
    expect(upload).not.toHaveBeenCalled();
  });

  it("uploads to a path scoped to the organization id, using the file's extension", async () => {
    const { upload } = mockStorage();
    const file = new File(["x"], "logo.PNG", { type: "image/png" });

    await uploadOrganizationLogo(ORG_ID, file);

    expect(mockedFrom).toHaveBeenCalledWith("organization-branding");
    expect(upload).toHaveBeenCalledTimes(1);
    const [path, uploadedFile, options] = upload.mock.calls[0]!;
    expect(path).toMatch(new RegExp(`^${ORG_ID}/logo-\\d+\\.png$`));
    expect(uploadedFile).toBe(file);
    expect(options).toEqual({ upsert: true, contentType: "image/png" });
  });

  it("falls back to a png extension when the filename is empty", async () => {
    const { upload } = mockStorage();
    const file = new File(["x"], "", { type: "image/svg+xml" });

    await uploadOrganizationLogo(ORG_ID, file);

    const [path] = upload.mock.calls[0]!;
    expect(path).toMatch(new RegExp(`^${ORG_ID}/logo-\\d+\\.png$`));
  });

  it("treats a dot-less filename as its own extension rather than falling back to png", async () => {
    const { upload } = mockStorage();
    // split(".").pop() on a dot-less name returns the whole name (not
    // undefined), so the "png" fallback only ever fires for an empty
    // filename - this documents that a dot-less name is a different,
    // unusual case that still produces a valid (if odd) path.
    const file = new File(["x"], "logo-no-dot", { type: "image/svg+xml" });

    await uploadOrganizationLogo(ORG_ID, file);

    const [path] = upload.mock.calls[0]!;
    expect(path).toMatch(new RegExp(`^${ORG_ID}/logo-\\d+\\.logo-no-dot$`));
  });

  it("throws the storage error's message when the upload fails", async () => {
    mockStorage({ uploadError: new Error("new row violates row-level security policy") });
    const file = new File(["x"], "logo.png", { type: "image/png" });

    await expect(uploadOrganizationLogo(ORG_ID, file)).rejects.toThrow(
      "new row violates row-level security policy"
    );
  });

  it("returns the public URL for the uploaded object", async () => {
    mockStorage({ publicUrl: "https://example.supabase.co/storage/v1/object/public/organization-branding/x.png" });
    const file = new File(["x"], "logo.png", { type: "image/png" });

    const result = await uploadOrganizationLogo(ORG_ID, file);

    expect(result).toBe("https://example.supabase.co/storage/v1/object/public/organization-branding/x.png");
  });
});
