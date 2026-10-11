// Identity Lambda (0025) against a fake Cognito: what it sends, what it returns, what it logs.
import { describe, expect, it } from "vitest";
import { createIdentityHandler } from "../src/identity-handler";
import { lambdaIdentityAdmin } from "../src/identity";

const SUB = "0f0e0d0c-1111-4222-8333-444455556666";
function fakeCognito(behaviour: (input: Record<string, any>, name: string) => any) {
  const sent: { name: string; input: Record<string, any> }[] = [];
  return {
    sent,
    client: { send: async (command: any) => { const name = command.constructor.name; sent.push({ name, input: command.input }); return behaviour(command.input, name); } },
  };
}
const err = (name: string) => Object.assign(new Error(name), { name });

describe("identity Lambda", () => {
  it("creates the sign-in with the email only; Cognito generates and emails the temporary password", async () => {
    const lines: string[] = [];
    const c = fakeCognito(() => ({ User: { Attributes: [{ Name: "sub", Value: SUB }] } }));
    const h = createIdentityHandler(c.client as never, "us-west-2_TEST", (l) => lines.push(l));
    expect(await h({ action: "invite", email: " Person@Example.TEST " })).toEqual({ ok: true, sub: SUB, existingAccount: false });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]!.name).toBe("AdminCreateUserCommand");
    expect(c.sent[0]!.input).toEqual({
      UserPoolId: "us-west-2_TEST", Username: "person@example.test", DesiredDeliveryMediums: ["EMAIL"],
      UserAttributes: [{ Name: "email", Value: "person@example.test" }, { Name: "email_verified", Value: "true" }],
    });
    expect(c.sent[0]!.input).not.toHaveProperty("TemporaryPassword");
    expect(lines.join("\n")).not.toContain("example.test");
  });

  it("an existing, set-up account is reported as existing; one still awaiting its first password gets a fresh email", async () => {
    let status = "CONFIRMED";
    const c = fakeCognito((input, name) => {
      if (name === "AdminCreateUserCommand" && !input.MessageAction) throw err("UsernameExistsException");
      if (name === "AdminGetUserCommand") return { UserStatus: status, UserAttributes: [{ Name: "sub", Value: SUB }] };
      return {};
    });
    const h = createIdentityHandler(c.client as never, "us-west-2_TEST", () => {});
    expect(await h({ action: "invite", email: "a@example.test" })).toEqual({ ok: true, sub: SUB, existingAccount: true });
    status = "FORCE_CHANGE_PASSWORD";
    expect(await h({ action: "invite", email: "a@example.test" })).toEqual({ ok: true, sub: SUB, existingAccount: false });
    expect(c.sent.at(-1)!.input).toMatchObject({ MessageAction: "RESEND", Username: "a@example.test" });
  });

  it("resend maps Cognito refusals; bad input never reaches Cognito", async () => {
    const c = fakeCognito(() => { throw err("UnsupportedUserStateException"); });
    const h = createIdentityHandler(c.client as never, "us-west-2_TEST", () => {});
    expect(await h({ action: "resend", email: "a@example.test" })).toEqual({ ok: false, error: "already_set_up" });
    expect(await h({ action: "invite", email: "not an email" })).toEqual({ ok: false, error: "invalid_email" });
    expect(await h({ action: "delete" as never, email: "a@example.test" })).toEqual({ ok: false, error: "invalid_email" });
    expect(c.sent).toHaveLength(1);
  });

  it("the API side turns failures into safe errors and rejects a malformed sub", async () => {
    await expect(lambdaIdentityAdmin(async () => { throw new Error("network"); }).invite("a@example.test")).rejects.toMatchObject({ status: 502 });
    await expect(lambdaIdentityAdmin(async () => ({ ok: false, error: "already_set_up" })).resend("a@example.test")).rejects.toMatchObject({ status: 409 });
    await expect(lambdaIdentityAdmin(async () => ({ ok: true, sub: "x" })).invite("a@example.test")).rejects.toMatchObject({ status: 502 });
  });
  it("disable/enable (0048): addressed by the Cognito sub only; exactly one disable or enable call; nothing else; no email or password anywhere", async () => {
    const lines: string[] = [];
    const c = fakeCognito(() => ({}));
    const h = createIdentityHandler(c.client as never, "us-west-2_TEST", (l) => lines.push(l));
    expect(await h({ action: "disable", sub: SUB.toUpperCase() })).toEqual({ ok: true });
    expect(await h({ action: "enable", sub: SUB })).toEqual({ ok: true });
    expect(c.sent.map((s) => s.name)).toEqual(["AdminDisableUserCommand", "AdminEnableUserCommand"]);
    expect(c.sent.map((s) => s.input)).toEqual([{ UserPoolId: "us-west-2_TEST", Username: SUB }, { UserPoolId: "us-west-2_TEST", Username: SUB }]);
    expect(lines.join("\n")).not.toContain(SUB); // the log line holds the action and outcome only
  });

  it("disable/enable refuse anything that is not a UUID (an email, a username, empty) before Cognito is called, and map Cognito failures", async () => {
    const c = fakeCognito(() => { throw err("UserNotFoundException"); });
    const h = createIdentityHandler(c.client as never, "us-west-2_TEST", () => {});
    for (const sub of ["a@example.test", "someone", "", "../etc", `${SUB} `.repeat(2)]) {
      expect(await h({ action: "disable", sub } as never)).toEqual({ ok: false, error: "invalid_request" });
    }
    expect(await h({ action: "enable", email: "a@example.test" } as never)).toEqual({ ok: false, error: "invalid_request" });
    expect(c.sent).toHaveLength(0);
    expect(await h({ action: "disable", sub: SUB })).toEqual({ ok: false, error: "not_found" });
  });

  it("the API side maps failures of setEnabled to safe errors", async () => {
    await expect(lambdaIdentityAdmin(async () => { throw new Error("network"); }).setEnabled(SUB, false)).rejects.toMatchObject({ status: 502 });
    await expect(lambdaIdentityAdmin(async () => ({ ok: false, error: "not_found" })).setEnabled(SUB, true)).rejects.toMatchObject({ status: 404 });
    await expect(lambdaIdentityAdmin(async () => ({ ok: true })).setEnabled(SUB, true)).resolves.toBeUndefined();
  });
});
