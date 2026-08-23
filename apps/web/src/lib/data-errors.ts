/**
 * Turns a Supabase/PostgREST error into a message a user can actually
 * act on. The raw error for a row-level-security rejection is
 * "new row violates row-level security policy for table \"clients\"" -
 * technically not silent (it does reach the UI), but it gives no hint
 * that the fix is "you're not actually a member of the organization
 * you're currently viewing" rather than a data problem with the form.
 * That distinction matters here specifically because the active
 * organization can get out of sync with the signed-in account (see
 * organization-provider.tsx) - when it does, every insert/update fails
 * this way, and a generic Postgres error reads like the form is broken
 * rather than like an access/context problem.
 */
export function getSaveErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const candidate = error as Record<string, unknown>;
    const code = typeof candidate.code === "string" ? candidate.code : undefined;
    const message = typeof candidate.message === "string" ? candidate.message : undefined;

    if (code === "42501" || (message && /row-level security policy/i.test(message))) {
      return "You don't have permission to save this in the current organization. Confirm you're in the right organization (check the organization switcher) and that your account has the needed access, then try again.";
    }
    if (code === "23505" || (message && /duplicate key value/i.test(message))) {
      return "That record already exists - check for a duplicate before saving again.";
    }
    if (message) {
      return message;
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}
