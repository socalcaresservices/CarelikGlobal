/**
 * Storage for the in-flight OAuth transaction and the refresh token.
 *
 * Threat model (see docs/aws/PHASE_3_AUTH_ARCHITECTURE.md):
 * - Access and ID tokens live in MEMORY only (never written to any storage).
 * - The PKCE transaction (state, verifier, nonce, return path) lives in
 *   sessionStorage for the few seconds of the redirect round-trip; it is
 *   tab-scoped, expires after 10 minutes, and is deleted on first use.
 * - The refresh token is in memory, or in sessionStorage when
 *   refreshTokenPersistence = "session" (survives reload in the same tab,
 *   gone when the tab closes). Never localStorage.
 * Anything readable by JavaScript is exposed to XSS; persistence is therefore
 * minimized, and Content-Security-Policy hardening remains a Phase 7 item.
 */

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryStore implements KeyValueStore {
  private readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

export interface PendingTransaction {
  readonly state: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly returnTo: string;
  readonly createdAt: number;
}

export const TRANSACTION_KEY = "ogevia.auth.tx";
export const REFRESH_KEY = "ogevia.auth.rt";
export const TRANSACTION_TTL_MS = 10 * 60 * 1000;

export function saveTransaction(store: KeyValueStore, tx: PendingTransaction): void {
  store.setItem(TRANSACTION_KEY, JSON.stringify(tx));
}

/** Reads AND deletes the transaction: a callback can be processed only once. */
export function takeTransaction(store: KeyValueStore, now: number): PendingTransaction | null {
  const raw = store.getItem(TRANSACTION_KEY);
  store.removeItem(TRANSACTION_KEY);
  if (!raw) return null;
  try {
    const tx = JSON.parse(raw) as PendingTransaction;
    if (
      typeof tx.state !== "string" || typeof tx.codeVerifier !== "string" ||
      typeof tx.nonce !== "string" || typeof tx.returnTo !== "string" ||
      typeof tx.createdAt !== "number"
    ) {
      return null;
    }
    if (now - tx.createdAt > TRANSACTION_TTL_MS) return null;
    return tx;
  } catch {
    return null;
  }
}

/**
 * Only same-origin, app-relative paths are restored after login. Anything
 * else (absolute URLs, protocol-relative "//", backslashes, auth routes)
 * becomes "/".
 */
export function sanitizeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  if (/^\/(auth\/callback|login)(\/|\?|$)/.test(value)) return "/";
  if (/[\u0000-\u001f]/.test(value)) return "/";
  return value;
}
