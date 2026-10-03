import { describe, expect, it, vi } from "vitest";
import type { AwsApiClient } from "./aws-api";
import { createAwsServiceVerificationBackend } from "./sv-backend-aws";

describe("AWS Service Verification backend", () => {
  it("closes a missed clock-out through POST /v1/visits/{id}/close with the idempotency key", async () => {
    const post = vi.fn().mockResolvedValue({ visit: {} });
    const api = { get: vi.fn(), post } as unknown as AwsApiClient;
    const backend = createAwsServiceVerificationBackend(api, () => null);

    await backend.closeMissedVisit({
      visitId: "11111111-1111-4111-8111-111111111111",
      timeOut: "2026-10-02T23:00:00.000Z",
      reason: "Caregiver confirmed by phone",
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    });

    expect(post).toHaveBeenCalledWith(
      "/v1/visits/11111111-1111-4111-8111-111111111111/close",
      { timeOut: "2026-10-02T23:00:00.000Z", reason: "Caregiver confirmed by phone" },
      { idempotencyKey: "22222222-2222-4222-8222-222222222222" },
    );
  });
});
