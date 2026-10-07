import { AuthError } from "../errors";
import { accessTokenExpiry, validateIdTokenClaims } from "./claims";
import { cognitoIssuer, type CognitoAuthConfig } from "./config";
import {
  authorizeUrl,
  exchangeCode,
  forgotPasswordUrl,
  logoutUrl,
  refreshTokens,
  revokeRefreshToken,
  type FetchLike,
  type TokenResponse,
} from "./oidc";
import { codeChallengeS256, generateCodeVerifier, generateNonce, generateState, safeEqual } from "./pkce";
import {
  MemoryStore,
  REFRESH_KEY,
  sanitizeReturnTo,
  saveTransaction,
  takeTransaction,
  type KeyValueStore,
} from "./storage";

/** Provider-neutral identity shown to the UI. NOT an authorization source. */
export interface CognitoUser {
  /** Cognito `sub`. The API resolves the Ogevia app user from it server-side. */
  readonly id: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
}

export interface CognitoSession {
  readonly user: CognitoUser;
  /** Access token for API calls (Authorization: Bearer). Kept in memory only. */
  readonly access_token: string;
  /** Epoch seconds. */
  readonly expires_at: number;
}

export type CognitoAuthEvent =
  | { type: "signed_in"; session: CognitoSession }
  | { type: "refreshed"; session: CognitoSession }
  | { type: "signed_out" }
  | { type: "session_expired" };

export interface CognitoClientDeps {
  readonly fetch?: FetchLike;
  /** sessionStorage in browsers; tab-scoped. */
  readonly transactionStore?: KeyValueStore;
  /** Used only when config.refreshTokenPersistence === "session". */
  readonly refreshStore?: KeyValueStore;
  readonly navigate?: (url: string) => void;
  readonly now?: () => number;
}

/** Refresh this many seconds before the access token expires. */
export const REFRESH_SKEW_SECONDS = 60;

export class CognitoAuthClient {
  private readonly fetchImpl: FetchLike;
  private readonly transactionStore: KeyValueStore;
  private readonly refreshStore: KeyValueStore;
  private readonly navigate: (url: string) => void;
  private readonly now: () => number;
  private readonly issuer: string;
  private session: CognitoSession | null = null;
  private idToken: string | null = null;
  private refreshToken: string | null = null;
  private refreshing: Promise<CognitoSession | null> | null = null;
  private readonly listeners = new Set<(event: CognitoAuthEvent) => void>();

  constructor(
    private readonly config: CognitoAuthConfig,
    deps: CognitoClientDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.transactionStore = deps.transactionStore ?? globalThis.sessionStorage ?? new MemoryStore();
    this.refreshStore =
      config.refreshTokenPersistence === "session"
        ? (deps.refreshStore ?? globalThis.sessionStorage ?? new MemoryStore())
        : new MemoryStore();
    this.navigate = deps.navigate ?? ((url) => window.location.assign(url));
    this.now = deps.now ?? (() => Date.now());
    this.issuer = cognitoIssuer(config);
    this.refreshToken = this.refreshStore.getItem(REFRESH_KEY);
  }

  subscribe(listener: (event: CognitoAuthEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: CognitoAuthEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private nowSeconds() {
    return Math.floor(this.now() / 1000);
  }

  /** Starts Authorization Code + PKCE (S256). Redirects the browser. */
  async signIn(returnTo?: string): Promise<void> {
    const codeVerifier = generateCodeVerifier();
    const state = generateState();
    const nonce = generateNonce();
    saveTransaction(this.transactionStore, {
      state,
      codeVerifier,
      nonce,
      returnTo: sanitizeReturnTo(returnTo),
      createdAt: this.now(),
    });
    this.navigate(authorizeUrl(this.config, { state, nonce, codeChallenge: await codeChallengeS256(codeVerifier) }));
  }

  /** Managed-login password reset; returns through the normal callback. */
  startPasswordReset(): void {
    this.navigate(forgotPasswordUrl(this.config));
  }

  /**
   * Completes the redirect: validates state, exchanges the code with the PKCE
   * verifier, validates the ID token (iss, aud, token_use, nonce, exp).
   * Returns the sanitized in-app path to restore.
   */
  async handleCallback(callbackUrl: string): Promise<string> {
    const url = new URL(callbackUrl);
    const params = url.searchParams;
    const tx = takeTransaction(this.transactionStore, this.now());

    const error = params.get("error");
    if (error) {
      throw new AuthError(
        "callback_error",
        error === "access_denied" ? "Sign-in was cancelled." : "The sign-in service reported an error. Please try again.",
      );
    }
    if (!tx) throw new AuthError("transaction_expired", "This sign-in link has expired. Please sign in again.");
    const state = params.get("state");
    if (!state || !safeEqual(state, tx.state)) {
      throw new AuthError("state_mismatch", "Sign-in could not be verified. Please try again.");
    }
    const code = params.get("code");
    if (!code) throw new AuthError("missing_code", "Sign-in could not be completed. Please try again.");

    const tokens = await exchangeCode(this.fetchImpl, this.config, code, tx.codeVerifier);
    const session = this.acceptTokens(tokens, tx.nonce);
    this.emit({ type: "signed_in", session });
    return tx.returnTo;
  }

  private acceptTokens(tokens: TokenResponse, nonce: string | null): CognitoSession {
    const identity = validateIdTokenClaims(tokens.id_token, {
      issuer: this.issuer,
      clientId: this.config.clientId,
      nonce,
      nowSeconds: this.nowSeconds(),
    });
    if (this.session && nonce === null && identity.sub !== this.session.user.id) {
      // A refresh must never switch identities.
      this.clear();
      throw new AuthError("invalid_token", "Session identity changed unexpectedly. Please sign in again.");
    }
    const session: CognitoSession = {
      user: { id: identity.sub, email: identity.email, emailVerified: identity.emailVerified },
      access_token: tokens.access_token,
      expires_at: accessTokenExpiry(tokens.access_token),
    };
    this.session = session;
    this.idToken = tokens.id_token;
    if (tokens.refresh_token) {
      this.refreshToken = tokens.refresh_token;
      this.refreshStore.setItem(REFRESH_KEY, tokens.refresh_token);
    }
    return session;
  }

  /** Current session; refreshes when the access token is near expiry. */
  async getSession(): Promise<CognitoSession | null> {
    if (this.session && this.session.expires_at - REFRESH_SKEW_SECONDS > this.nowSeconds()) {
      return this.session;
    }
    if (!this.refreshToken) {
      if (this.session) {
        this.clear();
        this.emit({ type: "session_expired" });
      }
      return null;
    }
    return this.refresh();
  }

  async getAccessToken(): Promise<string | null> {
    return (await this.getSession())?.access_token ?? null;
  }

  /** Single-flight refresh; on failure the session is cleared and expiry emitted. */
  refresh(): Promise<CognitoSession | null> {
    if (this.refreshing) return this.refreshing;
    const token = this.refreshToken;
    if (!token) return Promise.resolve(null);
    this.refreshing = (async () => {
      try {
        const tokens = await refreshTokens(this.fetchImpl, this.config, token);
        const session = this.acceptTokens(tokens, null);
        this.emit({ type: "refreshed", session });
        return session;
      } catch (error) {
        this.clear();
        this.emit({ type: "session_expired" });
        if (error instanceof AuthError && error.code === "network_error") throw error;
        return null;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** Revokes the refresh token, clears local state, ends the managed-login session. */
  async signOut(): Promise<void> {
    const token = this.refreshToken;
    this.clear();
    if (token) await revokeRefreshToken(this.fetchImpl, this.config, token);
    this.emit({ type: "signed_out" });
    this.navigate(logoutUrl(this.config));
  }

  private clear() {
    this.session = null;
    this.idToken = null;
    this.refreshToken = null;
    this.refreshStore.removeItem(REFRESH_KEY);
  }

  /** For tests and diagnostics: whether an ID token is held (never its value). */
  hasIdToken(): boolean {
    return this.idToken !== null;
  }
}
