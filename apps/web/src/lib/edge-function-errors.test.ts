import { describe, expect, it } from "vitest";
import { extractEdgeFunctionErrorMessage } from "./edge-function-errors";

describe("extractEdgeFunctionErrorMessage", () => {
  it("pulls the real message out of a Response context", async () => {
    const context = new Response(JSON.stringify({ error: "Specific reason" }), { status: 409 });
    const error = Object.assign(new Error("Edge Function returned a non-2xx status code"), { context });

    await expect(extractEdgeFunctionErrorMessage(error, "fallback")).resolves.toBe("Specific reason");
  });

  it("falls back to the error message when the context isn't a Response", async () => {
    const error = new Error("Network error");
    await expect(extractEdgeFunctionErrorMessage(error, "fallback")).resolves.toBe("Network error");
  });

  it("falls back to the provided default when the context body isn't JSON", async () => {
    const context = new Response("not json", { status: 500 });
    const error = Object.assign(new Error("boom"), { context });

    await expect(extractEdgeFunctionErrorMessage(error, "fallback")).resolves.toBe("boom");
  });

  it("falls back to the provided default for a non-Error value", async () => {
    await expect(extractEdgeFunctionErrorMessage("not an error", "fallback")).resolves.toBe("fallback");
  });
});
