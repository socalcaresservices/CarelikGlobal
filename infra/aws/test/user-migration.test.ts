import { describe, expect, it } from "vitest";
import { assertNoCredentials, emailHash, planUserMigration, summarize, type MigrationInput } from "../lib/user-migration.js";

// Synthetic identities only (example.test, UUID-shaped ids).
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sub = (n: number) => `11111111-0000-4000-8000-${String(n).padStart(12, "0")}`;
const org = "aaaaaaaa-0000-4000-8000-000000000001";

const input: MigrationInput = {
  sourceUsers: [
    { id: id(1), email: "Caregiver.One@example.test ", emailConfirmed: true, disabled: false }, // create
    { id: id(2), email: "linked@example.test", emailConfirmed: true, disabled: false }, // already linked
    { id: id(3), email: "existing@example.test", emailConfirmed: true, disabled: false }, // link existing
    { id: id(4), email: "dup@example.test", emailConfirmed: true, disabled: false }, // duplicate
    { id: id(5), email: "DUP@example.test", emailConfirmed: true, disabled: false }, // duplicate
    { id: id(6), email: "gone@example.test", emailConfirmed: true, disabled: true }, // disabled
    { id: id(7), email: "unconfirmed@example.test", emailConfirmed: false, disabled: false }, // hold
    { id: id(8), email: "nomember@example.test", emailConfirmed: true, disabled: false }, // no membership
    { id: id(9), email: "conflict@example.test", emailConfirmed: true, disabled: false }, // conflicting link
    { id: id(10), email: "cog-unverified@example.test", emailConfirmed: true, disabled: false }, // cognito unverified
  ],
  cognitoUsers: [
    { sub: sub(2), email: "linked@example.test", emailVerified: true, enabled: true },
    { sub: sub(3), email: "EXISTING@example.test", emailVerified: true, enabled: true },
    { sub: sub(9), email: "someone-else@example.test", emailVerified: true, enabled: true },
    { sub: sub(10), email: "cog-unverified@example.test", emailVerified: false, enabled: true },
  ],
  appUsers: [
    { id: id(102), sourceUserId: id(2), cognitoSub: sub(2) },
    { id: id(103), sourceUserId: id(3), cognitoSub: null },
    { id: id(109), sourceUserId: id(9), cognitoSub: sub(9) },
  ],
  memberships: [1, 2, 3, 4, 5, 6, 7, 9, 10].map((n) => ({ sourceUserId: id(n), organizationId: org, role: n === 2 ? "manager" : "caregiver", status: "active" })),
};

describe("user migration dry run", () => {
  const rows = planUserMigration(input);
  const status = (n: number) => rows.find((r) => r.sourceUserId === id(n))!.status;

  it("classifies every case deterministically", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(status)).toEqual([
      "CREATE_COGNITO_USER_AND_LINK",
      "ALREADY_LINKED",
      "LINK_EXISTING_COGNITO_USER",
      "BLOCKED_DUPLICATE_EMAIL",
      "BLOCKED_DUPLICATE_EMAIL",
      "SKIP_DISABLED",
      "HOLD_UNVERIFIED_EMAIL",
      "SKIP_NO_ACTIVE_MEMBERSHIP",
      "BLOCKED_CONFLICTING_LINK",
      "HOLD_UNVERIFIED_EMAIL",
    ]);
    expect(planUserMigration(input)).toEqual(rows);
  });

  it("matches emails case- and whitespace-insensitively, exact otherwise (no fuzzy matching)", () => {
    expect(rows.find((r) => r.sourceUserId === id(3))!.cognitoSub).toBe(sub(3));
    expect(emailHash(" A@Example.test")).toBe(emailHash("a@example.test"));
  });

  it("roles come from the database memberships, never from Cognito", () => {
    expect(rows.find((r) => r.sourceUserId === id(2))!.roles).toEqual(["manager"]);
  });

  it("never outputs an email address", () => {
    const text = JSON.stringify(rows);
    for (const u of input.sourceUsers) expect(text.toLowerCase()).not.toContain(u.email.trim().toLowerCase());
  });

  it("rollback never deletes a Cognito user", () => {
    for (const r of rows) expect(r.rollback).not.toMatch(/AdminDeleteUser|DeleteUser\b/);
  });

  it("refuses any export carrying password/hash/token fields", () => {
    expect(() => assertNoCredentials({ sourceUsers: [{ id: "x", encrypted_password: "..." }] })).toThrow(/credential-like/);
    expect(() => planUserMigration({ ...input, sourceUsers: [{ ...input.sourceUsers[0]!, passwordHash: "x" } as never] })).toThrow();
  });

  it("summarizes counts", () => {
    expect(summarize(rows)).toMatchObject({ CREATE_COGNITO_USER_AND_LINK: 1, BLOCKED_DUPLICATE_EMAIL: 2, HOLD_UNVERIFIED_EMAIL: 2 });
  });
});
