// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAuthError } from "../errors";
import { TEST_ENV, TEST_ISSUER, TEST_SUB, testIssuer } from "../test/tokens";
import { CognitoAuthClient, type CognitoAuthEvent } from "./client";
import { parseCognitoConfig } from "./config";
import { MemoryStore, REFRESH_KEY, TRANSACTION_KEY } from "./storage";

type Issuer = Awaited<ReturnType<typeof testIssuer>>;
let issuer: Issuer;
beforeEach(async () => {
  issuer = await testIssuer();
});

interface Call {
  url: string;
  body: URLSearchParams;
}

function harness(
  options: { persistence?: "memory" | "session"; refreshStore?: MemoryStore; now?: () => number } = {},
) {
  const config = parseCognitoConfig({ ...TEST_ENV, VITE_COGNITO_REFRESH_PERSISTENCE: options.persistence ?? "session" });
  const calls: Call[] = [];
  const responses: Array<() => Promise<Response> | Response> = [];
  const navigations: string[] = [];
  const transactionStore = new MemoryStore();
  const refreshStore = options.refreshStore ?? new MemoryStore();
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: new URLSearchParams(String(init.body)) });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  });
  const client = new CognitoAuthClient(config, {
    fetch,
    transactionStore,
    refreshStore,
    navigate: (url) => navigations.push(url),
    ...(options.now ? { now: options.now } : {}),
  });
  const events: CognitoAuthEvent["type"][] = [];
  client.subscribe((e) => events.push(e.type));
  return { config, client, calls, responses, navigations, transactionStore, refreshStore, events, fetch };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function tokenResponse(nonce: string | undefined, opts: { sub?: string; expiresIn?: number; refresh?: boolean } = {}) {
  const sub = opts.sub ?? TEST_SUB;
  return {
    access_token: await issuer.accessToken({ sub }, { expiresInSeconds: opts.expiresIn ?? 3600 }),
    id_token: await issuer.idToken({ sub, ...(nonce ? { nonce } : {}) }),
    ...(opts.refresh === false ? {} : { refresh_token: "synthetic-refresh-token" }),
    expires_in: opts.expiresIn ?? 3600,
    token_type: "Bearer",
  };
}

async function startSignIn(h: ReturnType<typeof harness>, returnTo = "/service-verification") {
  await h.client.signIn(returnTo);
  const url = new URL(h.navigations.at(-1)!);
  return { url, state: url.searchParams.get("state")!, nonce: url.searchParams.get("nonce")! };
}

describe("CognitoAuthClient — sign-in (Authorization Code + PKCE)", () => {
  it("redirects to /oauth2/authorize with code, S256 challenge, state, nonce, and no secret", async () => {
    const h = harness();
    const { url } = await startSignIn(h);
    expect(url.origin + url.pathname).toBe(`${TEST_ENV.VITE_COGNITO_DOMAIN}/oauth2/authorize`);
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("redirect_uri")).toBe(TEST_ENV.VITE_COGNITO_REDIRECT_URI);
    expect(p.get("client_id")).toBe(TEST_ENV.VITE_COGNITO_CLIENT_ID);
    expect(p.get("scope")).toContain("openid");
    expect(p.has("client_secret")).toBe(false);
    expect(p.has("code_verifier")).toBe(false);
    // Verifier stays in the tab, never in the URL.
    const tx = JSON.parse(h.transactionStore.getItem(TRANSACTION_KEY)!) as { codeVerifier: string };
    expect(url.toString()).not.toContain(tx.codeVerifier);
  });

  it("completes the callback: exchanges the code with the verifier and returns the safe path", async () => {
    const h = harness();
    const { state, nonce } = await startSignIn(h, "/visits?x=1");
    const tx = JSON.parse(h.transactionStore.getItem(TRANSACTION_KEY)!) as { codeVerifier: string };
    const body = await tokenResponse(nonce);
    h.responses.push(() => json(body));
    const returnTo = await h.client.handleCallback(`${TEST_ENV.VITE_COGNITO_REDIRECT_URI}?code=abc&state=${state}`);
    expect(returnTo).toBe("/visits?x=1");
    expect(h.calls[0]!.url).toBe(`${TEST_ENV.VITE_COGNITO_DOMAIN}/oauth2/token`);
    expect(h.calls[0]!.body.get("grant_type")).toBe("authorization_code");
    expect(h.calls[0]!.body.get("code_verifier")).toBe(tx.codeVerifier);
    expect(h.calls[0]!.body.has("client_secret")).toBe(false);
    const session = await h.client.getSession();
    expect(session?.user.id).toBe(TEST_SUB);
    expect(session?.access_token).toBe(body.access_token);
    expect(h.client.hasIdToken()).toBe(true);
    expect(h.events).toEqual(["signed_in"]);
    // Transaction is single use.
    expect(h.transactionStore.getItem(TRANSACTION_KEY)).toBeNull();
  });

  it("an unsafe returnTo is replaced by /", async () => {
    const h = harness();
    const { state, nonce } = await startSignIn(h, "https://evil.example/steal");
    h.responses.push(async () => json(await tokenResponse(nonce)));
    expect(await h.client.handleCallback(`${TEST_ENV.VITE_COGNITO_REDIRECT_URI}?code=abc&state=${state}`)).toBe("/");
  });

  it("rejects a state mismatch without calling the token endpoint", async () => {
    const h = harness();
    await startSignIn(h);
    await expect(h.client.handleCallback(`${TEST_ENV.VITE_COGNITO_REDIRECT_URI}?code=abc&state=forged`)).rejects.toMatchObject({
      code: "state_mismatch",
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("a replayed callback fails (transaction consumed)", async () => {
    const h = harness();
    const { state, nonce } = await startSignIn(h);
    h.responses.push(async () => json(await tokenResponse(nonce)));
    const cb = `${TEST_ENV.VITE_COGNITO_REDIRECT_URI}?code=abc&state=${state}`;
    await h.client.handleCallback(cb);
    await expect(h.client.handleCallback(cb)).rejects.toMatchObject({ code: "transaction_expired" });
  });

  it("an expired transaction is rejected", async () => {
    let now = Date.now();
    const h = harness({ now: () => now });
    const { state } = await startSignIn(h);
    now += 11 * 60 * 1000;
    await expect(h.client.handleCallback(`${TEST_ENV.VITE_COGNITO_REDIRECT_URI}?code=abc&state=${state}`)).rejects.toMatchObject({
      code: "transaction_expired",
    });
  });

  it("maps an error parameter to callback_error and does not echo provider text", async () => {
    const h = harness();
    const { state } = await startSignIn(h);
    const err = await h.client
      .handleCallback(`${TEST_ENV.VITE_COGNITO_REDIRECT_URI}?error=server_error&error_description=%3Cscript%3E&state=${state}`)
      .catch((e: unknown) => e);
    expect(isAuthError(err) && err.code).toBe("callback_error");
    expect((err as Error).message).not.toContain("script");
  });

  it("access_denied (user cancelled) gives a cancellation message", async () => {
    const h = harness();
    const { state } = await startSignIn(h);
    await expect(h.client.handleCallback(`${TEST_ENV.VITE_COGNITO_REDIRECT_URI}?error=access_denied&state=${state}`)).rejects.toThrow(
      /cancelled/,
    );
  });

  it("rejects a callback with no code", async () => {
    const h = harness();
    const { state } = await startSignIn(h);
    await expect(h.client.handleCallback(`${TEST_ENV.VITE_COGNITO_REDIRECT_URI}?state=${state}`)).rejects.toMatchObject({
      code: "missing_code",
    });
  });

  it("rejects an ID token whose nonce does not match", async () => {
    const h = harness();
    const { state } = await startSignIn(h);
    h.responses.push(async () => json(await tokenResponse("other-nonce")));
    await expect(h.client.handleCallback(`${TEST_ENV.VITE_COGNITO_REDIRECT_URI}?code=abc&state=${state}`)).rejects.toMatchObject({
      code: "nonce_mismatch",
    });
    expect(await h.client.getSession()).toBeNull();
  });

  it.each([
    ["wrong issuer", { iss: "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_OTHER" }],
    ["wrong audience", { aud: "someotherclient00000000000" }],
    ["access token presented as ID token", { token_use: "access" }],
  ])("rejects an ID token with %s", async (_label, overrides) => {
    const h = harness();
    const { state, nonce } = await startSignIn(h);
    const body = await tokenResponse(nonce);
    body.id_token = await issuer.idToken({ nonce, ...overrides });
    h.responses.push(() => json(body));
    await expect(h.client.handleCallback(`${TEST_ENV.VITE_COGNITO_REDIRECT_URI}?code=abc&state=${state}`)).rejects.toMatchObject({
      code: "invalid_token",
    });
  });

  it("rejects a corrupted token response", async () => {
    const h = harness();
    const { state, nonce } = await startSignIn(h);
    const body = await tokenResponse(nonce);
    body.id_token = "not.a.jwt!";
    h.responses.push(() => json(body));
    await expect(h.client.handleCallback(`${TEST_ENV.VITE_COGNITO_REDIRECT_URI}?code=abc&state=${state}`)).rejects.toMatchObject({
      code: "invalid_token",
    });
  });

  it("a failed exchange (HTTP 400) gives token_exchange_failed without the response body", async () => {
    const h = harness();
    const { state } = await startSignIn(h);
    h.responses.push(() => json({ error: "invalid_grant", error_description: "secret-detail" }, 400));
    const err = await h.client.handleCallback(`${TEST_ENV.VITE_COGNITO_REDIRECT_URI}?code=abc&state=${state}`).catch((e: unknown) => e);
    expect(isAuthError(err) && err.code).toBe("token_exchange_failed");
    expect((err as Error).message).not.toContain("secret-detail");
  });

  it("a network failure gives network_error", async () => {
    const h = harness();
    const { state } = await startSignIn(h);
    h.responses.push(() => Promise.reject(new TypeError("fetch failed")));
    await expect(h.client.handleCallback(`${TEST_ENV.VITE_COGNITO_REDIRECT_URI}?code=abc&state=${state}`)).rejects.toMatchObject({
      code: "network_error",
    });
  });
});

describe("CognitoAuthClient — session, refresh, expiry", () => {
  async function signedIn(h: ReturnType<typeof harness>, opts: { expiresIn?: number } = {}) {
    const { state, nonce } = await startSignIn(h);
    h.responses.push(async () => json(await tokenResponse(nonce, opts)));
    await h.client.handleCallback(`${TEST_ENV.VITE_COGNITO_REDIRECT_URI}?code=abc&state=${state}`);
  }

  it("refreshes when the access token is within the skew window", async () => {
    const h = harness();
    await signedIn(h, { expiresIn: 30 });
    h.responses.push(async () => json(await tokenResponse(undefined, { refresh: false })));
    const token = await h.client.getAccessToken();
    expect(h.calls.at(-1)!.body.get("grant_type")).toBe("refresh_token");
    expect(h.calls.at(-1)!.body.get("refresh_token")).toBe("synthetic-refresh-token");
    expect(token).toBeTruthy();
    expect(h.events).toEqual(["signed_in", "refreshed"]);
  });

  it("concurrent callers share one refresh request (single flight)", async () => {
    const h = harness();
    await signedIn(h, { expiresIn: 30 });
    h.responses.push(async () => json(await tokenResponse(undefined, { refresh: false })));
    const [a, b, c] = await Promise.all([h.client.getAccessToken(), h.client.getAccessToken(), h.client.getAccessToken()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(h.calls.filter((c2) => c2.body.get("grant_type") === "refresh_token")).toHaveLength(1);
  });

  it("a rejected refresh clears the session and emits session_expired", async () => {
    const h = harness();
    await signedIn(h, { expiresIn: 30 });
    h.responses.push(() => json({ error: "invalid_grant" }, 400));
    expect(await h.client.getSession()).toBeNull();
    expect(h.events.at(-1)).toBe("session_expired");
    expect(h.refreshStore.getItem(REFRESH_KEY)).toBeNull();
    expect(h.client.hasIdToken()).toBe(false);
  });

  it("a refresh that returns a different identity is rejected", async () => {
    const h = harness();
    await signedIn(h, { expiresIn: 30 });
    h.responses.push(async () =>
      json(await tokenResponse(undefined, { sub: "99999999-2222-4333-8444-555555555555", refresh: false })),
    );
    expect(await h.client.getSession()).toBeNull();
    expect(h.events.at(-1)).toBe("session_expired");
  });

  it("without a refresh token an expired session is cleared", async () => {
    const h = harness();
    const { state, nonce } = await startSignIn(h);
    h.responses.push(async () => json(await tokenResponse(nonce, { expiresIn: 30, refresh: false })));
    // Token endpoint omitting refresh_token on code exchange is rejected outright.
    await expect(h.client.handleCallback(`${TEST_ENV.VITE_COGNITO_REDIRECT_URI}?code=abc&state=${state}`)).rejects.toMatchObject({
      code: "token_exchange_failed",
    });
    expect(await h.client.getSession()).toBeNull();
  });

  it("restores a session in a reloaded tab from the sessionStorage refresh token", async () => {
    const store = new MemoryStore();
    const first = harness({ refreshStore: store });
    await signedIn(first);
    expect(store.getItem(REFRESH_KEY)).toBe("synthetic-refresh-token");

    const reloaded = harness({ refreshStore: store });
    reloaded.responses.push(async () => json(await tokenResponse(undefined, { refresh: false })));
    const session = await reloaded.client.getSession();
    expect(session?.user.id).toBe(TEST_SUB);
  });

  it("memory persistence never writes the refresh token to the provided store", async () => {
    const store = new MemoryStore();
    const h = harness({ persistence: "memory", refreshStore: store });
    await signedIn(h);
    expect(store.getItem(REFRESH_KEY)).toBeNull();
  });

  it("access and ID tokens are never written to any store", async () => {
    const h = harness();
    await signedIn(h);
    const session = await h.client.getSession();
    for (const store of [h.transactionStore, h.refreshStore]) {
      for (const key of [TRANSACTION_KEY, REFRESH_KEY]) {
        expect(store.getItem(key) ?? "").not.toContain(session!.access_token);
      }
    }
  });
});

describe("CognitoAuthClient — sign-out", () => {
  it("revokes the refresh token, clears state, and redirects to /logout with logout_uri", async () => {
    const h = harness();
    const { state, nonce } = await startSignIn(h);
    h.responses.push(async () => json(await tokenResponse(nonce)));
    await h.client.handleCallback(`${TEST_ENV.VITE_COGNITO_REDIRECT_URI}?code=abc&state=${state}`);
    h.responses.push(() => new Response(null, { status: 200 }));
    await h.client.signOut();
    expect(h.calls.at(-1)!.url).toBe(`${TEST_ENV.VITE_COGNITO_DOMAIN}/oauth2/revoke`);
    expect(h.calls.at(-1)!.body.get("token")).toBe("synthetic-refresh-token");
    const logout = new URL(h.navigations.at(-1)!);
    expect(logout.pathname).toBe("/logout");
    expect(logout.searchParams.get("logout_uri")).toBe(TEST_ENV.VITE_COGNITO_LOGOUT_URI);
    expect(await h.client.getSession()).toBeNull();
    expect(h.refreshStore.getItem(REFRESH_KEY)).toBeNull();
    expect(h.events.at(-1)).toBe("signed_out");
  });

  it("a failed revocation still signs out locally", async () => {
    const h = harness();
    const { state, nonce } = await startSignIn(h);
    h.responses.push(async () => json(await tokenResponse(nonce)));
    await h.client.handleCallback(`${TEST_ENV.VITE_COGNITO_REDIRECT_URI}?code=abc&state=${state}`);
    h.responses.push(() => Promise.reject(new TypeError("offline")));
    await h.client.signOut();
    expect(await h.client.getSession()).toBeNull();
    expect(h.navigations.at(-1)).toContain("/logout");
  });

  it("H07: signing out in one tab ends the session held by another tab of the same browser (no token stays usable on a shared device)", async () => {
    const listeners = new Set<(m: unknown) => void>();
    const bus = { post: (m: unknown) => { for (const l of [...listeners]) l(m); }, onMessage: (l: (m: unknown) => void) => { listeners.add(l); } };
    const tab = async () => {
      const config = parseCognitoConfig({ ...TEST_ENV, VITE_COGNITO_REFRESH_PERSISTENCE: "session" });
      const calls: Array<{ url: string; body: URLSearchParams }> = [];
      const navigations: string[] = [];
      const responses: Array<() => Promise<Response> | Response> = [];
      const store = new MemoryStore();
      const client = new CognitoAuthClient(config, {
        fetch: vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, body: new URLSearchParams(String(init.body)) }); const n = responses.shift(); if (!n) throw new Error("unexpected fetch"); return n(); }),
        transactionStore: new MemoryStore(), refreshStore: store, navigate: (u) => navigations.push(u), broadcast: bus,
      });
      const events: CognitoAuthEvent["type"][] = [];
      client.subscribe((e) => events.push(e.type));
      await client.signIn("/service-verification");
      const url = new URL(navigations.at(-1)!);
      responses.push(async () => json(await tokenResponse(url.searchParams.get("nonce")!)));
      await client.handleCallback(`${TEST_ENV.VITE_COGNITO_REDIRECT_URI}?code=abc&state=${url.searchParams.get("state")!}`);
      return { client, calls, navigations, responses, store, events };
    };
    const tabA = await tab();
    const tabB = await tab();
    expect((await tabB.client.getSession())?.access_token).toBeTruthy();
    tabA.responses.push(() => new Response(null, { status: 200 }));
    tabB.responses.push(() => new Response(null, { status: 200 }));
    await tabA.client.signOut();
    await new Promise((r) => setTimeout(r, 0));
    expect(tabA.events.at(-1)).toBe("signed_out");
    // Tab B was told: its tokens are gone, its own refresh token is revoked, and the app is told to show the sign-in screen.
    expect(tabB.events.at(-1)).toBe("signed_out");
    expect(tabB.store.getItem(REFRESH_KEY)).toBeNull();
    expect(await tabB.client.getSession()).toBeNull();
    expect(tabB.calls.at(-1)!.url).toMatch(/\/oauth2\/revoke$/);
    // No loop and no second managed-login logout redirect from the receiving tab.
    expect(tabB.navigations.filter((u) => u.includes("/logout"))).toHaveLength(0);
    expect(tabA.calls.filter((c) => c.url.endsWith("/oauth2/revoke"))).toHaveLength(1);
  });

  it("password reset goes to managed login's forgotPassword", () => {
    const h = harness();
    h.client.startPasswordReset();
    const url = new URL(h.navigations.at(-1)!);
    expect(url.pathname).toBe("/forgotPassword");
    expect(url.searchParams.get("redirect_uri")).toBe(TEST_ENV.VITE_COGNITO_REDIRECT_URI);
  });
});

describe("CognitoAuthClient — no token or code logging", () => {
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];
  beforeEach(() => {
    for (const m of ["log", "info", "warn", "error", "debug"] as const) spies.push(vi.spyOn(console, m).mockImplementation(() => {}));
  });
  afterEach(() => {
    spies.splice(0).forEach((s) => s.mockRestore());
  });

  it("a full sign-in, refresh, failure and sign-out writes nothing to the console", async () => {
    const h = harness();
    const { state, nonce } = await startSignIn(h);
    h.responses.push(async () => json(await tokenResponse(nonce, { expiresIn: 30 })));
    await h.client.handleCallback(`${TEST_ENV.VITE_COGNITO_REDIRECT_URI}?code=secretcode&state=${state}`);
    h.responses.push(() => json({ error: "invalid_grant" }, 400));
    await h.client.getSession();
    await h.client.signOut();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("AuthError messages never contain token, code, verifier, or issuer values", async () => {
    const h = harness();
    const { state } = await startSignIn(h);
    const bad = await tokenResponse("wrong");
    h.responses.push(() => json(bad));
    const err = (await h.client.handleCallback(`${TEST_ENV.VITE_COGNITO_REDIRECT_URI}?code=secretcode&state=${state}`).catch((e: unknown) => e)) as Error;
    for (const value of [bad.access_token, bad.id_token, "secretcode", state, TEST_ISSUER, TEST_SUB]) {
      expect(err.message).not.toContain(value);
    }
  });
});
