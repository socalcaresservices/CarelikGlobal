/**
 * supabase-js's `functions.invoke` throws a generic FunctionsHttpError
 * ("Edge Function returned a non-2xx status code") whenever the edge
 * function responds with a non-2xx status - it does NOT read the JSON
 * body of the response into the error message. Every edge function in
 * this repo always responds with `{ error: "<specific reason>" }` on
 * failure, so this pulls that real message back out of `error.context`,
 * the raw Response object the client library hands back. Without this,
 * every failure - wrong permission, duplicate email, bad file type -
 * looks identical to the user.
 *
 * Shared by lib/invitations.ts and lib/document-uploads.ts rather than
 * each defining its own copy.
 */
export async function extractEdgeFunctionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const context = (error as { context?: unknown } | null)?.context;
  if (context instanceof Response) {
    try {
      const body = (await context.clone().json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error.length > 0) {
        return body.error;
      }
    } catch {
      // Response body wasn't JSON - fall through to the generic message.
    }
  }
  return error instanceof Error ? error.message : fallback;
}
