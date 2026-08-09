import type { Session, SupabaseClient, User } from "@supabase/supabase-js";
import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signInWithGithub: (options?: { redirectTo?: string }) => Promise<void>;
  /**
   * Email/password sign-in — the primary path for paying-customer
   * organizations, who can't be expected to have a GitHub account.
   * GitHub OAuth stays available alongside this, not replaced by it.
   */
  signInWithPassword: (email: string, password: string) => Promise<void>;
  /**
   * Sends a password-reset email. Same underlying Supabase mechanism as
   * invite-member's invite email (a link that creates a temporary
   * session), but lands on /reset-password rather than /set-password -
   * a reset should sign the user back out afterward, an invite shouldn't.
   */
  resetPasswordForEmail: (email: string, redirectTo?: string) => Promise<void>;
  /**
   * Sets a new password for whoever the *current* session belongs to -
   * used by the set-password page, reached either via an invite link or
   * a password-reset link (both leave the browser holding a temporary
   * session, not a fresh sign-in).
   */
  updatePassword: (password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  client,
  children
}: PropsWithChildren<{ client: SupabaseClient }>) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    void client.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) console.error("Failed to initialize session", error);
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
      user: session?.user ?? null,
      session,
      loading,
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

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
