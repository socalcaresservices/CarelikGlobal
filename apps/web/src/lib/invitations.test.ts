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

  it("throws when there is no data and no error", async () => {
    mockedInvoke.mockResolvedValue({ data: null, error: null } as never);

    await expect(
      inviteMember({ email: "person@example.com", organizationId: "org-1", role: "staff" })
    ).rejects.toThrow("no response from server");
  });
});
