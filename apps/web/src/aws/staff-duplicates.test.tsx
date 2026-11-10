// R6: possible duplicate staff. Read-only report; merge needs a reason and only runs when chosen. SYNTHETIC data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { json, renderAws } from "./test-support";

afterEach(cleanup);
const PERMS = ["staff.read", "staff.manage", "visits.read", "clients.names.read"];
const P1 = "dddddddd-0000-4000-8000-000000000001", P2 = "dddddddd-0000-4000-8000-000000000002", C1 = "dddddddd-0000-4000-8000-0000000000c1";
const dup = (over: Record<string, unknown>) => ({ groupId: "g1", matchBasis: "name", staffKey: "profile:x", source: "profile", profileId: null, caregiverRecordId: null, userId: null, displayName: "Pat Twin", staffTypeName: "Office", contactEmail: null, phone: null, status: "active", accessStatus: "none", canMerge: true, ...over });
const DUPES = [dup({ staffKey: `profile:${P1}`, profileId: P1 }), dup({ staffKey: `profile:${P2}`, profileId: P2 }), dup({ staffKey: `caregiver:${C1}`, source: "caregiver", canMerge: false, staffTypeName: null })];
const base = (extra: Record<string, unknown> = {}) => ({ "GET /v1/staff": () => json(200, { staff: [] }), "GET /v1/staff-types": () => json(200, { staffTypes: [] }), ...extra });

describe("possible duplicate staff", () => {
  it("lists the group with its reason for matching; a caregiver is shown but cannot be merged here; nothing is posted by loading", async () => {
    const { calls } = renderAws("/staff", PERMS, base({ "GET /v1/staff/duplicates": () => json(200, { duplicates: DUPES }) }), "organization_owner");
    const box = await screen.findByTestId("possible-duplicates", undefined, { timeout: 15000 });
    expect(box).toHaveTextContent("Possible duplicates (1)");
    expect(box).toHaveTextContent("Same name");
    expect(box).toHaveTextContent("resolve in Care Team");
    expect(within(box).getAllByRole("button", { name: /merge the others/ })).toHaveLength(2);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  }, 30000);

  it("merge needs a reason of 5+ characters, posts one merge for the other profile, and says nothing was deleted", async () => {
    const { calls } = renderAws("/staff", PERMS, base({
      "GET /v1/staff/duplicates": () => json(200, { duplicates: DUPES }),
      [`POST /v1/staff/${P1}/merge`]: () => json(200, { result: "merged" }),
    }), "organization_owner");
    const box = await screen.findByTestId("possible-duplicates", undefined, { timeout: 15000 });
    fireEvent.click(within(box).getAllByRole("button", { name: /merge the others/ })[0]!);
    const merge = within(box).getByRole("button", { name: "Merge" });
    expect(merge).toBeDisabled();
    fireEvent.change(within(box).getByLabelText("Reason for the merge"), { target: { value: "Entered twice" } });
    fireEvent.click(merge);
    await waitFor(() => expect(box).toHaveTextContent("Nothing was deleted"), { timeout: 15000 });
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe(`/v1/staff/${P1}/merge`);
    expect(posts[0]!.body).toMatchObject({ duplicateProfileId: P2, reason: "Entered twice" });
  }, 30000);

  it("a refusal from the server is shown in plain words and nothing is claimed as merged", async () => {
    renderAws("/staff", PERMS, base({
      "GET /v1/staff/duplicates": () => json(200, { duplicates: DUPES }),
      [`POST /v1/staff/${P1}/merge`]: () => json(409, { error: { code: "conflict", message: "These records do not match on email, phone or name, so they cannot be merged" } }),
    }), "organization_owner");
    const box = await screen.findByTestId("possible-duplicates", undefined, { timeout: 15000 });
    fireEvent.click(within(box).getAllByRole("button", { name: /merge the others/ })[0]!);
    fireEvent.change(within(box).getByLabelText("Reason for the merge"), { target: { value: "Entered twice" } });
    fireEvent.click(within(box).getByRole("button", { name: "Merge" }));
    expect(await within(box).findByRole("alert", undefined, { timeout: 15000 })).toHaveTextContent("do not match");
    expect(box).not.toHaveTextContent("Nothing was deleted");
  }, 30000);

  it("shows nothing when there are no duplicates, when the feature is not available (404), and for someone who cannot manage staff; a real failure is not shown as none", async () => {
    renderAws("/staff", PERMS, base({ "GET /v1/staff/duplicates": () => json(200, { duplicates: [] }) }), "organization_owner");
    await screen.findByRole("heading", { name: "Staff" }, { timeout: 15000 });
    expect(screen.queryByTestId("possible-duplicates")).toBeNull();
    cleanup();
    renderAws("/staff", PERMS, base(), "organization_owner");   // route absent: 404
    await screen.findByRole("heading", { name: "Staff" }, { timeout: 15000 });
    expect(screen.queryByTestId("possible-duplicates")).toBeNull();
    expect(screen.queryByText(/could not be checked/)).toBeNull();
    cleanup();
    renderAws("/staff", ["staff.read", "visits.read"], base({ "GET /v1/staff/duplicates": () => json(200, { duplicates: DUPES }) }), "manager");
    await screen.findByRole("heading", { name: "Staff" }, { timeout: 15000 });
    expect(screen.queryByTestId("possible-duplicates")).toBeNull();
    cleanup();
    renderAws("/staff", PERMS, base({ "GET /v1/staff/duplicates": () => json(500, { error: { code: "internal_error", message: "Something went wrong." } }) }), "organization_owner");
    expect(await screen.findByText(/could not be checked/, undefined, { timeout: 15000 })).toBeInTheDocument();
  }, 60000);
});
