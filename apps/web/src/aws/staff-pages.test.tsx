// People > Staff, Settings > Staff Types and Roles & Permissions (0086), against an in-memory fake of the AWS API. SYNTHETIC data only.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CognitoAuthProvider, type CognitoAuthClient } from "@carelik/auth";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsApiClient } from "@/lib/aws-api";
import { AwsRoutes } from "./aws-root";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const ME = "bbbbbbbb-0000-4000-8000-000000000001";
const MGR = "bbbbbbbb-0000-4000-8000-000000000002";
const PROFILE_NEW = "cccccccc-0000-4000-8000-000000000001";
const PROFILE_ACTIVE = "cccccccc-0000-4000-8000-000000000002";
const PROFILE_PENDING = "cccccccc-0000-4000-8000-000000000003";
const PROFILE_DISABLED = "cccccccc-0000-4000-8000-000000000004";
const T_MANAGER = "dddddddd-0000-4000-8000-000000000001";
const T_OFFICE = "dddddddd-0000-4000-8000-000000000002";
const T_OLD = "dddddddd-0000-4000-8000-000000000003";
type Role = "organization_owner" | "manager";
type Call = { method: string; path: string; query: string; body: Record<string, unknown> | null };

function fakeApi(role: Role) {
  const calls: Call[] = [];
  const permissions = role === "organization_owner"
    ? ["staff.read", "staff.manage", "accounts.manage", "caregivers.manage", "visits.read", "visits.manage", "organization.update", "clients.names.read"]
    : ["caregivers.manage", "visits.read", "visits.manage", "clients.names.read"];
  const types = [
    { id: T_MANAGER, name: "Manager", isActive: true, sortOrder: 20, staffCount: "1" },
    { id: T_OFFICE, name: "Office Assistant", isActive: true, sortOrder: 60, staffCount: "1" },
    { id: T_OLD, name: "Intake Clerk", isActive: false, sortOrder: 100, staffCount: "0" },
  ];
  const staff = [
    { staffKey: `member:${ME}`, profileId: null, caregiverRecordId: null, userId: ME, displayName: "Synthetic Admin", staffTypeId: null, staffTypeName: null, contactEmail: null, phone: null, status: "active", systemRole: "organization_owner", accessStatus: "active", isSelf: true },
    { staffKey: `member:${MGR}`, profileId: null, caregiverRecordId: null, userId: MGR, displayName: "Synthetic Manager", staffTypeId: null, staffTypeName: null, contactEmail: null, phone: null, status: "active", systemRole: "manager", accessStatus: "active", isSelf: false },
    { staffKey: `profile:${PROFILE_NEW}`, profileId: PROFILE_NEW, caregiverRecordId: null, userId: null, displayName: "Nia NoAccess", staffTypeId: T_OFFICE, staffTypeName: "Office Assistant", contactEmail: "nia.contact@example.test", phone: "555 0101", status: "active", systemRole: null, accessStatus: "none", isSelf: false },
    { staffKey: `profile:${PROFILE_ACTIVE}`, profileId: PROFILE_ACTIVE, caregiverRecordId: null, userId: "bbbbbbbb-0000-4000-8000-000000000003", displayName: "Abe Active", staffTypeId: T_MANAGER, staffTypeName: "Manager", contactEmail: null, phone: null, status: "active", systemRole: "scheduler", accessStatus: "active", isSelf: false },
    { staffKey: `profile:${PROFILE_PENDING}`, profileId: PROFILE_PENDING, caregiverRecordId: null, userId: "bbbbbbbb-0000-4000-8000-000000000004", displayName: "Pia Pending", staffTypeId: T_OFFICE, staffTypeName: "Office Assistant", contactEmail: null, phone: null, status: "active", systemRole: "staff", accessStatus: "invitation_pending", isSelf: false },
    { staffKey: `profile:${PROFILE_DISABLED}`, profileId: PROFILE_DISABLED, caregiverRecordId: null, userId: "bbbbbbbb-0000-4000-8000-000000000005", displayName: "Dee Disabled", staffTypeId: T_OFFICE, staffTypeName: "Office Assistant", contactEmail: "dee.contact@example.test", phone: "555 0105", status: "active", systemRole: "staff", accessStatus: "disabled", isSelf: false },
    { staffKey: "caregiver:eeeeeeee-0000-4000-8000-000000000001", profileId: null, caregiverRecordId: "eeeeeeee-0000-4000-8000-000000000001", userId: null, displayName: "Cara Caregiver", staffTypeId: null, staffTypeName: "Caregiver", contactEmail: null, phone: null, status: "active", systemRole: null, accessStatus: "none", isSelf: false },
  ];
  const roles = [
    { role: "organization_owner", memberCount: "1", assignable: false, permissions: [{ key: "staff.manage", description: "Add and edit staff" }, { key: "accounts.manage", description: "Disable sign-ins" }] },
    { role: "manager", memberCount: "1", assignable: true, permissions: [{ key: "visits.manage", description: "Manage visits" }] },
    { role: "caregiver", memberCount: "3", assignable: false, permissions: [] },
  ];
  const json = (code: number, body: unknown) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = (init?.body ? JSON.parse(String(init.body)) : null) as Record<string, unknown> | null;
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname, query: url.search, body });
    if (method === "POST" && body?.reason === "FAIL") return json(409, { error: { code: "conflict", message: "The Owner role is protected and cannot be changed here." } });
    switch (`${method} ${url.pathname}`) {
      case "GET /v1/me":
        return json(200, { memberships: [{ organizationId: ORG, organizationSlug: "org-a", organizationName: "Synthetic Care Co", organizationTimezone: "America/Los_Angeles", role, permissions }], profile: { displayName: "Synthetic Admin" } });
      case "GET /v1/branding":
        return json(200, { branding: { organizationId: ORG, displayName: "Synthetic Care Co", accentColor: null, logoSha256: null } });
      case "GET /v1/attention":
        return json(200, { summary: null });
      case "GET /v1/staff":
        return json(200, { staff });
      case "GET /v1/staff-types":
        return json(200, { staffTypes: types });
      case "GET /v1/role-permissions":
        return json(200, { roles });
      case "GET /v1/staff-audit":
        return json(200, { events: [{ occurredAt: "2026-10-20T10:00:00Z", action: "staff.created", actorName: "Synthetic Admin", reason: null }, { occurredAt: "2026-10-21T10:00:00Z", action: "staff.role_changed", actorName: "Synthetic Admin", reason: "New duties" }] });
      case "POST /v1/staff":
      case "POST /v1/staff-types":
        return json(201, { staff: { id: "new" }, staffType: { id: "new" } });
      case "POST /v1/staff-types/dddddddd-0000-4000-8000-000000000001/rename":
      case "POST /v1/staff-types/dddddddd-0000-4000-8000-000000000001/active":
        return json(200, { staffType: { id: T_MANAGER } });
      case `POST /v1/staff/${PROFILE_NEW}/invitation`:
        return json(201, { invitation: { profileId: PROFILE_NEW } });
      case `POST /v1/staff/${PROFILE_PENDING}/invitation/resend`:
        return json(200, { invitation: { sendCount: 2 } });
      case `POST /v1/staff-roles/${MGR}`:
      case "POST /v1/staff-roles/bbbbbbbb-0000-4000-8000-000000000003":
        return json(200, { staff: { userId: MGR, role: "scheduler" } });
      case `POST /v1/staff-members/${MGR}/profile`:
        return json(201, { staff: { id: "p" } });
      default:
        return json(404, { error: { code: "not_found", message: "No such endpoint." } });
    }
  });
  return { calls, fetchImpl };
}

function renderAt(path: string, role: Role) {
  const api = fakeApi(role);
  const auth = {
    subscribe: vi.fn(() => () => {}),
    getSession: vi.fn(async () => ({ user: { id: "11111111-2222-4333-8444-555555555555", email: "person@example.test", emailVerified: true }, access_token: "t", expires_at: 4_000_000_000 })),
    getAccessToken: vi.fn(async () => "t"), signIn: vi.fn(), handleCallback: vi.fn(), startPasswordReset: vi.fn(), signOut: vi.fn(),
  };
  const client = createAwsApiClient({ baseUrl: "https://api.example.test", getAccessToken: () => auth.getAccessToken(), fetch: api.fetchImpl as never });
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CognitoAuthProvider client={auth as unknown as CognitoAuthClient}>
          <AwsRoutes api={client} publicApi={client} />
        </CognitoAuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return api;
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const rowOf = async (name: string) => (await within(await screen.findByRole("table", { name: "Staff" })).findByText(name)).closest("tr")!;
const lastPost = (api: ReturnType<typeof fakeApi>, path: string) => api.calls.filter((c) => c.method === "POST" && c.path === path).at(-1);

describe("Staff", () => {
  it("lists every kind of staff once, numbered 1..n in list order, with type, role and access in plain words", async () => {
    renderAt("/staff", "organization_owner");
    const table = await screen.findByRole("table", { name: "Staff" });
    expect(within(table).getAllByRole("columnheader").map((c) => c.textContent)).toEqual(["No.", "Name", "Staff Type", "Role", "Sign-in status", "Staff record", "Contact email", "Phone", "Actions"]);
    expect(within(table).getAllByTestId("row-no").map((c) => c.textContent)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(await rowOf("Nia NoAccess")).toHaveTextContent("Office Assistant");
    expect(await rowOf("Nia NoAccess")).toHaveTextContent("No sign-in");
    expect(await rowOf("Abe Active")).toHaveTextContent("Scheduler");
    expect(await rowOf("Pia Pending")).toHaveTextContent("Invited");
    expect(await rowOf("Synthetic Admin")).toHaveTextContent("Owner");
    expect(await rowOf("Nia NoAccess")).toHaveTextContent("nia.contact@example.test");   // the contact email, never the sign-in email
    expect(await rowOf("Nia NoAccess")).toHaveTextContent("555 0101");
    expect(await rowOf("Dee Disabled")).toHaveTextContent("Disabled");
    expect(await rowOf("Synthetic Admin")).toHaveTextContent("you");
    // a caregiver is read from the Care Team: a link there, no second profile to edit
    const cara = await rowOf("Cara Caregiver");
    expect(within(cara).getByRole("link", { name: "Cara Caregiver" }).getAttribute("href")).toBe("/care-team/eeeeeeee-0000-4000-8000-000000000001");
    expect(within(cara).queryByRole("button", { name: /^Edit/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/cognito|password/i);
  });

  it("an administrator adds staff with a contact email that is separate from the sign-in email", async () => {
    const api = renderAt("/staff", "organization_owner");
    fireEvent.click(await screen.findByRole("button", { name: "Add office staff" }));
    const form = await screen.findByRole("form", { name: "Add office staff" });
    expect(within(form).getAllByRole("option").map((o) => o.textContent)).toEqual(["Manager", "Office Assistant"]);   // inactive types cannot be chosen for someone new
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "  Quinn Newhire " } });
    fireEvent.change(within(form).getByLabelText("Staff type"), { target: { value: T_OFFICE } });
    fireEvent.change(within(form).getByLabelText("Contact email"), { target: { value: "quinn.contact@example.test" } });
    fireEvent.change(within(form).getByLabelText("Phone"), { target: { value: "555 0102" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add office staff" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Staff added.");
    expect(lastPost(api, "/v1/staff")?.body).toEqual({ organizationId: ORG, displayName: "Quinn Newhire", staffTypeId: T_OFFICE, contactEmail: "quinn.contact@example.test", phone: "555 0102" });
  });

  it("setting a person who has a sign-in inactive warns that it also ends their access (0087); a person without a sign-in gets no such warning", async () => {
    renderAt("/staff", "organization_owner");
    fireEvent.click(within(await rowOf("Abe Active")).getByRole("button", { name: "Edit: Abe Active" }));
    let edit = await screen.findByRole("form", { name: "Edit staff" });
    expect(within(edit).queryByText(/also stops their access/)).toBeNull();
    fireEvent.change(within(edit).getByLabelText("Status"), { target: { value: "inactive" } });
    expect(within(edit).getByText(/also stops their access to this organization.*Accounts > Enable/)).toBeInTheDocument();
    fireEvent.click(within(edit).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(await rowOf("Nia NoAccess")).getByRole("button", { name: "Edit: Nia NoAccess" }));
    edit = await screen.findByRole("form", { name: "Edit staff" });
    fireEvent.change(within(edit).getByLabelText("Status"), { target: { value: "inactive" } });
    expect(within(edit).queryByText(/also stops their access/)).toBeNull();
  });

  it("edit keeps an inactive current type selectable and posts the change; invite offers only the supported roles", async () => {
    const api = renderAt("/staff", "organization_owner");
    fireEvent.click(within(await rowOf("Nia NoAccess")).getByRole("button", { name: "Edit: Nia NoAccess" }));
    const edit = await screen.findByRole("form", { name: "Edit staff" });
    expect(within(edit).getByLabelText("Contact email")).toHaveValue("nia.contact@example.test");
    fireEvent.change(within(edit).getByLabelText("Status"), { target: { value: "inactive" } });
    fireEvent.click(within(edit).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(lastPost(api, `/v1/staff/${PROFILE_NEW}`)?.body).toMatchObject({ status: "inactive", displayName: "Nia NoAccess" }));

    fireEvent.click(within(await rowOf("Nia NoAccess")).getByRole("button", { name: "Invite: Nia NoAccess" }));
    const invite = await screen.findByRole("form", { name: "Invite to sign in" });
    expect(within(invite).getAllByRole("option").map((o) => o.textContent)).toEqual(["Administrator", "Manager", "Scheduler", "Coordinator", "Staff", "Read-only"]);   // never Owner or Caregiver
    fireEvent.change(within(invite).getByLabelText("Sign-in email"), { target: { value: "nia.signin@example.test" } });
    fireEvent.change(within(invite).getByLabelText("Role"), { target: { value: "scheduler" } });
    fireEvent.click(within(invite).getByRole("button", { name: "Send invitation" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/Invitation recorded\. If this email already has an Ogevia sign-in, the person is asked to accept/);
    expect(lastPost(api, `/v1/staff/${PROFILE_NEW}/invitation`)?.body).toEqual({ organizationId: ORG, email: "nia.signin@example.test", role: "scheduler" });
  });

  it("a person who has not signed in yet can be sent the invitation again", async () => {
    const api = renderAt("/staff", "organization_owner");
    fireEvent.click(within(await rowOf("Pia Pending")).getByRole("button", { name: "Resend invite: Pia Pending" }));
    fireEvent.click(await screen.findByRole("button", { name: "Resend invitation" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Invitation sent again.");
    expect(lastPost(api, `/v1/staff/${PROFILE_PENDING}/invitation/resend`)?.body).toEqual({ organizationId: ORG });
  });

  it("changing a role needs a different role and a reason; yourself and the Owner cannot be changed; a refusal from the server is shown", async () => {
    const api = renderAt("/staff", "organization_owner");
    expect(within(await rowOf("Synthetic Admin")).queryByRole("button", { name: /Change role/ })).toBeNull();   // yourself / the Owner role
    fireEvent.click(within(await rowOf("Synthetic Manager")).getByRole("button", { name: "Change role: Synthetic Manager" }));
    const form = await screen.findByRole("form", { name: "Change role" });
    const submit = within(form).getByRole("button", { name: "Change role" });
    expect(submit).toBeDisabled();   // same role, no reason
    fireEvent.change(within(form).getByLabelText("Role"), { target: { value: "scheduler" } });
    expect(submit).toBeDisabled();   // still no reason
    fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "FAIL" } });
    fireEvent.click(submit);
    expect(await within(form).findByRole("alert")).toHaveTextContent("The Owner role is protected");
    fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "New duties" } });
    fireEvent.click(submit);
    expect(await screen.findByRole("status")).toHaveTextContent("Role changed.");
    expect(lastPost(api, `/v1/staff-roles/${MGR}`)?.body).toEqual({ organizationId: ORG, role: "scheduler", reason: "New duties" });
  });

  it("disable access reuses the accounts rule: a reason is required", async () => {
    renderAt("/staff", "organization_owner");
    fireEvent.click(within(await rowOf("Abe Active")).getByRole("button", { name: "Disable access: Abe Active" }));
    const form = await screen.findByRole("form", { name: "Disable access" });
    expect(within(form).getByRole("button", { name: "Disable access" })).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "ok" } });
    expect(within(form).getByRole("button", { name: "Disable access" })).toBeDisabled();   // fewer than 3 characters
  });

  it("history shows what was done, by whom and why", async () => {
    renderAt("/staff", "organization_owner");
    fireEvent.click(within(await rowOf("Abe Active")).getByRole("button", { name: "History: Abe Active" }));
    const history = await screen.findByRole("region", { name: "History of Abe Active" });
    expect(await within(history).findByText("Role changed")).toBeInTheDocument();
    expect(history).toHaveTextContent("by Synthetic Admin");
    expect(history).toHaveTextContent("New duties");
  });

  it("someone without staff.read sees a refusal, and the menu shows no Staff tab", async () => {
    const api = renderAt("/staff", "manager");
    expect(await screen.findByText("Only an administrator can manage staff.")).toBeInTheDocument();
    expect(api.calls.some((c) => c.path === "/v1/staff")).toBe(false);   // nothing is even requested
    const nav = screen.getByRole("navigation", { name: "Main" });
    fireEvent.click(within(nav).getByRole("button", { name: /^Staff/ }));
    expect(within(nav).getByRole("link", { name: "Caregivers" })).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Staff" })).toBeNull();
    expect(within(nav).queryByRole("link", { name: "Staff Types" })).toBeNull();
  });

  it("the owner's menu has Staff and Staff Types beside Caregivers, Roles & Permissions and Agency Settings under Settings, and Accounts as a tab of Roles & Permissions", async () => {
    renderAt("/staff", "organization_owner");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Staff" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Staff Types" }).getAttribute("href")).toBe("/settings/staff-types");
    fireEvent.click(within(nav).getByRole("button", { name: /^Settings/ }));
    expect(within(nav).getByRole("link", { name: "Roles & Permissions" }).getAttribute("href")).toBe("/settings/roles");
    expect(within(nav).getByRole("link", { name: "Agency Settings" }).getAttribute("href")).toBe("/settings/branding");
    cleanup();
    renderAt("/settings/roles", "organization_owner");
    const settingsNav = await screen.findByRole("navigation", { name: "Main" });
    expect(screen.queryByRole("navigation", { name: "Section tabs" })).toBeNull();
    expect(within(settingsNav).getByRole("link", { name: "Accounts" }).getAttribute("href")).toBe("/accounts");
  });

  it("search and the Staff Type, Role and Status filters narrow the list; the numbers follow the filter; Clear Filters brings everyone back", async () => {
    renderAt("/staff", "organization_owner");
    await screen.findByRole("table", { name: "Staff" });
    const names = () => within(screen.getByRole("table", { name: "Staff" })).getAllByRole("rowheader").map((c) => c.textContent?.replace(/· you/, "").trim());
    const numbers = () => within(screen.getByRole("table", { name: "Staff" })).getAllByTestId("row-no").map((c) => c.textContent);
    expect(names()).toHaveLength(7);
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "nia.contact" } });   // the contact email is searchable
    expect(names()).toEqual(["Nia NoAccess"]);
    expect(numbers()).toEqual(["1"]);
    fireEvent.click(screen.getByRole("button", { name: "Clear Filters" }));
    expect(names()).toHaveLength(7);
    fireEvent.change(screen.getByLabelText("Staff type"), { target: { value: T_OFFICE } });
    expect(names()).toEqual(["Nia NoAccess", "Pia Pending", "Dee Disabled"]);
    expect(numbers()).toEqual(["1", "2", "3"]);
    fireEvent.change(screen.getByLabelText("Sign-in status"), { target: { value: "Invited" } });
    expect(names()).toEqual(["Pia Pending"]);
    fireEvent.click(screen.getByRole("button", { name: "Clear Filters" }));
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "manager" } });
    expect(names()).toEqual(["Synthetic Manager"]);
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "zzz" } });
    expect(await screen.findByText(/No staff match/)).toBeInTheDocument();
  });

  it("each row offers only the actions that are true for it: Invite, Invite again, Disable or Enable, never both Disable and Enable", async () => {
    renderAt("/staff", "organization_owner");
    const has = async (who: string, name: RegExp) => within(await rowOf(who)).queryByRole("button", { name }) !== null;
    expect(await has("Nia NoAccess", /^Invite:/)).toBe(true);
    expect(await has("Nia NoAccess", /^Disable|^Enable/)).toBe(false);      // no account yet
    expect(await has("Pia Pending", /^Invite again|^Resend invite/)).toBe(true);
    expect(await has("Abe Active", /^Disable access/)).toBe(true);
    expect(await has("Abe Active", /^Enable access/)).toBe(false);
    expect(await has("Dee Disabled", /^Enable access/)).toBe(true);
    expect(await has("Dee Disabled", /^Disable access/)).toBe(false);
    expect(await has("Synthetic Admin", /Disable|Enable|Invite/)).toBe(false);   // yourself
  });
});

describe("Staff Types", () => {
  it("lists the types with how many people use each, marks inactive ones, and lets an administrator add, rename and deactivate", async () => {
    const api = renderAt("/settings/staff-types", "organization_owner");
    const list = await screen.findByRole("list", { name: "Staff types" });
    expect(await within(list).findAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByText("Intake Clerk").closest("li")).toHaveTextContent("Inactive");
    fireEvent.change(screen.getByLabelText("New staff type"), { target: { value: " Billing Lead " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Staff type added.");
    expect(lastPost(api, "/v1/staff-types")?.body).toEqual({ organizationId: ORG, name: "Billing Lead" });
    fireEvent.click(screen.getByRole("button", { name: "Rename Manager" }));
    fireEvent.change(await screen.findByLabelText("Staff type name"), { target: { value: "Team Manager" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(lastPost(api, `/v1/staff-types/${T_MANAGER}/rename`)?.body).toEqual({ organizationId: ORG, name: "Team Manager" }));
    fireEvent.click(await screen.findByRole("button", { name: "Deactivate Manager" }));
    await waitFor(() => expect(lastPost(api, `/v1/staff-types/${T_MANAGER}/active`)?.body).toEqual({ organizationId: ORG, active: false }));
  });

  it("states that a type grants nothing, and is refused to someone without staff.read", async () => {
    renderAt("/settings/staff-types", "organization_owner");
    await waitFor(() => expect(screen.getByTestId("page-help-panel")).toHaveTextContent(/never gives access/));
    cleanup();
    renderAt("/settings/staff-types", "manager");
    expect(await screen.findByText("Only an administrator can manage staff.")).toBeInTheDocument();
  });
});

describe("Roles & Permissions", () => {
  it("shows each role with its description and users assigned, then a read-only permission matrix: granted and not granted, no permission keys", async () => {
    renderAt("/settings/roles", "organization_owner");
    const roles = await screen.findByRole("table", { name: "Roles" });
    expect(within(roles).getAllByRole("columnheader").map((c) => c.textContent)).toEqual(["Role", "Description", "Users Assigned"]);
    const row = (name: string) => within(roles).getByText(name).closest("tr")!;
    expect(row("Owner")).toHaveTextContent("Full system administration");
    expect(within(row("Owner")).getAllByRole("cell").at(-1)).toHaveTextContent("1");
    expect(row("Manager")).toHaveTextContent("Clients, caregivers, scheduling, visits and billing approval");
    expect(row("Caregiver")).toHaveTextContent("No permissions granted");   // from the data: a role with no permissions says so
    expect(within(row("Caregiver")).getAllByRole("cell").at(-1)).toHaveTextContent("3");
    const matrix = screen.getByRole("table", { name: "Permissions by role" });
    expect(within(matrix.querySelector("thead")!).getAllByRole("columnheader").map((c) => c.textContent)).toEqual(["Permission", "Owner", "Manager", "Caregiver"]);
    const perm = (text: string) => within(matrix).getByText(text).closest("tr")!;
    expect(within(perm("Add and edit staff")).getAllByRole("cell").map((c) => c.textContent)).toEqual(["✓Granted", "–Not granted", "–Not granted"]);
    expect(within(perm("Manage visits")).getAllByRole("cell").map((c) => c.textContent)).toEqual(["–Not granted", "✓Granted", "–Not granted"]);
    expect(document.body.textContent).not.toMatch(/staff\.manage|accounts\.manage|visits\.manage/);   // no permission keys
    expect(screen.queryAllByRole("button", { name: /save|change|edit|delete/i })).toHaveLength(0);   // read only
  });
});
