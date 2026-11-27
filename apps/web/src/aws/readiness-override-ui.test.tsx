/* eslint-disable @typescript-eslint/no-explicit-any -- a test double: request bodies are free-form JSON */
// 0123 admin overrides of a CPR/TB readiness block on the caregiver profile: CPR | Expired Doc | Blocked | Approve, then CPR | Expired Doc | Admin Approved | Details. SYNTHETIC data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { json, renderAws, type Handler } from "./test-support";

afterEach(() => cleanup());
const CG = "abababab-0000-4000-8000-000000000009";
const OV = "cccccccc-0000-4000-8000-000000000001";
const KEY = "expired:11111111-0000-4000-8000-000000000001:2026-11-26";
const item = (requirement: string, label: string, kind: string, state: string, detail: string, over: Record<string, unknown> = {}) =>
  ({ requirement, label, kind, state, detail, dueDate: null, metOn: null, actorName: null, blocksShifts: false, nextAction: "none", extra: {}, ...over });
const override = { id: OV, issueKey: KEY, issueStatus: "expired", validUntil: "2026-11-26", approvedAt: "2026-11-27T18:30:00Z", approvedByName: "Olivia Owner", reason: "Renewal booked for Friday" };
const readiness = (approved: boolean) => ({
  caregiverRecordId: CG, caregiverCode: "CG-NEW00001", status: "approved", approved: true, approvedAt: "2026-11-20T18:00:00Z", approvedByName: "Olivia Owner", approvalSource: "approval", met: 4, total: 5, waitingOn: [], canApprove: false,
  hireDate: "2026-11-01", graceDays: 30, cprTbDueDate: "2026-12-01", enforcementActive: true,
  items: [item("background", "Background check", "hard", "met", "Verified", { metOn: "2026-11-20" }), item("training", "Required training", "hard", "met", "Done", { metOn: "2026-11-20" }), item("signin", "App sign-in", "hard", "met", "Signed in"),
    item("cpr", "CPR certificate", "flexible", "problem", "Expired", { blocksShifts: !approved, nextAction: "upload", extra: { issueStatus: "expired", issueKey: KEY, issueLabel: "Expired Doc", validUntil: "2026-11-26", ...(approved ? { override } : {}) } }),
    item("tb", "TB clearance", "flexible", "met", "Verified", { metOn: "2026-11-20", extra: { issueStatus: "ok", issueKey: null, issueLabel: null, validUntil: "2027-11-01" } })],
});
const caregiver = { caregiverRecordId: CG, caregiverCode: "CG-NEW00001", firstName: "Synthetic", lastName: "Reed", preferredName: null, status: "active", workStatus: "approved", readinessMet: 4, readinessTotal: 5, signedIn: true, hasContact: true,
  hasSignIn: true, signInStatus: "active", activeAssignments: 1, plannedAssignments: 0, openVisits: 0, invitationEmail: null, invitedAt: null, invitationLastSentAt: null, invitationSendCount: null, firstSignedInAt: null };
const ADMIN = ["caregivers.manage", "visits.manage", "visits.read", "staff.read", "clients.names.read", "readiness.read", "readiness.manage", "caregivers.compliance.manage", "documents.read"];
const MANAGER = ["caregivers.manage", "visits.manage", "visits.read", "staff.read", "clients.names.read", "readiness.read"];
function setup(perms = ADMIN, role = "organization_owner", opts: { api?: boolean; startApproved?: boolean } = {}) {
  const state = { approved: !!opts.startApproved, posts: [] as { path: string; body: any; key: string | null }[] };
  const list = () => [{ id: OV, caregiverRecordId: CG, caregiverCode: "CG-NEW00001", caregiverName: "Synthetic Reed", requirement: "cpr", issueStatus: "expired", issueLabel: "Expired Doc", validUntil: "2026-11-26", reason: override.reason,
    approvedByName: "Olivia Owner", approvedAt: override.approvedAt, active: state.approved, revokedAt: state.approved ? null : "2026-11-28T10:00:00Z", revokedByName: state.approved ? null : "Olivia Owner", revokeReason: state.approved ? null : "Renewal did not happen", stillApplies: state.approved }];
  const handlers: Record<string, Handler> = {
    "GET /v1/caregivers": () => json(200, { caregivers: [caregiver] }),
    [`GET /v1/caregivers/${CG}/readiness`]: () => json(200, { readiness: readiness(state.approved) }),
    "GET /v1/staff": () => json(200, { staff: [] }),
    [`POST /v1/caregivers/${CG}/readiness-override`]: ({ body }) => { state.posts.push({ path: "approve", body, key: null }); state.approved = true; return json(201, { override: { id: OV, active: true } }); },
    [`POST /v1/readiness-overrides/${OV}/revoke`]: ({ body }) => { state.posts.push({ path: "revoke", body, key: null }); state.approved = false; return json(200, { override: { id: OV, active: false } }); },
  };
  if (opts.api !== false) handlers["GET /v1/readiness-overrides"] = () => json(200, { overrides: state.approved || state.posts.length ? list() : [] });
  return { state, ...renderAws(`/care-team/${CG}?tab=readiness`, perms, handlers, role) };
}
const cprRow = async () => (await screen.findByText("CPR", { selector: "span" }, { timeout: 15000 })).closest("li")!;

describe("CPR | Expired Doc | Blocked | Approve", () => {
  it("an expired CPR that blocks scheduling shows short labels on one row: CPR, Expired Doc, Blocked and Approve; the document is not shown as current", async () => {
    setup();
    const row = await cprRow();
    expect(within(row).getByTestId("issue-label")).toHaveTextContent("Expired Doc");
    expect(within(row).getByText("Blocked")).toHaveAttribute("data-tone", "bad");
    expect(within(row).queryByText("Admin Approved")).not.toBeInTheDocument();
    await waitFor(() => expect(within(row).getByRole("button", { name: "Approve" })).toBeInTheDocument());
    expect(within(row).queryByRole("button", { name: "Details" })).not.toBeInTheDocument();
    expect(row).toHaveTextContent("Expired");
  });

  it("Approve opens a confirmation that names the specific block and requires a reason; the reason goes to the server with the issue the admin reviewed and an idempotency key", async () => {
    const { state, calls } = setup();
    const row = await cprRow();
    fireEvent.click(await within(row).findByRole("button", { name: "Approve" }));
    const dlg = await screen.findByRole("dialog", { name: "Approve override" });
    expect(within(dlg).getByTestId("override-block")).toHaveTextContent(/CPR.*Expired Doc.*expired/);
    expect(dlg).toHaveTextContent(/not.*marked current or verified/);
    fireEvent.click(within(dlg).getByRole("button", { name: "Approve override" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/reason/i);
    expect(state.posts).toHaveLength(0);                                                    // nothing is sent without a reason
    fireEvent.change(within(dlg).getByLabelText(/Reason/), { target: { value: "Renewal booked for Friday" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Approve override" }));
    await waitFor(() => expect(state.posts).toHaveLength(1));
    expect(state.posts[0]!.body).toMatchObject({ requirement: "cpr", issueKey: KEY, reason: "Renewal booked for Friday" });
    expect(calls.find((c) => c.method === "POST" && c.path.endsWith("/readiness-override"))!.key).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("after approval the row keeps Expired Doc, reads Admin Approved with a Details action, and the document status text is unchanged", async () => {
    setup(ADMIN, "organization_owner", { startApproved: true });
    const row = await cprRow();
    expect(within(row).getByTestId("issue-label")).toHaveTextContent("Expired Doc");
    expect(within(row).getByText("Admin Approved")).toHaveAttribute("data-tone", "override");
    expect(within(row).queryByText("Blocked")).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(row).toHaveTextContent("Expired");                                               // still expired, never "Verified"
    expect(within(row).queryByText("Verified")).not.toBeInTheDocument();
  });

  it("Details shows the expiration date, approving admin, approval time and reason, and Revoke asks for a reason and puts the block back", async () => {
    const { state } = setup(ADMIN, "organization_owner", { startApproved: true });
    const row = await cprRow();
    fireEvent.click(within(row).getByRole("button", { name: "Details" }));
    const det = await within(row).findByTestId("override-details");
    expect(within(det).getByTestId("override-expiry")).toHaveTextContent(/11\/26\/2026|Nov(ember)? 26/);
    expect(det).toHaveTextContent("Olivia Owner");
    expect(det).toHaveTextContent("Renewal booked for Friday");
    expect(det).toHaveTextContent(/Approved/);
    fireEvent.click(within(det).getByRole("button", { name: "Revoke" }));
    const dlg = await screen.findByRole("dialog", { name: "Revoke override" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Revoke override" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/reason/i);
    fireEvent.change(within(dlg).getByLabelText(/Reason/), { target: { value: "Renewal did not happen" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Revoke override" }));
    await waitFor(() => expect(state.posts.map((p) => p.path)).toEqual(["revoke"]));
    expect(state.posts[0]!.body).toMatchObject({ reason: "Renewal did not happen" });
    await waitFor(() => expect(within(row).getByText("Blocked")).toBeInTheDocument());       // the block is back
  });

  it("a user without compliance permission sees Details but cannot Approve or Revoke", async () => {
    setup(MANAGER, "manager");
    const row = await cprRow();
    expect(within(row).getByText("Blocked")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    cleanup();
    setup(MANAGER, "manager", { startApproved: true });
    const row2 = await cprRow();
    fireEvent.click(within(row2).getByRole("button", { name: "Details" }));
    const det = await within(row2).findByTestId("override-details");
    expect(det).toHaveTextContent("Olivia Owner");
    expect(within(det).queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });

  it("where the release switch is off the override routes do not exist: the row says Blocked and offers no Approve", async () => {
    setup(ADMIN, "organization_owner", { api: false });
    const row = await cprRow();
    expect(within(row).getByText("Blocked")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 300));
    expect(within(row).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("an approved override for another issue (a different key) does not hide the block: no override object, so the row stays Blocked with Approve", async () => {
    setup();
    const row = await cprRow();
    expect(within(row).getByText("Blocked")).toBeInTheDocument();
    expect(within(row).queryByText("Admin Approved")).not.toBeInTheDocument();
  });

  it("the compliance report lists the exception with who, why and when", async () => {
    const state = { approved: true };
    renderAws("/compliance", ADMIN, {
      "GET /v1/compliance/holds": () => json(200, { holds: [], totals: { holds: 0, affectedShifts: 0, affectedAssignments: 0, inProgressVisits: 0 }, shiftsAtRisk: [] }),
      "GET /v1/readiness-overrides": () => json(200, { overrides: [{ id: OV, caregiverRecordId: CG, caregiverCode: "CG-NEW00001", caregiverName: "Synthetic Reed", requirement: "cpr", issueStatus: "expired", issueLabel: "Expired Doc", validUntil: "2026-11-26", reason: "Renewal booked for Friday", approvedByName: "Olivia Owner", approvedAt: "2026-11-27T18:30:00Z", active: state.approved, revokedAt: null, revokedByName: null, revokeReason: null, stillApplies: true }] }),
    }, "organization_owner");
    const report = await screen.findByTestId("overrides-report", undefined, { timeout: 15000 });
    const r = within(report).getByTestId(`override-${OV}`);
    expect(r).toHaveTextContent("Synthetic Reed · CPR");
    expect(within(r).getByText("Admin Approved")).toBeInTheDocument();
    expect(r).toHaveTextContent("Expired Doc");
    expect(r).toHaveTextContent("Olivia Owner");
    expect(r).toHaveTextContent("Renewal booked for Friday");
  });
});

describe("Admin-approved exceptions export", () => {
  it("builds one export row per exception in report order and neutralises a leading formula character", async () => {
    const { overrideExportRows } = await import("./readiness/readiness-overrides-data");
    const base = { id: "1", caregiverRecordId: CG, caregiverCode: "CG-1", caregiverName: "=cmd Reed", requirement: "cpr" as const, issueStatus: "expired", issueLabel: "Expired Doc", validUntil: "2026-11-26", reason: "+Renewal booked", approvedByName: "Olivia Owner", approvedAt: "2026-11-27T18:30:00Z", active: true, revokedAt: null, revokedByName: null, revokeReason: null, stillApplies: true };
    const rows = overrideExportRows([base, { ...base, id: "2", caregiverName: "Ann Lee", requirement: "tb" as const, active: false, revokedAt: "2026-11-28T10:00:00Z", revokedByName: "Olivia Owner", revokeReason: "Renewed" }]);
    expect(rows).toHaveLength(2);
    expect(rows[0]![0]).toBe("'=cmd Reed");
    expect(rows[0]![8]).toBe("'+Renewal booked");
    expect([rows[0]![2], rows[0]![4], rows[0]![5], rows[0]![12]]).toEqual(["CPR", "2026-11-26", "Yes", "Yes"]);
    expect([rows[1]![2], rows[1]![5], rows[1]![9], rows[1]![12]]).toEqual(["TB", "No (revoked)", "2026-11-28T10:00:00Z", ""]);
  });
});
