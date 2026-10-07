/**
 * Phase 3 user-migration DRY RUN. Pure function: no AWS calls, no database
 * writes, no passwords. Input is a sanitized export (ids, emails, flags);
 * output is a deterministic plan the owner reviews before any YELLOW action.
 *
 * Recommended strategy (Option B): administrator-created Cognito users with
 * an invitation (temporary password delivered by Cognito, forced change +
 * TOTP enrolment at first sign-in). Passwords are never exported, migrated,
 * logged, or persisted by Ogevia. See docs/aws/PHASE_3_USER_MIGRATION_MAPPING.md.
 */
import { createHash } from "node:crypto";

export interface SourceUser {
  readonly id: string;
  readonly email: string;
  readonly emailConfirmed: boolean;
  readonly disabled: boolean;
}
export interface CognitoUserRecord {
  readonly sub: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly enabled: boolean;
}
export interface AppUserRecord {
  readonly id: string;
  readonly sourceUserId: string;
  readonly cognitoSub: string | null;
}
export interface MembershipRecord {
  readonly sourceUserId: string;
  readonly organizationId: string;
  readonly role: string;
  readonly status: string;
}
export interface MigrationInput {
  readonly sourceUsers: readonly SourceUser[];
  readonly cognitoUsers: readonly CognitoUserRecord[];
  readonly appUsers: readonly AppUserRecord[];
  readonly memberships: readonly MembershipRecord[];
}

export type MigrationStatus =
  | "ALREADY_LINKED"
  | "LINK_EXISTING_COGNITO_USER"
  | "CREATE_COGNITO_USER_AND_LINK"
  | "HOLD_UNVERIFIED_EMAIL"
  | "SKIP_DISABLED"
  | "SKIP_NO_ACTIVE_MEMBERSHIP"
  | "BLOCKED_DUPLICATE_EMAIL"
  | "BLOCKED_CONFLICTING_LINK";

export interface MigrationRow {
  readonly sourceUserId: string;
  /** SHA-256 prefix of the normalized email: lets reviewers correlate without printing the address. */
  readonly emailHash: string;
  readonly cognitoSub: string | null;
  readonly appUserId: string | null;
  readonly activeMemberships: number;
  readonly roles: readonly string[];
  readonly status: MigrationStatus;
  readonly action: string;
  readonly rollback: string;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export const emailHash = (email: string) => createHash("sha256").update(normalizeEmail(email)).digest("hex").slice(0, 12);

const FORBIDDEN_KEYS = /pass(word)?|pwd|secret|hash|token|credential/i;

/** Refuses any input that carries credential-like fields (defense against a bad export). */
export function assertNoCredentials(value: unknown, path = "input"): void {
  if (Array.isArray(value)) return value.forEach((v, i) => assertNoCredentials(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.test(k)) throw new Error(`Refusing input: credential-like field at ${path}.${k}. Export ids, emails and flags only.`);
      assertNoCredentials(v, `${path}.${k}`);
    }
  }
}

export function planUserMigration(input: MigrationInput): MigrationRow[] {
  assertNoCredentials(input);
  const countBy = (emails: string[]) => emails.reduce((m, e) => m.set(e, (m.get(e) ?? 0) + 1), new Map<string, number>());
  const sourceCounts = countBy(input.sourceUsers.map((u) => normalizeEmail(u.email)));
  const cognitoCounts = countBy(input.cognitoUsers.map((u) => normalizeEmail(u.email)));
  const cognitoByEmail = new Map(input.cognitoUsers.map((u) => [normalizeEmail(u.email), u]));
  const cognitoBySub = new Map(input.cognitoUsers.map((u) => [u.sub, u]));
  const appBySource = new Map(input.appUsers.map((a) => [a.sourceUserId, a]));

  return [...input.sourceUsers]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((u): MigrationRow => {
      const email = normalizeEmail(u.email);
      const app = appBySource.get(u.id) ?? null;
      const active = input.memberships.filter((m) => m.sourceUserId === u.id && m.status === "active");
      const base = {
        sourceUserId: u.id,
        emailHash: emailHash(email),
        appUserId: app?.id ?? null,
        activeMemberships: active.length,
        roles: [...new Set(active.map((m) => m.role))].sort(),
      };
      const row = (status: MigrationStatus, cognitoSub: string | null, action: string, rollback: string): MigrationRow => ({
        ...base,
        cognitoSub,
        status,
        action,
        rollback,
      });

      if ((sourceCounts.get(email) ?? 0) > 1 || (cognitoCounts.get(email) ?? 0) > 1) {
        return row("BLOCKED_DUPLICATE_EMAIL", null, "Owner resolves which person owns the address; no automatic choice.", "None (nothing changed).");
      }
      if (u.disabled) {
        return row("SKIP_DISABLED", null, "Not migrated. App user stays disabled; no Cognito user is created.", "None.");
      }
      if (active.length === 0) {
        return row("SKIP_NO_ACTIVE_MEMBERSHIP", null, "Not migrated: no active organization membership to grant.", "None.");
      }
      if (app?.cognitoSub) {
        const linked = cognitoBySub.get(app.cognitoSub);
        if (linked && normalizeEmail(linked.email) === email) {
          return row("ALREADY_LINKED", linked.sub, "No change.", "None.");
        }
        return row("BLOCKED_CONFLICTING_LINK", app.cognitoSub, "App user is linked to a sub that is missing or has a different email. Investigate before any change.", "None (nothing changed).");
      }
      const existing = cognitoByEmail.get(email);
      if (existing) {
        if (!existing.emailVerified) {
          return row("HOLD_UNVERIFIED_EMAIL", existing.sub, "Do not link until the Cognito email is verified by the user.", "None (nothing changed).");
        }
        return row("LINK_EXISTING_COGNITO_USER", existing.sub, "Set app_users.cognito_sub (one audited UPDATE).", "Set cognito_sub back to NULL.");
      }
      if (!u.emailConfirmed) {
        return row("HOLD_UNVERIFIED_EMAIL", null, "Source email was never confirmed: confirm the address with the person before inviting.", "None (nothing changed).");
      }
      return row(
        "CREATE_COGNITO_USER_AND_LINK",
        null,
        "AdminCreateUser (email invitation, forced password change, TOTP at first sign-in), then set app_users.cognito_sub to the new sub.",
        "AdminDisableUser (never delete) and set cognito_sub back to NULL.",
      );
    });
}

export function summarize(rows: readonly MigrationRow[]): Record<MigrationStatus, number> {
  const out = {
    ALREADY_LINKED: 0,
    LINK_EXISTING_COGNITO_USER: 0,
    CREATE_COGNITO_USER_AND_LINK: 0,
    HOLD_UNVERIFIED_EMAIL: 0,
    SKIP_DISABLED: 0,
    SKIP_NO_ACTIVE_MEMBERSHIP: 0,
    BLOCKED_DUPLICATE_EMAIL: 0,
    BLOCKED_CONFLICTING_LINK: 0,
  } satisfies Record<MigrationStatus, number>;
  for (const r of rows) out[r.status]++;
  return out;
}
