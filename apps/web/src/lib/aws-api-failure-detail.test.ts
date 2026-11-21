// A failed request carries where and when it failed (never the query string, a token or a body), and describeApiFailure turns it into one readable line.
import { describe, expect, it } from "vitest";
import { ApiRequestError, createAwsApiClient, describeApiFailure } from "./aws-api";

const caught = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ApiRequestError; } throw new Error("expected a failure"); };
const client = (handler: (url: string) => Promise<Response>) =>
  createAwsApiClient({ baseUrl: "https://api.example", getAccessToken: async () => "secret-token", fetch: ((input: RequestInfo | URL) => handler(String(input))) as typeof fetch });

describe("failure detail", () => {
  it("an HTTP failure keeps its status, the route without the query string, and a time; no token or parameter value appears", async () => {
    const c = client(() => Promise.resolve(new Response("{}", { status: 503 })));
    const e = await caught(c.get("/v1/action-issues", { organizationId: "11111111-1111-4111-8111-111111111111", limit: "50" }));
    expect(e.status).toBe(503);
    expect(e.context?.path).toBe("/v1/action-issues");
    const line = describeApiFailure(e)!;
    expect(line).toMatch(/^HTTP 503, \/v1\/action-issues, /);
    expect(line).not.toContain("secret-token"); expect(line).not.toContain("11111111");
  });
  it("a request with no answer while the API answers others is described as such", async () => {
    const c = client((u) => (u.endsWith("/v1/me") ? Promise.resolve(new Response("{}", { status: 200 })) : Promise.reject(new TypeError("Failed to fetch"))));
    const e = await caught(c.get("/v1/notifications"));
    expect(describeApiFailure(e)).toMatch(/^The service answered other requests but not this one, \/v1\/notifications, /);
  });
  it("no connection at all is described as no answer", async () => {
    const c = client(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(describeApiFailure(await caught(c.get("/v1/notifications")))).toMatch(/^No answer from the service, \/v1\/notifications, /);
  });
  it("anything that is not an API failure has no detail", () => {
    expect(describeApiFailure(new Error("x"))).toBeNull();
    expect(describeApiFailure(new ApiRequestError(500, "server_error", "x"))).toBeNull();
    expect(describeApiFailure(null)).toBeNull();
  });
});
