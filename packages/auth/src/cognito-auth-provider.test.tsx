import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CognitoAuthProvider, useAuth } from "./auth-provider";
import type { CognitoAuthClient, CognitoAuthEvent, CognitoSession } from "./cognito/client";
import { AuthError } from "./errors";

const session: CognitoSession = {
  user: { id: "11111111-2222-4333-8444-555555555555", email: "caregiver.a1@example.test", emailVerified: true },
  access_token: "synthetic-access",
  expires_at: 4_000_000_000,
};

function fakeClient(initial: CognitoSession | null | Error = null) {
  let listener: ((e: CognitoAuthEvent) => void) | null = null;
  const unsubscribe = vi.fn();
  const client = {
    subscribe: vi.fn((l: (e: CognitoAuthEvent) => void) => {
      listener = l;
      return unsubscribe;
    }),
    getSession: vi.fn(() => (initial instanceof Error ? Promise.reject(initial) : Promise.resolve(initial))),
    getAccessToken: vi.fn(async () => "synthetic-access"),
    signIn: vi.fn(async () => {}),
    handleCallback: vi.fn(async () => "/service-verification"),
    startPasswordReset: vi.fn(),
    signOut: vi.fn(async () => {}),
  };
  return {
    client: client as unknown as CognitoAuthClient,
    raw: client,
    unsubscribe,
    emit: (e: CognitoAuthEvent) => act(() => listener?.(e)),
  };
}

let ctx: ReturnType<typeof useAuth>;
function Probe() {
  ctx = useAuth();
  return (
    <div>
      <span>{ctx.loading ? "loading" : ctx.user ? `user:${ctx.user.id}` : "anonymous"}</span>
      <span>{ctx.sessionExpired ? "expired" : "fresh"}</span>
      <span>{ctx.error ? `error:${ctx.error.code}` : "no-error"}</span>
      <span>provider:{ctx.provider}</span>
    </div>
  );
}

describe("CognitoAuthProvider", () => {
  it("starts loading, then recovers an existing session", async () => {
    const f = fakeClient(session);
    render(<CognitoAuthProvider client={f.client}><Probe /></CognitoAuthProvider>);
    expect(screen.getByText("loading")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(`user:${session.user.id}`)).toBeInTheDocument());
    expect(screen.getByText("provider:cognito")).toBeInTheDocument();
  });

  it("shows anonymous when no session can be recovered", async () => {
    render(<CognitoAuthProvider client={fakeClient(null).client}><Probe /></CognitoAuthProvider>);
    await waitFor(() => expect(screen.getByText("anonymous")).toBeInTheDocument());
  });

  it("surfaces a recovery failure as a safe error and stops loading", async () => {
    const f = fakeClient(new AuthError("network_error", "offline"));
    render(<CognitoAuthProvider client={f.client}><Probe /></CognitoAuthProvider>);
    await waitFor(() => expect(screen.getByText("error:network_error")).toBeInTheDocument());
    expect(screen.getByText("anonymous")).toBeInTheDocument();
  });

  it("session_expired event clears the user and flags expiry; signed_in resets it", async () => {
    const f = fakeClient(session);
    render(<CognitoAuthProvider client={f.client}><Probe /></CognitoAuthProvider>);
    await waitFor(() => expect(screen.getByText(`user:${session.user.id}`)).toBeInTheDocument());
    f.emit({ type: "session_expired" });
    expect(screen.getByText("anonymous")).toBeInTheDocument();
    expect(screen.getByText("expired")).toBeInTheDocument();
    f.emit({ type: "signed_in", session });
    expect(screen.getByText("fresh")).toBeInTheDocument();
  });

  it("signed_out clears the user without flagging expiry", async () => {
    const f = fakeClient(session);
    render(<CognitoAuthProvider client={f.client}><Probe /></CognitoAuthProvider>);
    await waitFor(() => expect(screen.getByText(`user:${session.user.id}`)).toBeInTheDocument());
    f.emit({ type: "signed_out" });
    expect(screen.getByText("anonymous")).toBeInTheDocument();
    expect(screen.getByText("fresh")).toBeInTheDocument();
  });

  it("delegates signIn, completeSignIn, getAccessToken, reset and signOut to the client", async () => {
    const f = fakeClient(null);
    render(<CognitoAuthProvider client={f.client}><Probe /></CognitoAuthProvider>);
    await waitFor(() => expect(screen.getByText("anonymous")).toBeInTheDocument());
    await ctx.signIn("/visits");
    expect(f.raw.signIn).toHaveBeenCalledWith("/visits");
    expect(await ctx.completeSignIn("https://app.example.test/auth/callback?code=x&state=y")).toBe("/service-verification");
    expect(await ctx.getAccessToken()).toBe("synthetic-access");
    await ctx.resetPasswordForEmail("ignored@example.test");
    expect(f.raw.startPasswordReset).toHaveBeenCalled();
    await ctx.signOut();
    expect(f.raw.signOut).toHaveBeenCalled();
  });

  it("completeSignIn failures are exposed as error state", async () => {
    const f = fakeClient(null);
    f.raw.handleCallback.mockRejectedValueOnce(new AuthError("state_mismatch", "x"));
    render(<CognitoAuthProvider client={f.client}><Probe /></CognitoAuthProvider>);
    await waitFor(() => expect(screen.getByText("anonymous")).toBeInTheDocument());
    await act(async () => {
      await expect(ctx.completeSignIn("https://app.example.test/auth/callback")).rejects.toMatchObject({ code: "state_mismatch" });
    });
    expect(screen.getByText("error:state_mismatch")).toBeInTheDocument();
  });

  it("Supabase-only methods fail with unsupported_in_mode (no silent password handling)", async () => {
    render(<CognitoAuthProvider client={fakeClient(null).client}><Probe /></CognitoAuthProvider>);
    await waitFor(() => expect(screen.getByText("anonymous")).toBeInTheDocument());
    await expect(ctx.signInWithPassword("a@example.test", "pw")).rejects.toMatchObject({ code: "unsupported_in_mode" });
    await expect(ctx.updatePassword("pw")).rejects.toMatchObject({ code: "unsupported_in_mode" });
    await expect(ctx.signInWithGithub()).rejects.toMatchObject({ code: "unsupported_in_mode" });
  });

  it("unsubscribes on unmount", async () => {
    const f = fakeClient(null);
    const { unmount } = render(<CognitoAuthProvider client={f.client}><Probe /></CognitoAuthProvider>);
    await waitFor(() => expect(screen.getByText("anonymous")).toBeInTheDocument());
    unmount();
    expect(f.unsubscribe).toHaveBeenCalled();
  });
});
