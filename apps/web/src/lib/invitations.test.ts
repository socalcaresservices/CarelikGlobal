import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/lib/supabase";
import { inviteMember } from "./invitations";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    functions: {
      invoke: vi.fn()
    }
  }
}));

const mockedInvoke = vi.mocked(supabase.functions.invoke);

describe("inviteMember", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("returns the edge function's data on success", async () => {
    const result = {
      userId: "user-1",
      email: "person@example.com",
      organizationId: "org-1",
      role: "staff" as const,
      status: "invited" as const
    };
    mockedInvoke.mockResolvedValue({ data: result, error: null } as never);

    await expect(
      inviteMember({ email: "person@example.com", organizationId: "org-1", role: "staff" })
    ).resolves.toEqual(result);

    expect(mockedInvoke).toHaveBeenCalledWith("invite-member", {
      body: { email: "person@example.com", organizationId: "org-1", role: "staff" }
    });
  });

  it("throws when the edge function returns an error", async () => {
    const error = new Error(
      "You do not have permission to invite members to this organization"
    );
    mockedInvoke.mockResolvedValue({ data: null, error } as never);

    await expect(
      inviteMember({ email: "person@example.com", organizationId: "org-1", role: "staff" })
    ).rejects.toThrow(error.message);
  });

  it("reads the real reason out of the response body instead of the generic FunctionsHttpError message", async () => {
    // supabase-js's FunctionsHttpError.message is always the generic
    // "Edge Function returned a non-2xx status code" - the actual reason
    // our edge function sent back only lives in error.context (the raw
    // Response). This is what previously made every failure look the
    // same in the UI.
    const context = new Response(JSON.stringify({ error: "That email is already on your team." }), {
      status: 409
    });
    const error = Object.assign(new Error("Edge Function returned a non-2xx status code"), { context });
    mockedInvoke.mockResolvedValue({ data: null, error } as never);

    await expect(
      inviteMember({
        email: "person@example.com",
        organizationId: "org-1",
        role: "staff",
        firstName: "Sam",
        lastName: "Caregiver"
      })
    ).rejects.toThrow("That email is already on your team.");
  });

  it("throws when there is no data and no error", async () => {
    mockedInvoke.mockResolvedValue({ data: null, error: null } as never);

    await expect(
      inviteMember({ email: "person@example.com", organizationId: "org-1", role: "staff" })
    ).rejects.toThrow("no response from server");
  });
});
