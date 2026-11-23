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

const side = (id: string, over: Record<string, unknown> = {}) => ({ profileId: id, displayName: "Pat Twin", staffType: "Scheduler", email: "pat@example.invalid", phone: null, ...over });
const PREVIEW = (over: Record<string, unknown> = {}) => ({ preview: { keep: side(P1), duplicate: side(P2, { phone: "(555) 010-2222" }), matchBasis: "email", conflicts: [], fills: [{ field: "phone", value: "(555) 010-2222" }], blockers: [], canMerge: true, ...over } });
const PREVIEW_PATH = "GET /v1/staff/merge-preview";

describe("possible duplicate staff", () => {
  it("the same two people matching on name AND phone appear in two groups, but only one merge form opens", async () => {
    const both = [...DUPES.slice(0, 2), ...DUPES.slice(0, 2).map((d) => ({ ...d, groupId: "g2", matchBasis: "phone" }))];
    renderAws("/staff", PERMS, base({ "GET /v1/staff/duplicates": () => json(200, { duplicates: both }), [PREVIEW_PATH]: () => json(200, PREVIEW()) }), "organization_owner");
    const box = await screen.findByTestId("possible-duplicates", undefined, { timeout: 15000 });
    expect(box).toHaveTextContent("Possible duplicates (2)");
    fireEvent.click(within(box).getAllByRole("button", { name: /merge the others/ })[0]!);
    expect(await within(box).findAllByLabelText("Reason for the merge", undefined, { timeout: 15000 })).toHaveLength(1);
  }, 30000);

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
      [PREVIEW_PATH]: () => json(200, PREVIEW()),
      [`POST /v1/staff/${P1}/merge`]: () => json(200, { result: { state: "merged" } }),
    }), "organization_owner");
    const box = await screen.findByTestId("possible-duplicates", undefined, { timeout: 15000 });
    fireEvent.click(within(box).getAllByRole("button", { name: /merge the others/ })[0]!);
    expect(await within(box).findByTestId("wizard-fills", undefined, { timeout: 15000 })).toHaveTextContent("will gain: Phone (555) 010-2222");
    const merge = within(box).getByRole("button", { name: "Merge" });
    expect(merge).toBeDisabled();
    fireEvent.change(within(box).getByLabelText("Reason for the merge"), { target: { value: "Entered twice" } });
    fireEvent.click(merge);
    await waitFor(() => expect(box).toHaveTextContent("Nothing was deleted"), { timeout: 15000 });
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe(`/v1/staff/${P1}/merge`);
    expect(posts[0]!.body).toMatchObject({ duplicateProfileId: P2, reason: "Entered twice", resolutions: {} });
  }, 30000);

  it("a refusal from the server is shown in plain words and nothing is claimed as merged", async () => {
    renderAws("/staff", PERMS, base({
      "GET /v1/staff/duplicates": () => json(200, { duplicates: DUPES }),
      [PREVIEW_PATH]: () => json(200, PREVIEW()),
      [`POST /v1/staff/${P1}/merge`]: () => json(409, { error: { code: "conflict", message: "These records do not match on email, phone or name, so they cannot be merged" } }),
    }), "organization_owner");
    const box = await screen.findByTestId("possible-duplicates", undefined, { timeout: 15000 });
    fireEvent.click(within(box).getAllByRole("button", { name: /merge the others/ })[0]!);
    await within(box).findByTestId("wizard-fills", undefined, { timeout: 15000 });
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

describe("merge wizard (0116)", () => {
  const CONF = PREVIEW({ conflicts: [{ field: "staff_type_id", keep: "Scheduler", duplicate: "Coordinator" }, { field: "phone", keep: "(555) 010-1111", duplicate: "(555) 010-2222" }], fills: [] });
  it("shows the two records side by side; every conflict needs a choice before Merge works; the choices are sent", async () => {
    const { calls } = renderAws("/staff", PERMS, base({
      "GET /v1/staff/duplicates": () => json(200, { duplicates: DUPES }), [PREVIEW_PATH]: () => json(200, CONF),
      [`POST /v1/staff/${P1}/merge`]: () => json(200, { result: { state: "merged", linkId: "l1" } }),
    }), "organization_owner");
    const box = await screen.findByTestId("possible-duplicates", undefined, { timeout: 15000 });
    fireEvent.click(within(box).getAllByRole("button", { name: /merge the others/ })[0]!);
    const table = await within(box).findByRole("table", { name: "The two records" }, { timeout: 15000 });
    expect(within(table).getByText("Merged into it (becomes inactive)")).toBeInTheDocument();
    fireEvent.change(within(box).getByLabelText("Reason for the merge"), { target: { value: "Entered twice" } });
    const merge = within(box).getByRole("button", { name: "Merge" });
    expect(merge).toBeDisabled();
    expect(box).toHaveTextContent("Choose a value for: Staff type, Phone.");
    fireEvent.click(within(within(box).getByRole("radiogroup", { name: "Staff type" })).getByLabelText("Coordinator"));
    expect(merge).toBeDisabled();
    fireEvent.click(within(within(box).getByRole("radiogroup", { name: "Phone" })).getByLabelText("(555) 010-1111"));
    expect(merge).toBeEnabled();
    fireEvent.click(merge);
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ resolutions: { staff_type_id: "duplicate", phone: "keep" }, reason: "Entered twice" }), { timeout: 15000 });
  }, 40000);
  it("a blocked pair shows every blocker and offers no merge", async () => {
    renderAws("/staff", PERMS, base({ "GET /v1/staff/duplicates": () => json(200, { duplicates: DUPES }), [PREVIEW_PATH]: () => json(200, PREVIEW({ canMerge: false, blockers: ["The record to merge has a sign-in or an invitation. Resolve it by hand so nobody loses access."], fills: [] })) }), "organization_owner");
    const box = await screen.findByTestId("possible-duplicates", undefined, { timeout: 15000 });
    fireEvent.click(within(box).getAllByRole("button", { name: /merge the others/ })[0]!);
    expect(await within(box).findByTestId("wizard-blockers", undefined, { timeout: 15000 })).toHaveTextContent("sign-in or an invitation");
    expect(within(box).getByRole("button", { name: "Merge" })).toBeDisabled();
    expect(within(box).queryByLabelText("Reason for the merge")).toBeNull();
  }, 40000);
  it("a preview that fails says so and changes nothing", async () => {
    const { calls } = renderAws("/staff", PERMS, base({ "GET /v1/staff/duplicates": () => json(200, { duplicates: DUPES }), [PREVIEW_PATH]: () => json(500, { error: { code: "internal_error", message: "Something went wrong." } }) }), "organization_owner");
    const box = await screen.findByTestId("possible-duplicates", undefined, { timeout: 15000 });
    fireEvent.click(within(box).getAllByRole("button", { name: /merge the others/ })[0]!);
    expect(await within(box).findByRole("alert", undefined, { timeout: 15000 })).toHaveTextContent("Nothing was changed");
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  }, 40000);
  const M = (over: Record<string, unknown>) => ({ link_id: "ll111111-0000-4000-8000-000000000001", kept_name: "Pat Twin", merged_name: "Pat T.", match_basis: "email", reason: "Entered twice", merged_at: "2026-12-01T17:00:00Z", merged_by_name: "Olivia Owner", has_snapshot: true, reversed_at: null, reversed_reason: null, can_undo: true, ...over });
  it("recent merges: undo needs a reason and shows the server's answer; merges that cannot be undone say why", async () => {
    const { calls } = renderAws("/staff", PERMS, base({
      "GET /v1/staff/duplicates": () => json(200, { duplicates: [] }),
      "GET /v1/staff-merges": () => json(200, { merges: [M({}), M({ link_id: "x2", can_undo: false }), M({ link_id: "x3", has_snapshot: false, can_undo: false }), M({ link_id: "x4", can_undo: false, reversed_at: "2026-12-02T10:00:00Z", reversed_reason: "Mistake" })] }),
      "POST /v1/staff-merges/ll111111-0000-4000-8000-000000000001/undo": () => json(200, { result: { state: "reversed" } }),
    }), "organization_owner");
    const box = await screen.findByTestId("recent-merges", undefined, { timeout: 15000 });
    expect(box).toHaveTextContent("Recent merges (4)");
    expect(box).toHaveTextContent("Cannot be undone now: one of the records changed after the merge.");
    expect(box).toHaveTextContent("Made before undo was available.");
    expect(box).toHaveTextContent("Undone");
    expect(within(box).getAllByRole("button", { name: "Undo…" })).toHaveLength(1);
    fireEvent.click(within(box).getByRole("button", { name: "Undo…" }));
    fireEvent.click(within(box).getByRole("button", { name: "Undo this merge" }));
    expect(await within(box).findByText("Give a reason (at least 5 characters).")).toBeInTheDocument();
    fireEvent.change(within(box).getByTestId("undo-reason"), { target: { value: "Merged by mistake" } });
    fireEvent.click(within(box).getByRole("button", { name: "Undo this merge" }));
    expect(await within(box).findByText(/Undone\. The earlier values are back/, undefined, { timeout: 15000 })).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({ reason: "Merged by mistake" });
  }, 40000);
  it("an undo the server refuses shows its reason and nothing is claimed as undone", async () => {
    renderAws("/staff", PERMS, base({
      "GET /v1/staff/duplicates": () => json(200, { duplicates: [] }),
      "GET /v1/staff-merges": () => json(200, { merges: [M({})] }),
      "POST /v1/staff-merges/ll111111-0000-4000-8000-000000000001/undo": () => json(409, { error: { code: "conflict", message: "The kept record was changed after the merge, so the merge cannot be undone safely" } }),
    }), "organization_owner");
    const box = await screen.findByTestId("recent-merges", undefined, { timeout: 15000 });
    fireEvent.click(within(box).getByRole("button", { name: "Undo…" }));
    fireEvent.change(within(box).getByTestId("undo-reason"), { target: { value: "Merged by mistake" } });
    fireEvent.click(within(box).getByRole("button", { name: "Undo this merge" }));
    expect(await within(box).findByRole("alert", undefined, { timeout: 15000 })).toHaveTextContent("kept record was changed");
  }, 40000);
});

