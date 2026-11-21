// R25: sign-in links are sent only by an explicit, confirmed bulk action; never by loading or adding staff. SYNTHETIC data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { json, renderAws } from "./test-support";

afterEach(cleanup);
const PERMS = ["staff.read", "staff.manage", "visits.read", "clients.names.read"];
const row = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  staffKey: `profile:${id}`, profileId: id, caregiverRecordId: null, userId: null, displayName: name, staffTypeId: null, staffTypeName: "Office Assistant",
  contactEmail: `${name.split(" ")[0]!.toLowerCase()}@example.test`, phone: null, status: "active", systemRole: null, accessStatus: "none", invitedAt: null, firstSignedInAt: null, isSelf: false, ...over,
});
const A = "cccccccc-0000-4000-8000-00000000000a", B = "cccccccc-0000-4000-8000-00000000000b", C = "cccccccc-0000-4000-8000-00000000000c";
const D = "cccccccc-0000-4000-8000-00000000000d", E = "cccccccc-0000-4000-8000-00000000000e";
const STAFF = [row(A, "Ana Sample"), row(B, "Ben Sample"), row(C, "Cy NoEmail", { contactEmail: null }), row(D, "Dee Active", { accessStatus: "active", userId: "u1" }), row(E, "Eli Pending", { accessStatus: "invitation_pending", userId: "u2" })];
const base = (post: (id: string) => Response = () => json(201, { invitation: {} })) => ({
  "GET /v1/staff": () => json(200, { staff: STAFF }),
  "GET /v1/staff-types": () => json(200, { staffTypes: [] }),
  ...Object.fromEntries([A, B, C, D, E].map((id) => [`POST /v1/staff/${id}/invitation`, () => post(id)])),
});
const openPanel = async () => { fireEvent.click(await screen.findByRole("button", { name: /Send sign-in links/ }, { timeout: 15000 })); return screen.getByRole("region", { name: "Send sign-in links" }); };

describe("bulk sign-in links", () => {
  it("lists only people who can be invited (active, no sign-in, with an email) and counts those without an email; nothing is sent by loading the page", async () => {
    const { calls } = renderAws("/staff", PERMS, base(), "organization_owner");
    const panel = await openPanel();
    expect(within(panel).getByLabelText(/Ana Sample/)).toBeInTheDocument();
    expect(within(panel).getByLabelText(/Ben Sample/)).toBeInTheDocument();
    expect(within(panel).queryByText(/Cy NoEmail|Dee Active|Eli Pending/)).toBeNull();
    expect(panel).toHaveTextContent("1 person has no email on file");
    expect(within(panel).getByRole("button", { name: "Send sign-in links" })).toBeDisabled();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  }, 30000);

  it("sends one invitation per chosen person with the chosen role, only after the button is pressed", async () => {
    const { calls } = renderAws("/staff", PERMS, base(), "organization_owner");
    const panel = await openPanel();
    fireEvent.click(within(panel).getByLabelText(/Ana Sample/));
    fireEvent.click(within(panel).getByLabelText(/Ben Sample/));
    fireEvent.change(within(panel).getByLabelText("Role for everyone selected"), { target: { value: "scheduler" } });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    fireEvent.click(within(panel).getByRole("button", { name: "Send 2 sign-in links" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/invitation"))).toHaveLength(2), { timeout: 15000 });
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.path).sort()).toEqual([`/v1/staff/${A}/invitation`, `/v1/staff/${B}/invitation`]);
    expect(posts.every((c) => c.body?.role === "scheduler" && typeof c.body?.email === "string" && c.body?.organizationId)).toBe(true);
    expect(await screen.findByText("Sign-in links: 2 sent.")).toBeInTheDocument();
  }, 30000);

  it("one failure is shown by name and does not stop the others", async () => {
    const { calls } = renderAws("/staff", PERMS, base((id) => id === A ? json(409, { error: { code: "conflict", message: "This person already has a pending invitation." } }) : json(201, { invitation: {} })), "organization_owner");
    const panel = await openPanel();
    fireEvent.click(within(panel).getByLabelText(/Ana Sample/));
    fireEvent.click(within(panel).getByLabelText(/Ben Sample/));
    fireEvent.click(within(panel).getByRole("button", { name: "Send 2 sign-in links" }));
    expect(await screen.findByText(/Ana Sample: This person already has a pending invitation\./, {}, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.getByText("Ben Sample: sent")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
    expect(await screen.findByText(/1 sent, 1 not sent/)).toBeInTheDocument();
  }, 30000);

  it("is not offered to someone who cannot manage staff", async () => {
    renderAws("/staff", ["staff.read", "visits.read", "clients.names.read"], base(), "manager");
    await screen.findByRole("table", { name: "Staff" }, { timeout: 15000 });
    expect(screen.queryByRole("button", { name: /Send sign-in links/ })).toBeNull();
  }, 30000);
});
