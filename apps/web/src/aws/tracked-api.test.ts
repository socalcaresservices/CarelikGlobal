import { describe, expect, it, vi } from "vitest";
import type { AwsApiClient } from "@/lib/aws-api";
import { REFRESHED_AFTER_CHANGE, withRefresh } from "./tracked-api";

describe("withRefresh (B1-R7)", () => {
  it("re-reads the attention counts and the issue list after a successful POST, passing the key and result through", async () => {
    const invalidate = vi.fn();
    const post = vi.fn(async () => ({ ok: true }));
    const api = withRefresh({ get: vi.fn(), post } as unknown as AwsApiClient, { invalidateQueries: invalidate } as never);
    await expect(api.post("/v1/x", { a: 1 }, { idempotencyKey: "k" })).resolves.toEqual({ ok: true });
    expect(post).toHaveBeenCalledWith("/v1/x", { a: 1 }, { idempotencyKey: "k" });
    expect(invalidate.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0])).toEqual([...REFRESHED_AFTER_CHANGE]);
  });
  it("re-reads nothing when the POST fails, and the error reaches the caller", async () => {
    const invalidate = vi.fn();
    const api = withRefresh({ get: vi.fn(), post: vi.fn(async () => { throw new Error("nope"); }) } as unknown as AwsApiClient, { invalidateQueries: invalidate } as never);
    await expect(api.post("/v1/x", {})).rejects.toThrow("nope");
    expect(invalidate).not.toHaveBeenCalled();
  });
  it("GET is passed through untouched", async () => {
    const get = vi.fn(async () => 5);
    const api = withRefresh({ get, post: vi.fn() } as unknown as AwsApiClient, { invalidateQueries: vi.fn() } as never);
    await expect(api.get("/v1/y")).resolves.toBe(5);
  });
});
