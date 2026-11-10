// R7: when the agency has not finished the CPR/TB setup, the caregiver profile row says so and points an administrator to the setup (uploading cannot fix it);
// everyone else is told to ask an administrator. SYNTHETIC data only.
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { json, renderAws } from "./test-support";

afterEach(() => cleanup());
const CG = "abababab-0000-4000-8000-000000000009";
afterEach(() => cleanup());
const item = (requirement: string, label: string, kind: string, state: string, detail: string, over: Record<string, unknown> = {}) =>
  ({ requirement, label, kind, state, detail, dueDate: null, metOn: null, actorName: null, blocksShifts: false, nextAction: "none", extra: {}, ...over });
const readiness = (o: { background?: boolean; override?: boolean } = {}) => ({ caregiverRecordId: CG, caregiverCode: "CG-NEW00001", status: "not_ready", approved: false, approvedAt: null, approvedByName: null, approvalSource: null, met: 2, total: 5, waitingOn: ["App sign-in"],
  canApprove: false, hireDate: "2026-10-01", graceDays: 30, cprTbDueDate: "2026-10-31", enforcementActive: false,
  items: [item("background", "Background check", "hard", o.background === false ? "unmet" : "met", o.background === false ? "Not started" : "Verified", { nextAction: o.background === false ? "verify" : "view" }),
    item("training", "Required training", "hard", "met", "Done", { nextAction: "reopen", extra: { requirementId: "r1" } }),
    o.override ? item("signin", "App sign-in", "hard", "met", "Approved by override: not signed in", { extra: { override: true } }) : item("signin", "App sign-in", "hard", "unmet", "Invited, has not signed in yet", { nextAction: "resend_link", extra: { lastSentAt: null, sendCount: 1 } }),
    item("cpr", "CPR certificate", "flexible", "problem", "Document type not set up", { nextAction: "upload" }), item("tb", "TB clearance", "flexible", "problem", "Agency document rule not set up", { nextAction: "upload" })] });
const caregiver = { caregiverRecordId: CG, caregiverCode: "CG-NEW00001", firstName: "Synthetic", lastName: "Newcomer", preferredName: null, status: "onboarding", workStatus: "not_ready", readinessMet: 2, readinessTotal: 5, signedIn: false, hasContact: true,
  hasSignIn: false, signInStatus: null, activeAssignments: 1, plannedAssignments: 0, openVisits: 0, invitationEmail: null, invitedAt: null, invitationLastSentAt: null, invitationSendCount: null, firstSignedInAt: null };
const ADMIN = ["caregivers.manage", "visits.manage", "visits.read", "clients.names.read", "readiness.read", "readiness.manage", "caregivers.compliance.manage"];
const MANAGER = ["caregivers.manage", "visits.manage", "visits.read", "clients.names.read", "readiness.read"];
const base = () => ({
  "GET /v1/caregivers": () => json(200, { caregivers: [caregiver] }),
  [`GET /v1/caregivers/${CG}/readiness`]: () => json(200, { readiness: readiness() }),
});

describe("CPR/TB setup incomplete on the caregiver profile", () => {
  it("an administrator gets a link to the setup instead of Upload", async () => {
    renderAws(`/care-team/${CG}`, ADMIN, base(), "organization_owner");
    const row = (await screen.findByText("CPR certificate", undefined, { timeout: 15000 })).closest("li")!;
    const link = within(row).getByRole("link", { name: "Set up CPR and TB" });
    expect(link).toHaveAttribute("href", "/care-team#readiness-setup");
    expect(within(row).queryByRole("link", { name: "Upload" })).toBeNull();
  }, 30000);

  it("a manager without the setup permission is told to ask an administrator", async () => {
    renderAws(`/care-team/${CG}`, MANAGER, base(), "manager");
    const row = (await screen.findByText("TB clearance", undefined, { timeout: 15000 })).closest("li")!;
    expect(within(row).getByText("Ask an administrator")).toBeInTheDocument();
    expect(within(row).queryByRole("link", { name: /Set up|Upload/ })).toBeNull();
  }, 30000);
});
