import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { AuthProvider, useAuth } from "./auth-provider";

type AuthStateCallback = (event: string, session: Session | null) => void;

function createFakeClient(initialSession: Session | null = null) {
  let authStateCallback: AuthStateCallback | null = null;
  const unsubscribe = vi.fn();

  const client = {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: initialSession }, error: null }),
      onAuthStateChange: vi.fn((callback: AuthStateCallback) => {
        authStateCallback = callback;
        return { data: { subscription: { unsubscribe } } };
      }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      signInWithOAuth: vi.fn().mockResolvedValue({ data: {}, error: null })
    }
  } as unknown as SupabaseClient;

  return {
    client,
    unsubscribe,
    emitAuthStateChange: (session: Session | null) => {
      act(() => {
        authStateCallback?.("SIGNED_IN", session);
      });
    }
  };
}

function Probe() {
  const { user, loading, signOut, signInWithGithub } = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="user-email">{user?.email ?? "none"}</span>
      <button onClick={() => void signOut()}>sign out</button>
      <button onClick={() => void signInWithGithub()}>sign in</button>
    </div>
  );
}

const fakeSession = {
  access_token: "token",
  user: { id: "user-1", email: "person@example.com" }
} as unknown as Session;

describe("AuthProvider / useAuth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts loading, then resolves to no user when there is no session", async () => {
    const { client } = createFakeClient(null);
    render(
      <AuthProvider client={client}>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    expect(screen.getByTestId("user-email")).toHaveTextContent("none");
  });

  it("resolves to the signed-in user from getSession", async () => {
    const { client } = createFakeClient(fakeSession);
    render(
      <AuthProvider client={client}>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() =>
      expect(screen.getByTestId("user-email")).toHaveTextContent("person@example.com")
    );
  });

  it("updates when onAuthStateChange fires", async () => {
    const { client, emitAuthStateChange } = createFakeClient(null);
    render(
      <AuthProvider client={client}>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId("user-email")).toHaveTextContent("none"));

    emitAuthStateChange(fakeSession);

    await waitFor(() =>
      expect(screen.getByTestId("user-email")).toHaveTextContent("person@example.com")
    );
  });

  it("unsubscribes from auth state changes on unmount", async () => {
    const { client, unsubscribe } = createFakeClient(null);
    const { unmount } = render(
      <AuthProvider client={client}>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("signOut calls client.auth.signOut", async () => {
    const { client } = createFakeClient(fakeSession);
    render(
      <AuthProvider client={client}>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));

    screen.getByText("sign out").click();
    await waitFor(() => expect(client.auth.signOut).toHaveBeenCalledTimes(1));
  });

  it("signInWithGithub calls signInWithOAuth with the github provider", async () => {
    const { client } = createFakeClient(null);
    render(
      <AuthProvider client={client}>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));

    screen.getByText("sign in").click();
    await waitFor(() =>
      expect(client.auth.signInWithOAuth).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "github" })
      )
    );
  });

  it("useAuth throws when used outside AuthProvider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow("useAuth must be used within AuthProvider");
    consoleError.mockRestore();
  });
});
