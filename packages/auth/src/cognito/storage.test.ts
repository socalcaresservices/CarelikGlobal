import { describe, expect, it } from "vitest";
import { MemoryStore, sanitizeReturnTo, saveTransaction, takeTransaction, TRANSACTION_KEY, TRANSACTION_TTL_MS } from "./storage";

const tx = { state: "s", codeVerifier: "v", nonce: "n", returnTo: "/schedule", createdAt: 1_000 };

describe("PKCE transaction storage", () => {
  it("is single-use", () => {
    const store = new MemoryStore();
    saveTransaction(store, tx);
    expect(takeTransaction(store, 2_000)).toEqual(tx);
    expect(takeTransaction(store, 2_000)).toBeNull();
  });

  it("expires after the TTL and rejects corrupted entries", () => {
    const store = new MemoryStore();
    saveTransaction(store, tx);
    expect(takeTransaction(store, 1_000 + TRANSACTION_TTL_MS + 1)).toBeNull();
    store.setItem(TRANSACTION_KEY, "{not json");
    expect(takeTransaction(store, 2_000)).toBeNull();
    store.setItem(TRANSACTION_KEY, JSON.stringify({ state: 1 }));
    expect(takeTransaction(store, 2_000)).toBeNull();
  });
});

describe("safe redirect restoration", () => {
  it.each([
    ["/schedule?x=1", "/schedule?x=1"],
    ["/service-verification", "/service-verification"],
    [undefined, "/"],
    ["", "/"],
    ["https://evil.example/", "/"],
    ["//evil.example/path", "/"],
    ["/\\evil.example", "/"],
    ["javascript:alert(1)", "/"],
    ["/auth/callback?code=x", "/"],
    ["/login", "/"],
    ["/ok\nSet-Cookie: x", "/"],
  ])("%s -> %s", (input, output) => {
    expect(sanitizeReturnTo(input)).toBe(output);
  });
});
