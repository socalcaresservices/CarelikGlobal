/**
 * Supabase marks a password-recovery link with `type=recovery`, either in
 * the query string (PKCE) or the hash (implicit flow). If that lands
 * anywhere other than /reset-password - most likely because the
 * project's Auth redirect-URL allowlist doesn't include the exact
 * redirectTo used, so Supabase fell back to its bare Site URL - this
 * says where to send the browser instead, preserving the query/hash so
 * the code/token survives the move. Returns null when no redirect is
 * needed.
 */
export function getRecoveryRedirectPath(pathname: string, search: string, hash: string): string | null {
  if (pathname === "/reset-password") return null;

  const query = new URLSearchParams(search);
  const fragment = new URLSearchParams(hash.replace(/^#/, ""));
  if (query.get("type") !== "recovery" && fragment.get("type") !== "recovery") {
    return null;
  }

  return `/reset-password${search}${hash}`;
}
