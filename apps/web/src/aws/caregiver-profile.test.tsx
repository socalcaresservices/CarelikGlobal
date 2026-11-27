// Caregiver profile redesign: four tabs, compact rows (label, saved value, status, action), work approval never confused with a scheduling hold. SYNTHETIC data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { json, renderAws, type Handler } from "./test-support";

afterEach(() => cleanup());
const CG = "abababab-0000-4000-8000-000000000009";
const item = (requirement: string, label: string, kind: string, state: string, detail: string, over: Record<string, unknown> = {}) =>
  ({ requirement, label, kind, state, detail, dueDate: null, metOn: null, actorName: null, blocksShifts: false, nextAction: "none", extra: {}, ...over });
const approved = (over: Record<string, unknown> = {}, items?: unknown[]) => ({
  caregiverRecordId: CG, caregiverCode: "CG-NEW00001", status: "approved", approved: true, approvedAt: "2026-11-25T18:00:00Z", approvedByName: "Olivia Owner", approvalSource: "approval", met: 3, total: 5, waitingOn: [], canApprove: false,
  hireDate: "2026-11-01", graceDays: 30, cprTbDueDate: "2026-12-01", enforcementActive: false,
  items: items ?? [item("background", "Background check", "hard", "met", "Verified", { metOn: "2026-11-25", nextAction: "view" }), item("training", "Required training", "hard", "met", "Done", { metOn: "2026-11-25", nextAction: "reopen", extra: { requirementId: "r1" } }),
    item("signin", "App sign-in", "hard", "met", "Signed in", { nextAction: "view" }),
    item("cpr", "CPR certificate", "flexible", "problem", "Document type not set up", { dueDate: "2026-12-01", nextAction: "upload" }), item("tb", "TB clearance", "flexible", "problem", "Document type not set up", { dueDate: "2026-12-01", nextAction: "upload" })],
  ...over });
const caregiver = { caregiverRecordId: CG, caregiverCode: "CG-NEW00001", firstName: "Synthetic", lastName: "Reed", preferredName: null, status: "active", workStatus: "approved", readinessMet: 3, readinessTotal: 5, signedIn: true, hasContact: true,
  hasSignIn: true, signInStatus: "active", activeAssignments: 1, plannedAssignments: 0, openVisits: 0, invitationEmail: "reed.signin@example.invalid", invitedAt: "2026-11-02T00:00:00Z", invitationLastSentAt: null, invitationSendCount: 1, firstSignedInAt: "2026-11-03T00:00:00Z", hireType: "direct_hire", schedulingMode: "fixed" };
const ADMIN = ["caregivers.manage", "visits.manage", "visits.read", "staff.read", "clients.names.read", "readiness.read", "readiness.manage", "caregivers.compliance.manage", "documents.read"];
const base = (readiness = approved(), contact: string | null = "reed.contact@example.invalid"): Record<string, Handler> => ({
  "GET /v1/caregivers": () => json(200, { caregivers: [caregiver] }),
  [`GET /v1/caregivers/${CG}/readiness`]: () => json(200, { readiness }),
  "GET /v1/staff": () => json(200, { staff: [{ caregiverRecordId: CG, contactEmail: contact }] }),
  "GET /v1/document-readiness": () => json(200, { readiness: { requirements: [{ requirement: "cpr", status: "type_not_set", validUntil: null }, { requirement: "tb", status: "type_not_set", validUntil: null }] } }),
});
const at = (tab: string, handlers = base(), perms = ADMIN, role = "organization_owner") => renderAws(`/care-team/${CG}?tab=${tab}`, perms, handlers, role);

describe("the four sections", () => {
  it("shows Overview, Readiness, Assignments & availability and Documents as tabs, Overview first, and the selected tab is announced", async () => {
    renderAws(`/care-team/${CG}`, ADMIN, base(), "organization_owner");
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Overview", "Readiness", "Assignments & availability", "Documents"]);
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Readiness" }));
    expect(await screen.findByTestId("readiness-checklist")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Readiness" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("Overview", () => {
  it("shows the contact email and the app sign-in as two labelled rows with separate actions, values first, editors closed", async () => {
    at("overview");
    const contact = await screen.findByTestId("row-contact-email");
    await waitFor(() => expect(contact).toHaveTextContent("reed.contact@example.invalid"));
    expect(within(contact).getByText("Saved")).toBeInTheDocument();
    expect(within(contact).getByRole("button", { name: "Edit contact email" })).toBeInTheDocument();
    const signin = screen.getByTestId("row-app-signin");
    expect(signin).toHaveTextContent("reed.signin@example.invalid");
    expect(within(signin).getByRole("button", { name: "Manage app sign-in" })).toBeInTheDocument();
    expect(screen.getByTestId("signin-differs")).toHaveTextContent(/Open-shift alerts go to the contact email/);
    expect(screen.queryByLabelText(/Caregiver contact email/)).not.toBeInTheDocument();   // the editor opens only on Edit
    expect(screen.queryByRole("form", { name: "Hire date" })).not.toBeInTheDocument();
  });

  it("Edit opens the existing contact editor, which saves through the existing endpoint; a refused address shows the server's reason and the saved value is unchanged", async () => {
    const { calls } = at("overview", { ...base(), [`POST /v1/caregivers/${CG}/contact`]: ({ body }) => (body?.email === "taken@example.invalid" ? json(409, { error: { code: "conflict", message: "That email is already used by someone else in this agency. Each person needs their own email." } }) : json(200, { contact: { hasEmail: true } })) });
    const row = await screen.findByTestId("row-contact-email");
    fireEvent.click(within(row).getByRole("button", { name: "Edit contact email" }));
    const input = await within(row).findByLabelText(/Caregiver contact email/);
    fireEvent.change(input, { target: { value: "taken@example.invalid" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save contact email" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent(/already used by someone else in this agency/);
    expect(row).toHaveTextContent("reed.contact@example.invalid");
    fireEvent.change(input, { target: { value: "new.contact@example.invalid" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save contact email" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/contact")).map((c) => c.body?.email)).toEqual(["taken@example.invalid", "new.contact@example.invalid"]));
  });

  it("Employment shows hire date, hire type and scheduling type as saved values; the hire-date reason appears only while editing", async () => {
    at("overview");
    const hd = await screen.findByTestId("row-hire-date");
    await waitFor(() => expect(hd).toHaveTextContent(/Nov(ember)? 1,? 2026|11\/01\/2026|2026/));
    expect(screen.getByTestId("row-hire-type")).toHaveTextContent("Direct Hire");
    expect(screen.getByTestId("row-scheduling-type")).toHaveTextContent("Fixed");
    expect(screen.queryByLabelText("Reason")).not.toBeInTheDocument();
    fireEvent.click(within(hd).getByRole("button", { name: "Edit hire date" }));
    expect(await within(hd).findByLabelText("Reason")).toBeInTheDocument();
  });

  it("a role without caregiver management sees no contact, sign-in or employment rows and no Edit buttons", async () => {
    at("overview", base(), ["visits.manage", "visits.read", "staff.read"], "manager");
    await screen.findByRole("tab", { name: "Overview" });
    expect(screen.queryByTestId("row-contact-email")).not.toBeInTheDocument();
    expect(screen.queryByTestId("row-hire-date")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Edit / })).not.toBeInTheDocument();
  });

  it("the colour palette is not on the main Overview; the swatch beside the name stays", async () => {
    at("overview");
    await screen.findByTestId("row-contact-email");
    expect(screen.queryByText(/Caregiver Color/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Shown beside the caregiver/)).not.toBeInTheDocument();
  });
});

describe("Readiness: work approval and agency setup are not mixed with scheduling holds", () => {
  it("an approved caregiver whose CPR and TB types are not set up stays Approved; both rows say Document type not set up; there is no scheduling hold and no eligibility claim; one shared setup action", async () => {
    at("readiness");
    const chip = await screen.findByTestId("work-approval-chip");
    expect(chip).toHaveTextContent("Work approval: Approved");
    for (const r of ["cpr", "tb"]) {
      const row = document.querySelector(`[data-requirement="${r}"]`) as HTMLElement;
      expect(within(row).getByText("Setup needed")).toBeInTheDocument();
      expect(row).toHaveTextContent("Document type not set up");
      expect(within(row).queryByRole("link", { name: "Upload" })).not.toBeInTheDocument();
    }
    expect(screen.queryByTestId("scheduling-hold")).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Set up CPR and TB" })).toHaveLength(1);
    expect(screen.getByTestId("cpr-tb-setup")).toHaveTextContent(/does not change this caregiver's work approval/);
    expect(document.body).not.toHaveTextContent(/Eligible to schedule/i);
  });

  it("a real scheduling hold shows its own reason next to Approved; the approval badge is never read as eligibility", async () => {
    const r = approved({}, [item("background", "Background check", "hard", "met", "Verified", { metOn: "2026-11-25", nextAction: "view" }), item("training", "Required training", "hard", "met", "Done", { nextAction: "reopen" }), item("signin", "App sign-in", "hard", "met", "Signed in"),
      item("cpr", "CPR certificate", "flexible", "problem", "Expired", { blocksShifts: true, dueDate: "2026-12-01", nextAction: "upload" }), item("tb", "TB clearance", "flexible", "met", "Verified", { metOn: "2026-11-20" })]);
    at("readiness", base(r));
    expect(await screen.findByTestId("work-approval-chip")).toHaveTextContent("Work approval: Approved");
    const hold = await screen.findByTestId("scheduling-hold");
    expect(hold).toHaveTextContent("CPR certificate: Expired");
    expect(hold).toHaveTextContent(/Work approval is a separate step/);
    expect(document.body).not.toHaveTextContent(/Eligible to schedule/i);
  });

  it("a saved answer, a pending review and an approval use three different words and three different tones", async () => {
    const r = approved({}, [item("background", "Background check", "hard", "unmet", "Requested", { nextAction: "verify" }), item("training", "Required training", "hard", "met", "Done", { nextAction: "reopen" }), item("signin", "App sign-in", "hard", "met", "Signed in"),
      item("cpr", "CPR certificate", "flexible", "pending", "Uploaded, waiting for review", { dueDate: "2026-12-01", nextAction: "upload" }), item("tb", "TB clearance", "flexible", "unmet", "Not uploaded", { dueDate: "2026-12-01", nextAction: "upload" })]);
    at("readiness", base(r));
    await screen.findByTestId("work-approval-chip");
    const tone = (t: string) => screen.getAllByText(t)[0]!.getAttribute("data-tone");
    expect(tone("Requested")).toBe("saved");
    expect(tone("Pending review")).toBe("warn");
    expect(tone("Approved")).toBe("ok");
    expect(tone("Not recorded")).toBe("neutral");
  });

  it("approval wording appears only when there is a recorded approval: a caregiver who is not approved reads Not approved and says what is missing", async () => {
    const r = approved({ status: "not_ready", approved: false, approvedAt: null, approvedByName: null, approvalSource: null, waitingOn: ["Required training"], canApprove: false });
    at("readiness", base(r));
    const chip = await screen.findByTestId("work-approval-chip");
    expect(chip).toHaveTextContent("Work approval: Not ready");
    const row = document.querySelector('[data-requirement="approve"]') as HTMLElement;
    expect(within(row).getByText("Not approved")).toBeInTheDocument();
    expect(row).toHaveTextContent("Waiting on: Required training");
    expect(row).not.toHaveTextContent(/Approved .* by /);
  });

  it("the approval row keeps who approved it and when", async () => {
    at("readiness");
    await screen.findByTestId("work-approval-chip");
    const row = document.querySelector('[data-requirement="approve"]') as HTMLElement;
    expect(row).toHaveTextContent(/Approved .* by Olivia Owner/);
  });

  it("Manage sign-in on Overview opens the Readiness tab", async () => {
    at("overview");
    const row = await screen.findByTestId("row-app-signin");
    fireEvent.click(within(row).getByRole("button", { name: "Manage app sign-in" }));
    expect(await screen.findByTestId("readiness-checklist")).toBeInTheDocument();
  });
});

describe("Documents and Assignments", () => {
  it("Documents shows type, status, due date and action on one row; an unset document type reads Document type not set up", async () => {
    at("documents");
    const cpr = await screen.findByTestId("doc-cpr");
    expect(within(cpr).getByText("Document type not set up")).toBeInTheDocument();
    await waitFor(() => expect(cpr).toHaveTextContent(/Due/));
    expect(within(cpr).getByRole("link", { name: "Open documents" })).toHaveAttribute("href", "/documents");
  });

  it("the Schedule colour is one optional row under Scheduling preferences, not on Overview", async () => {
    at("assignments", { ...base(), "GET /v1/offices": () => json(200, { offices: [] }), "GET /v1/people-facets": () => json(200, { facets: { clientOffices: [], caregiverOffices: [], clientCounties: [], caregiverCounties: [], caregiverColors: [] } }) });
    const row = await screen.findByTestId("row-schedule-color");
    expect(row).toHaveTextContent("Optional");
    expect(within(row).getByRole("button", { name: "Edit schedule color" })).toBeInTheDocument();
  });
});
