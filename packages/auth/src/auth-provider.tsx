import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";
import type { CognitoAuthClient, CognitoSession } from "./cognito/client";
import { AuthError } from "./errors";

/**
 * Provider-neutral identity for the UI. It is NEVER an authorization source:
 * organization, role, and permissions are resolved server-side (PostgreSQL),
 * from the verified identity only.
 */
export interface AuthUser {
  readonly id: string;
  readonly email?: string | null;
}

export interface AuthSession {
  readonly access_token: string;
  readonly user: AuthUser;
}

export type AuthProviderMode = "supabase" | "cognito";

export interface AuthContextValue {
  provider: AuthProviderMode;
  user: AuthUser | null;
  session: AuthSession | null;
  loading: boolean;
  /** Last authentication error (safe to display; never contains secrets). */
  error: AuthError | null;
  /** True after an active session expired and could not be renewed. */
  sessionExpired: boolean;
  /** Provider-neutral sign-in: Cognito redirects to managed login. */
  signIn: (returnTo?: string) => Promise<void>;
  /** Cognito only: finishes the OAuth callback, returns the safe in-app path. */
  completeSignIn: (callbackUrl: string) => Promise<string>;
  /** Current API access token, refreshed if needed; null when signed out. */
  getAccessToken: () => Promise<string | null>;
  signInWithGithub: (options?: { redirectTo?: string }) => Promise<void>;
  /**
   * Email/password sign-in — the primary path for paying-customer
   * organizations, who can't be expected to have a GitHub account.
   * GitHub OAuth stays available alongside this, not replaced by it.
   * (Supabase mode only; Cognito uses managed login via signIn.)
   */
  signInWithPassword: (email: string, password: string) => Promise<void>;
  /**
   * Sends a password-reset email. Same underlying Supabase mechanism as
   * invite-member's invite email (a link that creates a temporary
   * session), but lands on /reset-password rather than /set-password -
   * a reset should sign the user back out afterward, an invite shouldn't.
   * Cognito mode redirects to managed login's forgot-password flow.
   */
  resetPasswordForEmail: (email: string, redirectTo?: string) => Promise<void>;
  /**
   * Sets a new password for whoever the *current* session belongs to -
   * used by the set-password page, reached either via an invite link or
   * a password-reset link (both leave the browser holding a temporary
   * session, not a fresh sign-in). Supabase mode only.
   */
  updatePassword: (password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const unsupported = (what: string) => async () => {
  throw new AuthError("unsupported_in_mode", `${what} is not available with the current sign-in provider.`);
};

/** CURRENT production provider: Supabase Auth (unchanged behavior). */
export function AuthProvider({
  client,
  children
}: PropsWithChildren<{ client: SupabaseClient }>) {
  const [session, setSession] = useState<Awaited<ReturnType<SupabaseClient["auth"]["getSession"]>>["data"]["session"]>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    void client.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) console.error("Failed to initialize session", error.message);
      setSession(data.session);
      setLoading(false);
    });

    const {
      data: { subscription }
    } = client.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [client]);

  const value = useMemo<AuthContextValue>(
    () => ({
      provider: "supabase",
      user: session?.user ?? null,
      session,
      loading,
      error: null,
      sessionExpired: false,
      signIn: unsupported("Redirect sign-in"),
      completeSignIn: unsupported("OAuth callback handling"),
      getAccessToken: async () => session?.access_token ?? null,
      signInWithGithub: async (options) => {
        const { error } = await client.auth.signInWithOAuth({
          provider: "github",
          options: { redirectTo: options?.redirectTo ?? window.location.origin }
        });
        if (error) throw error;
      },
      signInWithPassword: async (email, password) => {
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
      },
      resetPasswordForEmail: async (email, redirectTo) => {
        const { error } = await client.auth.resetPasswordForEmail(email, {
          redirectTo: redirectTo ?? `${window.location.origin}/reset-password`
        });
        if (error) throw error;
      },
      updatePassword: async (password) => {
        const { error } = await client.auth.updateUser({ password });
        if (error) throw error;
      },
      signOut: async () => {
        const { error } = await client.auth.signOut();
        if (error) throw error;
      }
    }),
    [client, loading, session]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** FUTURE provider: Amazon Cognito (Authorization Code + PKCE). */
export function CognitoAuthProvider({
  client,
  children
}: PropsWithChildren<{ client: CognitoAuthClient }>) {
  const [session, setSession] = useState<CognitoSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AuthError | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = client.subscribe((event) => {
      if (!active) return;
      if (event.type === "signed_in" || event.type === "refreshed") {
        setSession(event.session);
        setSessionExpired(false);
        setError(null);
      } else if (event.type === "signed_out") {
        setSession(null);
      } else {
        setSession(null);
        setSessionExpired(true);
      }
    });
    // Session recovery: a refresh token kept for this tab restores the session.
    void client
      .getSession()
      .then((restored) => {
        if (active) setSession(restored);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof AuthError ? reason : new AuthError("network_error", "Sign-in service unavailable."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [client]);

  const value = useMemo<AuthContextValue>(
    () => ({
      provider: "cognito",
      user: session?.user ?? null,
      session,
      loading,
      error,
      sessionExpired,
      signIn: (returnTo) => client.signIn(returnTo),
      completeSignIn: async (callbackUrl) => {
        try {
          return await client.handleCallback(callbackUrl);
        } catch (reason) {
          const normalized = reason instanceof AuthError ? reason : new AuthError("callback_error", "Sign-in failed.");
          setError(normalized);
          throw normalized;
        }
      },
      getAccessToken: () => client.getAccessToken(),
      signInWithGithub: unsupported("GitHub sign-in"),
      signInWithPassword: unsupported("Password sign-in on this page"),
      resetPasswordForEmail: async () => client.startPasswordReset(),
      updatePassword: unsupported("Setting a password on this page"),
      signOut: () => client.signOut()
    }),
    [client, error, loading, session, sessionExpired]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Explicit provider selection. Unset means the CURRENT production provider
 * (Supabase), so existing deployments are unchanged. Any other value than
 * "supabase" or "cognito" fails closed.
 */
export function resolveAuthMode(value: string | undefined): AuthProviderMode {
  if (value === undefined || value === "" || value === "supabase") return "supabase";
  if (value === "cognito") return "cognito";
  throw new AuthError("config_invalid", `Unknown VITE_AUTH_PROVIDER "${value}". Use "supabase" or "cognito".`);
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
