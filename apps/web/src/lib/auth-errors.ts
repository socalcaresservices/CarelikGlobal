/**
 * Supabase auth errors are usually a real `AuthError` (an `Error`
 * subclass, so `.message` is safe) but `Error.prototype.message` is
 * non-enumerable - anything that lands as a plain object instead (a
 * rejected fetch, a serialized/deserialized error crossing a boundary)
 * renders as `{}` if handed to `JSON.stringify` or displayed without
 * unwrapping. This pulls a human-readable string out of whatever shape
 * shows up, so the UI always has real text to show.
 */
export function getAuthErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (error && typeof error === "object") {
    const candidate = error as Record<string, unknown>;
    for (const key of ["message", "error_description", "msg", "error"]) {
      const value = candidate[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }

  return fallback;
}
