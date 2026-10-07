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

  it("approves billing through POST /v1/visits/{id}/billing-approval and voids through the approval route, with keys", async () => {
    const post = vi.fn().mockResolvedValueOnce({ billingApprovalId: "33333333-3333-4333-8333-333333333333" }).mockResolvedValueOnce({});
    const api = { get: vi.fn(), post } as unknown as AwsApiClient;
    const backend = createAwsServiceVerificationBackend(api, () => null);

    const id = await backend.approveVisitForBilling!({
      visitId: "11111111-1111-4111-8111-111111111111",
      approvedMinutes: 45,
      notes: null,
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
    });
    expect(id).toBe("33333333-3333-4333-8333-333333333333");
    expect(post).toHaveBeenNthCalledWith(1,
      "/v1/visits/11111111-1111-4111-8111-111111111111/billing-approval",
      { approvedMinutes: 45, notes: null },
      { idempotencyKey: "22222222-2222-4222-8222-222222222222" },
    );
    await backend.voidBillingApproval!({ billingApprovalId: id, reason: "Wrong visit", idempotencyKey: "44444444-4444-4444-8444-444444444444" });
    expect(post).toHaveBeenNthCalledWith(2,
      "/v1/billing-approvals/33333333-3333-4333-8333-333333333333/void",
      { reason: "Wrong visit" },
      { idempotencyKey: "44444444-4444-4444-8444-444444444444" },
    );
  });
});
