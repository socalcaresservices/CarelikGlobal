/**
 * Normalized authentication errors. Messages are safe to show users and never
 * include tokens, authorization codes, PKCE verifiers, or passwords.
 */
export type AuthErrorCode =
  | "config_invalid"
  | "unsupported_in_mode"
  | "state_mismatch"
  | "callback_error"
  | "missing_code"
  | "token_exchange_failed"
  | "invalid_token"
  | "nonce_mismatch"
  | "session_expired"
  | "refresh_failed"
  | "network_error"
  | "transaction_expired"
  | "not_authenticated";

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

export function isAuthError(value: unknown): value is AuthError {
  return value instanceof AuthError;
}
