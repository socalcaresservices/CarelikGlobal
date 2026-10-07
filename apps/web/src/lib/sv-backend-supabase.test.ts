import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ supabase: { rpc, storage: { from: vi.fn() } } }));

import { supabaseServiceVerificationBackend as backend } from "./sv-backend-supabase";

const base = { organizationId: "org", clientId: "cli", serviceId: "svc", idempotencyKey: "k" };

describe("supabase backend: compatibility with a database without the redesign migration", () => {
  beforeEach(() => rpc.mockReset());

  it("omits scheduled_shift_id from the start call when no shift is chosen", async () => {
    rpc.mockResolvedValue({ data: "visit-1", error: null });
    await backend.startVisit(base);
    await backend.startVisit({ ...base, scheduledShiftId: null });
    for (const call of rpc.mock.calls) {
      expect(call[0]).toBe("start_ad_hoc_service_visit");
      expect(Object.keys(call[1] as object)).not.toContain("scheduled_shift_id");
    }
  });

  it("sends scheduled_shift_id when a shift is chosen", async () => {
    rpc.mockResolvedValue({ data: "visit-1", error: null });
    await backend.startVisit({ ...base, scheduledShiftId: "shift-9" });
    expect(rpc.mock.calls[0]![1]).toMatchObject({ scheduled_shift_id: "shift-9" });
  });

  it("returns no shifts (picker hidden) when the database lacks the shift-list function", async () => {
    for (const code of ["PGRST202", "42883"]) {
      rpc.mockResolvedValueOnce({ data: null, error: { code, message: "missing" } });
      await expect(backend.listScheduledShifts!("org", "cli")).resolves.toEqual([]);
    }
  });

  it("still surfaces other shift-list errors", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "denied" } });
    await expect(backend.listScheduledShifts!("org", "cli")).rejects.toMatchObject({ code: "42501" });
  });

  it("passes shifts through when the function exists", async () => {
    rpc.mockResolvedValue({ data: [{ shift_id: "s1" }], error: null });
    await expect(backend.listScheduledShifts!("org", "cli")).resolves.toEqual([{ shift_id: "s1" }]);
  });
});
