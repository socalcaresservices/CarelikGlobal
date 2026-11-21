// A route behind a release switch does not exist where the switch is off. API Gateway's 404 carries no cross-origin headers, so the browser reports a failed
// request ("Could not reach Ogevia"). For those paths only, the client checks that the API itself answers; if it does, the error says the feature is not available.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiRequestError, createAwsApiClient, isSwitchedPath } from "./aws-api";

const make = (handler: (url: string) => Promise<Response>) => {
  const calls: string[] = [];
  const fetchImpl = ((input: RequestInfo | URL) => { calls.push(String(input)); return handler(String(input)); }) as typeof fetch;
  return { calls, client: createAwsApiClient({ baseUrl: "https://api.example", getAccessToken: async () => "t", fetch: fetchImpl }) };
};
const ok = () => Promise.resolve(new Response("{}", { status: 200 }));
const failed = () => Promise.reject(new TypeError("Failed to fetch"));
const caught = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ApiRequestError; } throw new Error("expected a failure"); };

describe("switched routes", () => {
  it("a failed request on a switched path, while the API answers, is 'not available in this environment yet' (404 not_available), not a connection error", async () => {
    const { client, calls } = make((u) => (u.endsWith("/v1/me") ? ok() : failed()));
    const e = await caught(client.post("/v1/document-types/abc/retire", { reason: "duplicate" }));
    expect(e.status).toBe(404); expect(e.code).toBe("not_available"); expect(e.message).toBe("This is not available in this environment yet.");
    expect(calls).toHaveLength(2); expect(calls[1]).toBe("https://api.example/v1/me");
  });
  it("an API that answers 401 to the check still counts as reached", async () => {
    const { client } = make((u) => (u.endsWith("/v1/me") ? Promise.resolve(new Response("{}", { status: 401 })) : failed()));
    expect((await caught(client.post("/v1/documents/abc/cancel", {}))).code).toBe("not_available");
  });
  it("when the API cannot be reached at all, the message stays 'Could not reach Ogevia'", async () => {
    const { client } = make(failed);
    const e = await caught(client.post("/v1/care-notifications/read", {}));
    expect(e.status).toBe(0); expect(e.code).toBe("network_error"); expect(e.message).toContain("Could not reach Ogevia");
  });
  it("a path that is not switched keeps the connection message and makes no extra request", async () => {
    const { client, calls } = make((u) => (u.endsWith("/v1/me") ? ok() : failed()));
    const e = await caught(client.post("/v1/visits/start", {}));
    expect(e.code).toBe("network_error"); expect(calls).toHaveLength(1);
  });
  it("a real answer is never reclassified (a 404 not_found from the server stays as the server sent it)", async () => {
    const { client } = make(() => Promise.resolve(new Response(JSON.stringify({ error: { code: "not_found", message: "No such type." } }), { status: 404 })));
    const e = await caught(client.post("/v1/document-types/abc/retire", {}));
    expect(e.code).toBe("not_found"); expect(e.message).toBe("No such type.");
  });
  it("every route behind a release switch in the CDK route table is covered (so a new switched route cannot show 'Could not reach Ogevia')", () => {
    const src = readFileSync(resolve(process.cwd(), "../../infra/aws/lib/service-verification-api-stack.ts"), "utf8");
    const gated = [...src.matchAll(/path: "([^"]+)", feature: "(\w+)"/g)].filter((m) => m[2] !== "staffManagement");   // staff management is on in every environment
    expect(gated.length).toBeGreaterThanOrEqual(20);
    const missing = gated.filter((m) => !isSwitchedPath(m[1]!.replace(/\{[^}]+\}/g, "abc"))).map((m) => `${m[2]} ${m[1]}`);
    expect(missing).toEqual([]);
  });
});

describe("the message for each kind of failure (real client, stand-in fetch)", () => {
  const answer = (status: number, body: unknown) => () => Promise.resolve(new Response(body === null ? "" : JSON.stringify(body), { status }));
  const cases: Array<[string, number, unknown, string, string]> = [
    ["expired sign-in (API Gateway authorizer, no Ogevia body)", 401, { message: "Unauthorized" }, "unauthenticated", "Your session has ended. Please sign in again."],
    ["insufficient permission without an Ogevia body", 403, { message: "Forbidden" }, "forbidden", "You do not have permission to do this."],
    ["insufficient permission from the server (its own message wins)", 403, { error: { code: "forbidden", message: "Only the agency Administrator can do this." } }, "forbidden", "Only the agency Administrator can do this."],
    ["a business rule (open requests)", 409, { error: { code: "conflict", message: "Cancel its open requests first." } }, "conflict", "Cancel its open requests first."],
    ["a server failure (function crashed)", 500, { message: "Internal server error" }, "server_error", "Ogevia had a problem completing that. Try again in a moment; if it keeps happening, tell the office."],
    ["throttling", 429, { message: "Too Many Requests" }, "rate_limited", "Too many requests. Wait a moment and try again."],
  ];
  for (const [name, status, body, code, text] of cases) {
    it(name, async () => {
      const { client } = make(answer(status, body));
      const e = await caught(client.post("/v1/document-types/abc/retire", {}));
      expect(e.status).toBe(status); expect(e.code).toBe(code); expect(e.message).toBe(text);
      expect(e.message).not.toContain("Could not reach Ogevia");
    });
  }
  it("a genuine connection problem is the only case that says 'Could not reach Ogevia'", async () => {
    const { client } = make(failed);
    expect((await caught(client.get("/v1/me"))).message).toContain("Could not reach Ogevia");
  });
  it("a feature that is switched off says so on every switched path", async () => {
    const { client } = make((u) => (u.endsWith("/v1/me") ? ok() : failed()));
    for (const [method, path] of [["post", "/v1/documents/abc/cancel"], ["post", "/v1/care-notifications/read"], ["post", "/v1/document-types/abc/retire"], ["get", "/v1/offices"], ["get", "/v1/staff/duplicates"], ["post", "/v1/imports/clients"]] as const) {
      const e = await caught(method === "post" ? client.post(path, {}) : client.get(path));
      expect([path, e.code]).toEqual([path, "not_available"]);
    }
  });
});
