import { Fragment, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@carelik/ui";
import { Link } from "react-router-dom";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { PageHeader } from "./ui/page-header";

// People > Staff, Settings > Staff Types, Settings > Roles & Permissions (migration 0086).
// A staff TYPE is a label (job title). A system ROLE is what a person may do; only it grants access, and only an administrator changes it.
// Everything is authorized again in PostgreSQL; the screens only decide what to show.

export interface StaffRow {
  staffKey: string;
  profileId: string | null;
  caregiverRecordId: string | null;
  userId: string | null;
  displayName: string;
  staffTypeId: string | null;
  staffTypeName: string | null;
  contactEmail: string | null;
  phone: string | null;
  status: "active" | "inactive";
  systemRole: string | null;
  accessStatus: "none" | "invitation_pending" | "active" | "disabled";
  isSelf: boolean;
}
export interface StaffType { id: string; name: string; isActive: boolean; sortOrder: number; staffCount: number | string }
interface RoleRow { role: string; memberCount: number | string; assignable: boolean; permissions: { key: string; description: string }[] }
interface AuditEvent { occurredAt: string; action: string; actorName: string; reason: string | null }

/** The system roles an administrator can assign (never the Owner, a caregiver or a client-side role). */
const ASSIGNABLE_ROLES = ["organization_admin", "manager", "scheduler", "coordinator", "staff", "read_only"] as const;
const ROLE_NAME: Record<string, string> = {
  organization_owner: "Owner", organization_admin: "Administrator", manager: "Manager", scheduler: "Scheduler", coordinator: "Coordinator",
  staff: "Staff", read_only: "Read-only", caregiver: "Caregiver",
};
const roleName = (role: string | null) => (role ? ROLE_NAME[role] ?? role : "No access");
const ACCESS_LABEL: Record<StaffRow["accessStatus"], string> = { none: "No sign-in", invitation_pending: "Invited", active: "Active", disabled: "Disabled" };
/** What the Status column and its filter show: an inactive profile first, otherwise the state of the person's sign-in. */
const statusOf = (r: StaffRow) => (r.status === "inactive" ? "Inactive" : ACCESS_LABEL[r.accessStatus]);
const STATUS_CHOICES = ["Active", "Invited", "Disabled", "No sign-in", "Inactive"] as const;
const ACCESS_BADGE: Record<StaffRow["accessStatus"], string> = {
  none: "bg-slate-100 text-slate-800", invitation_pending: "bg-amber-100 text-amber-900", active: "bg-emerald-100 text-emerald-900", disabled: "bg-slate-200 text-slate-800",
};
const ACTION_LABEL: Record<string, string> = {
  "staff.created": "Added", "staff.updated": "Profile updated", "staff.invited": "Invited", "staff.invitation_resent": "Invitation resent", "staff.role_changed": "Role changed",
  "staff.profile_added": "Profile added", "account.disabled": "Access disabled", "account.enabled": "Access enabled",
  "staff_type.created": "Type added", "staff_type.renamed": "Type renamed", "staff_type.activated": "Type activated", "staff_type.deactivated": "Type deactivated",
};
const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const inputClass = "mt-0.5 block w-full rounded-md border border-slate-300 bg-og-card px-2 py-1.5 text-sm";

const typeKey = (org: string | null) => ["aws-staff-types", org] as const;
const staffKey = (org: string | null) => ["aws-staff", org] as const;

/** Why a screen cannot be used: the same plain wording as Accounts. */
function NotAllowed() {
  return <Card><p className="text-sm text-slate-700">Only an administrator can manage staff.</p></Card>;
}

function useStaffTypes(enabled: boolean) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  return useQuery({
    queryKey: typeKey(activeOrganizationId),
    queryFn: () => api.get<{ staffTypes: StaffType[] }>("/v1/staff-types", { organizationId: activeOrganizationId }),
    enabled: !!activeOrganizationId && enabled,
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// People > Staff
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
type Panel = { kind: "add" } | { kind: "edit" | "invite" | "role" | "access" | "history" | "member"; row: StaffRow };

const ALL = "all";
const filterClass = "min-h-[36px] rounded-md border border-slate-300 bg-og-card px-2 text-sm";

export function StaffPage() {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const canRead = hasPermission("staff.read");
  const canManage = hasPermission("staff.manage");
  const canAccounts = hasPermission("accounts.manage");
  const [panel, setPanel] = useState<Panel | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState(ALL);
  const [roleFilter, setRoleFilter] = useState(ALL);
  const [statusFilter, setStatusFilter] = useState(ALL);
  const staff = useQuery({
    queryKey: staffKey(activeOrganizationId),
    queryFn: () => api.get<{ staff: StaffRow[] }>("/v1/staff", { organizationId: activeOrganizationId }),
    enabled: !!activeOrganizationId && canRead,
  });
  const types = useStaffTypes(canRead);
  if (!canRead) return <NotAllowed />;

  const finish = async (text: string) => {
    setDone(text);
    setPanel(null);
    await qc.invalidateQueries({ queryKey: staffKey(activeOrganizationId) });
    await qc.invalidateQueries({ queryKey: typeKey(activeOrganizationId) });
  };
  const all = staff.data?.staff ?? [];
  const activeTypes = (types.data?.staffTypes ?? []).filter((t) => t.isActive);
  const needle = search.trim().toLowerCase();
  const rows = all.filter((r) =>
    (!needle || [r.displayName, r.staffTypeName, r.contactEmail, r.phone].some((v) => v?.toLowerCase().includes(needle)))
    && (typeFilter === ALL || (typeFilter === "none" ? r.staffTypeId === null : r.staffTypeId === typeFilter))
    && (roleFilter === ALL || (r.systemRole ?? "none") === roleFilter)
    && (statusFilter === ALL || statusOf(r) === statusFilter));
  const filtered = needle !== "" || typeFilter !== ALL || roleFilter !== ALL || statusFilter !== ALL;
  const clear = () => { setSearch(""); setTypeFilter(ALL); setRoleFilter(ALL); setStatusFilter(ALL); };
  const rolesPresent = [...new Set(all.map((r) => r.systemRole ?? "none"))].sort((x, y) => roleName(x === "none" ? null : x).localeCompare(roleName(y === "none" ? null : y)));

  return (
    <div className="space-y-3">
      <PageHeader
        title="Staff"
        lead="Everyone who works for the agency. A staff type is only a label; a person's role decides what they can do."
        action={canManage ? <Button type="button" onClick={() => { setPanel({ kind: "add" }); setDone(null); }}>Add staff</Button> : undefined}
      />
      {done ? <p role="status" className="rounded-md bg-emerald-50 px-3 py-1.5 text-sm text-emerald-900">{done}</p> : null}
      {canManage && all.length > 0 ? <BulkInvite rows={all} onDone={finish} /> : null}
      {panel?.kind === "add" ? <ProfileForm title="Add staff" types={activeTypes} onDone={finish} onCancel={() => setPanel(null)} /> : null}
      {all.length > 0 ? (
        <div role="search" aria-label="Find staff" className="flex flex-wrap items-end gap-2 border-b border-slate-200 pb-2">
          <label className="min-w-[12rem] flex-1 text-xs font-medium text-slate-700">Search
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, email or phone" className={`${filterClass} mt-0.5 block w-full`} autoComplete="off" />
          </label>
          <label className="text-xs font-medium text-slate-700">Staff type
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={`${filterClass} mt-0.5 block`}>
              <option value={ALL}>All types</option>
              {(types.data?.staffTypes ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              {all.some((r) => r.staffTypeId === null) ? <option value="none">No type</option> : null}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-700">Role
            <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className={`${filterClass} mt-0.5 block`}>
              <option value={ALL}>All roles</option>
              {rolesPresent.map((r) => <option key={r} value={r}>{roleName(r === "none" ? null : r)}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-700">Status
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={`${filterClass} mt-0.5 block`}>
              <option value={ALL}>All statuses</option>
              {STATUS_CHOICES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          {filtered ? <Button type="button" variant="secondary" className="min-h-[36px]" onClick={clear}>Clear Filters</Button> : null}
        </div>
      ) : null}
      {staff.isLoading ? <p className="text-sm text-slate-500" role="status">Loading…</p> : null}
      {staff.isError ? <p role="alert" className="text-sm text-red-700">{message(staff.error, "The staff list could not be loaded.")}</p> : null}
      {staff.data && all.length === 0 ? <p className="text-sm text-slate-600">No staff yet.</p> : null}
      {all.length > 0 && rows.length === 0 ? <p className="text-sm text-slate-600" role="status">No staff match. <button type="button" className="underline" onClick={clear}>Clear Filters</button></p> : null}
      {rows.length > 0 ? (
        <div className="relative overflow-x-auto md:rounded-lg md:border md:border-slate-200 md:bg-og-card">
          {filtered ? <p className="px-1 pb-1 text-xs text-slate-600 md:px-3 md:pt-1" role="status">{rows.length} of {all.length}</p> : null}
          <table className="block w-full text-left text-sm md:table" aria-label="Staff">
            <thead className="hidden md:table-header-group">
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-600">
                <th scope="col" className="w-10 px-3 py-1.5 text-right font-semibold">No.</th>
                <th scope="col" className="px-3 py-1.5 font-semibold">Name</th>
                <th scope="col" className="px-3 py-1.5 font-semibold">Staff Type</th>
                <th scope="col" className="px-3 py-1.5 font-semibold">Role</th>
                <th scope="col" className="px-3 py-1.5 font-semibold">Status</th>
                <th scope="col" className="px-3 py-1.5 font-semibold">Email</th>
                <th scope="col" className="px-3 py-1.5 font-semibold">Phone</th>
                <th scope="col" className="px-3 py-1.5 font-semibold"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="block md:table-row-group">
              {rows.map((r, i) => {
                const open = panel && panel.kind !== "add" && panel.row.staffKey === r.staffKey ? panel : null;
                return (
                  <RowWithPanel key={r.staffKey} index={i + 1} row={r} open={open} canManage={canManage} canAccounts={canAccounts} types={activeTypes} onOpen={(kind) => { setPanel({ kind, row: r }); setDone(null); }}
                    onClose={() => setPanel(null)} onDone={finish} />
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

type PanelKind = "edit" | "invite" | "role" | "access" | "history" | "member";
// Cells are table cells from 768px up and labelled lines on a phone (the label comes from data-label).
const cell = "block px-3 py-0.5 md:table-cell md:py-1 before:mr-2 before:text-xs before:text-slate-500 before:content-[attr(data-label)] md:before:hidden";

function RowWithPanel({ index, row, open, canManage, canAccounts, types, onOpen, onClose, onDone }: {
  index: number; row: StaffRow; open: Exclude<Panel, { kind: "add" }> | null; canManage: boolean; canAccounts: boolean; types: StaffType[];
  onOpen: (kind: PanelKind) => void; onClose: () => void; onDone: (text: string) => Promise<void>;
}) {
  const isProfile = row.profileId !== null, isMember = row.staffKey.startsWith("member:"), isCaregiver = row.caregiverRecordId !== null;
  const changeableRole = !row.isSelf && row.systemRole !== null && (ASSIGNABLE_ROLES as readonly string[]).includes(row.systemRole);
  const hasAccount = row.accessStatus === "active" || row.accessStatus === "invitation_pending" || row.accessStatus === "disabled";
  const btn = (label: string, kind: PanelKind, shown = label) => (
    <Button type="button" variant="secondary" className="min-h-[36px] px-2 py-1 text-xs" aria-label={`${label}: ${row.displayName}`} onClick={() => onOpen(kind)}>{shown}</Button>
  );
  const status = statusOf(row);
  const more = [
    canManage && isMember && types.length > 0 ? btn("Add profile", "member") : null,
    canManage && changeableRole ? btn("Change role", "role") : null,
    isProfile ? btn("History", "history") : null,
  ].filter(Boolean);
  return (
    <>
      <tr className="block border-b border-slate-100 py-1.5 last:border-0 md:table-row md:py-0 md:align-top">
        <td className="hidden w-10 px-3 py-1 text-right tabular-nums text-slate-600 md:table-cell" data-testid="row-no">{index}</td>
        <th scope="row" className="block px-3 py-0.5 font-medium text-slate-950 md:table-cell md:py-1">
          {row.displayName}{row.isSelf ? <span className="ml-1 text-xs font-normal text-slate-600">· you</span> : null}
        </th>
        <td className={cell} data-label="Staff Type">{row.staffTypeName ?? <span className="text-slate-500">—</span>}</td>
        <td className={cell} data-label="Role">{roleName(row.systemRole)}</td>
        <td className={cell} data-label="Status"><span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${row.status === "inactive" ? "bg-slate-200 text-slate-800" : ACCESS_BADGE[row.accessStatus]}`}>{status}</span></td>
        <td className={`${cell} break-all`} data-label="Email">{row.contactEmail ?? <span className="text-slate-500">—</span>}</td>
        <td className={`${cell} whitespace-nowrap`} data-label="Phone">{row.phone ?? <span className="text-slate-500">—</span>}</td>
        <td className="block px-3 py-1 md:table-cell">
          <div className="flex flex-wrap items-center gap-1">
            {canManage && isProfile ? btn("Edit", "edit") : null}
            {canManage && isProfile && row.accessStatus === "none" && row.status === "active" ? btn("Invite", "invite") : null}
            {canManage && isProfile && row.accessStatus === "invitation_pending" ? btn("Resend invite", "invite", "Invite again") : null}
            {canAccounts && row.userId && !row.isSelf && hasAccount && !isCaregiver
              ? btn(row.accessStatus === "disabled" ? "Enable access" : "Disable access", "access", row.accessStatus === "disabled" ? "Enable" : "Disable") : null}
            {isCaregiver ? <Link className="inline-flex min-h-[36px] items-center text-xs font-medium text-og-link underline" to={`/care-team/${row.caregiverRecordId}`}>Open caregiver</Link> : null}
            {more.length > 0 ? (
              <details className="relative">
                <summary className="inline-flex min-h-[36px] cursor-pointer list-none items-center rounded-md border border-slate-300 bg-og-card px-2 text-xs font-medium" aria-label={`More actions: ${row.displayName}`}>More</summary>
                <div className="absolute right-0 z-20 mt-1 flex min-w-[9rem] flex-col gap-1 rounded-lg border border-og-line bg-og-card p-1.5 shadow-md">{more}</div>
              </details>
            ) : null}
          </div>
        </td>
      </tr>
      {open ? (
        <tr className="block border-b border-slate-100 bg-og-page md:table-row">
          <td colSpan={8} className="block px-3 py-2 md:table-cell">
            {open.kind === "edit" ? <ProfileForm title="Edit staff" row={row} types={types} onDone={onDone} onCancel={onClose} /> : null}
            {open.kind === "member" ? <MemberForm row={row} types={types} onDone={onDone} onCancel={onClose} /> : null}
            {open.kind === "invite" ? <InviteForm row={row} onDone={onDone} onCancel={onClose} /> : null}
            {open.kind === "role" ? <RoleForm row={row} onDone={onDone} onCancel={onClose} /> : null}
            {open.kind === "access" ? <AccessForm row={row} onDone={onDone} onCancel={onClose} /> : null}
            {open.kind === "history" ? <History row={row} onClose={onClose} /> : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function FormActions({ pending, label, onCancel, disabled }: { pending: boolean; label: string; onCancel: () => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={pending || disabled}>{pending ? "Saving…" : label}</Button>
      <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
    </div>
  );
}

function ProfileForm({ title, row, types, onDone, onCancel }: { title: string; row?: StaffRow; types: StaffType[]; onDone: (t: string) => Promise<void>; onCancel: () => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const [name, setName] = useState(row?.displayName ?? "");
  const [typeId, setTypeId] = useState(row?.staffTypeId ?? types[0]?.id ?? "");
  const [email, setEmail] = useState(row?.contactEmail ?? "");
  const [phone, setPhone] = useState(row?.phone ?? "");
  const [status, setStatus] = useState<"active" | "inactive">(row?.status ?? "active");
  // The current type stays selectable even if it was deactivated since; new choices are the active types only.
  const choices = row?.staffTypeId && !types.some((t) => t.id === row.staffTypeId) ? [{ id: row.staffTypeId, name: row.staffTypeName ?? "Current type", isActive: false, sortOrder: 0, staffCount: 0 }, ...types] : types;
  const save = useMutation({
    mutationFn: () => {
      const body = { organizationId: activeOrganizationId, displayName: name.trim(), staffTypeId: typeId, contactEmail: email.trim() || null, phone: phone.trim() || null };
      return row?.profileId ? api.post(`/v1/staff/${row.profileId}`, { ...body, status }) : api.post("/v1/staff", body);
    },
    onSuccess: () => onDone(row ? "Staff updated." : "Staff added."),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };
  return (
    <form onSubmit={submit} className="space-y-2" aria-label={title}>
      <h2 className="text-base font-semibold text-slate-950">{title}</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-sm font-medium text-slate-800">Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required className={inputClass} autoComplete="off" /></label>
        <label className="block text-sm font-medium text-slate-800">Staff type
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)} required className={inputClass}>{choices.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        </label>
        <label className="block text-sm font-medium text-slate-800">Contact email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} className={inputClass} autoComplete="off" /></label>
        <label className="block text-sm font-medium text-slate-800">Phone<input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} className={inputClass} autoComplete="off" /></label>
        {row ? (
          <label className="block text-sm font-medium text-slate-800">Status
            <select value={status} onChange={(e) => setStatus(e.target.value as "active" | "inactive")} className={inputClass}><option value="active">Active</option><option value="inactive">Inactive</option></select>
          </label>
        ) : null}
        {row?.userId && status === "inactive" && row.status !== "inactive" ? (
          <p className="text-sm text-amber-900 sm:col-span-2">Setting this person inactive also stops their access to this organization. Making them active again does not give the access back; use Accounts &gt; Enable.</p>
        ) : null}
      </div>
      {save.isError ? <p role="alert" className="text-sm text-red-700">{message(save.error, "The change could not be saved.")}</p> : null}
      <FormActions pending={save.isPending} label={row ? "Save" : "Add staff"} onCancel={onCancel} disabled={!name.trim() || !typeId} />
    </form>
  );
}

function MemberForm({ row, types, onDone, onCancel }: { row: StaffRow; types: StaffType[]; onDone: (t: string) => Promise<void>; onCancel: () => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const [typeId, setTypeId] = useState(types[0]?.id ?? "");
  const save = useMutation({
    mutationFn: () => api.post(`/v1/staff-members/${row.userId}/profile`, { organizationId: activeOrganizationId, staffTypeId: typeId }),
    onSuccess: () => onDone("Profile added."),
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-2" aria-label="Add profile">
      <h2 className="text-base font-semibold text-slate-950">Add profile for {row.displayName}</h2>
      <label className="block text-sm font-medium text-slate-800">Staff type
        <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className={inputClass}>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
      </label>
      {save.isError ? <p role="alert" className="text-sm text-red-700">{message(save.error, "The profile could not be added.")}</p> : null}
      <FormActions pending={save.isPending} label="Add profile" onCancel={onCancel} disabled={!typeId} />
    </form>
  );
}

function InviteForm({ row, onDone, onCancel }: { row: StaffRow; onDone: (t: string) => Promise<void>; onCancel: () => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const resend = row.accessStatus === "invitation_pending";
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("staff");
  const send = useMutation({
    mutationFn: () => resend
      ? api.post(`/v1/staff/${row.profileId}/invitation/resend`, { organizationId: activeOrganizationId })
      : api.post(`/v1/staff/${row.profileId}/invitation`, { organizationId: activeOrganizationId, email: email.trim(), role }),
    onSuccess: () => onDone(resend ? "Invitation sent again." : "Invitation recorded. If this email already has an Ogevia sign-in, the person is asked to accept when they next sign in; until then they have no access."),
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); send.mutate(); }} className="space-y-2" aria-label={resend ? "Resend invitation" : "Invite to sign in"}>
      <h2 className="text-base font-semibold text-slate-950">{resend ? `Resend the invitation to ${row.displayName}` : `Invite ${row.displayName}`}</h2>
      {resend ? null : (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block text-sm font-medium text-slate-800">Sign-in email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} required className={inputClass} autoComplete="off" /></label>
          <label className="block text-sm font-medium text-slate-800">Role
            <select value={role} onChange={(e) => setRole(e.target.value)} className={inputClass}>{ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_NAME[r]}</option>)}</select>
          </label>
        </div>
      )}
      {send.isError ? <p role="alert" className="text-sm text-red-700">{message(send.error, "The invitation could not be sent.")}</p> : null}
      <FormActions pending={send.isPending} label={resend ? "Resend invitation" : "Send invitation"} onCancel={onCancel} disabled={!resend && !email.trim()} />
    </form>
  );
}

/**
 * R25: sign-in links are never sent by an import or by adding staff. This is the one explicit bulk action: the administrator picks the people, picks one role, and confirms.
 * It calls the same one-person invitation route for each person in turn, so every server rule still applies per person (a pending invitation is never overwritten, a role
 * limit is checked, the audit trail records each invitation). A failure for one person never stops or hides the others; people already sent are not sent again.
 */
const BULK_INVITE_MAX = 50;
function BulkInvite({ rows, onDone }: { rows: StaffRow[]; onDone: (text: string) => Promise<void> }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const waiting = rows.filter((r) => r.profileId !== null && r.accessStatus === "none" && r.status === "active");
  const eligible = waiting.filter((r) => !!r.contactEmail);
  const noEmail = waiting.length - eligible.length;
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [role, setRole] = useState<string>("staff");
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<{ key: string; name: string; error: string | null }[]>([]);
  if (eligible.length === 0 && results.length === 0) return null;
  const chosen = eligible.filter((r) => picked.has(r.staffKey));
  const toggle = (key: string) => setPicked((cur) => { const next = new Set(cur); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const send = async () => {
    setRunning(true);
    setResults([]);
    const out: { key: string; name: string; error: string | null }[] = [];
    for (const r of chosen.slice(0, BULK_INVITE_MAX)) {
      try {
        await api.post(`/v1/staff/${r.profileId}/invitation`, { organizationId: activeOrganizationId, email: r.contactEmail, role });
        out.push({ key: r.staffKey, name: r.displayName, error: null });
      } catch (cause) {
        out.push({ key: r.staffKey, name: r.displayName, error: message(cause, "Not sent.") });
      }
      setResults([...out]);
    }
    setPicked(new Set());
    setRunning(false);
    const sent = out.filter((x) => !x.error).length;
    await onDone(`Sign-in links: ${sent} sent${out.length - sent ? `, ${out.length - sent} not sent (see the list)` : ""}.`);
  };
  return (
    <section aria-label="Send sign-in links" className="rounded-md border border-slate-200 bg-og-card p-2">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="inline-flex min-h-[44px] items-center font-semibold text-og-accent underline md:min-h-[32px]">
        Send sign-in links{eligible.length ? ` (${eligible.length} can be invited)` : ""}
      </button>
      {open ? (
        <div className="mt-1 space-y-2">
          <p className="text-sm text-slate-700">Adding or importing staff never sends an invitation. Choose the people who should receive a sign-in link now.{noEmail ? ` ${noEmail} ${noEmail === 1 ? "person has" : "people have"} no email on file and cannot be invited from here.` : ""}</p>
          {eligible.length > 0 ? (
            <fieldset className="space-y-1" disabled={running}>
              <legend className="sr-only">People to invite</legend>
              <button type="button" className="min-h-[44px] text-sm font-medium underline md:min-h-[32px]" onClick={() => setPicked(picked.size === Math.min(eligible.length, BULK_INVITE_MAX) ? new Set() : new Set(eligible.slice(0, BULK_INVITE_MAX).map((r) => r.staffKey)))}>
                {picked.size > 0 ? "Clear selection" : `Select ${Math.min(eligible.length, BULK_INVITE_MAX)}`}
              </button>
              <ul className="divide-y divide-slate-200 rounded-md border border-slate-200">
                {eligible.map((r) => (
                  <li key={r.staffKey}>
                    <label className="flex min-h-[44px] items-center gap-2 px-2 text-sm">
                      <input type="checkbox" className="h-5 w-5" checked={picked.has(r.staffKey)} onChange={() => toggle(r.staffKey)} disabled={!picked.has(r.staffKey) && picked.size >= BULK_INVITE_MAX} />
                      <span className="font-medium">{r.displayName}</span>
                      <span className="truncate text-slate-600">{r.contactEmail}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <label className="block text-sm font-medium text-slate-800">Role for everyone selected
                <select value={role} onChange={(e) => setRole(e.target.value)} className={inputClass}>{ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_NAME[r]}</option>)}</select>
              </label>
              <Button type="button" loading={running} disabled={chosen.length === 0} onClick={() => void send()}>
                {chosen.length === 0 ? "Send sign-in links" : `Send ${chosen.length} sign-in ${chosen.length === 1 ? "link" : "links"}`}
              </Button>
            </fieldset>
          ) : null}
          {results.length > 0 ? (
            <ul aria-label="Results" role="status" className="space-y-0.5 text-sm">
              {results.map((x) => <li key={x.key} className={x.error ? "text-red-700" : "text-emerald-800"}>{x.name}: {x.error ?? "sent"}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function RoleForm({ row, onDone, onCancel }: { row: StaffRow; onDone: (t: string) => Promise<void>; onCancel: () => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const [role, setRole] = useState(row.systemRole ?? "staff");
  const [reason, setReason] = useState("");
  const save = useMutation({
    mutationFn: () => api.post(`/v1/staff-roles/${row.userId}`, { organizationId: activeOrganizationId, role, reason: reason.trim() }),
    onSuccess: () => onDone("Role changed."),
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-2" aria-label="Change role">
      <h2 className="text-base font-semibold text-slate-950">Change the role of {row.displayName}</h2>
      <label className="block text-sm font-medium text-slate-800">Role
        <select value={role} onChange={(e) => setRole(e.target.value)} className={inputClass}>{ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_NAME[r]}</option>)}</select>
      </label>
      <label className="block text-sm font-medium text-slate-800">Reason
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} className={inputClass} />
      </label>
      {save.isError ? <p role="alert" className="text-sm text-red-700">{message(save.error, "The role could not be changed.")}</p> : null}
      <FormActions pending={save.isPending} label="Change role" onCancel={onCancel} disabled={role === row.systemRole || reason.trim().length < 3} />
    </form>
  );
}

function AccessForm({ row, onDone, onCancel }: { row: StaffRow; onDone: (t: string) => Promise<void>; onCancel: () => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const enabling = row.accessStatus === "disabled";
  const [reason, setReason] = useState("");
  const save = useMutation({
    mutationFn: () => api.post(`/v1/accounts/${row.userId}/${enabling ? "enable" : "disable"}`, { organizationId: activeOrganizationId, reason: reason.trim() }),
    onSuccess: () => onDone(enabling ? "Access enabled." : "Access disabled. The person can no longer sign in."),
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-2" aria-label={enabling ? "Enable access" : "Disable access"}>
      <h2 className="text-base font-semibold text-slate-950">{enabling ? "Enable" : "Disable"} access for {row.displayName}</h2>
      <label className="block text-sm font-medium text-slate-800">Reason
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} className={inputClass} />
      </label>
      {save.isError ? <p role="alert" className="text-sm text-red-700">{message(save.error, "The change could not be made.")}</p> : null}
      <FormActions pending={save.isPending} label={enabling ? "Enable access" : "Disable access"} onCancel={onCancel} disabled={reason.trim().length < 3} />
    </form>
  );
}

function History({ row, onClose }: { row: StaffRow; onClose: () => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const events = useQuery({
    queryKey: ["aws-staff-audit", activeOrganizationId, row.profileId],
    queryFn: () => api.get<{ events: AuditEvent[] }>("/v1/staff-audit", { organizationId: activeOrganizationId, profileId: row.profileId }),
    enabled: !!activeOrganizationId && !!row.profileId,
  });
  return (
    <section aria-label={`History of ${row.displayName}`} className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-950">History of {row.displayName}</h2>
        <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
      </div>
      {events.isLoading ? <p className="text-sm text-slate-500" role="status">Loading…</p> : null}
      {events.isError ? <p role="alert" className="text-sm text-red-700">{message(events.error, "The history could not be loaded.")}</p> : null}
      {events.data && events.data.events.length === 0 ? <p className="text-sm text-slate-600">Nothing recorded yet.</p> : null}
      <ul className="max-h-60 space-y-1 overflow-y-auto text-sm" tabIndex={0} aria-label="Staff history">
        {(events.data?.events ?? []).map((e, i) => (
          <li key={`${e.occurredAt}-${i}`} className="flex flex-wrap gap-x-2 border-b border-slate-100 pb-1">
            <span className="tabular-nums text-slate-600">{new Date(e.occurredAt).toLocaleString()}</span>
            <span className="font-medium text-slate-900">{ACTION_LABEL[e.action] ?? e.action}</span>
            <span className="text-slate-700">by {e.actorName}</span>
            {e.reason ? <span className="text-slate-600">· {e.reason}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Settings > Staff Types
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
export function StaffTypesPage() {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const canRead = hasPermission("staff.read");
  const canManage = hasPermission("staff.manage");
  const types = useStaffTypes(canRead);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const refresh = async (text: string) => { setDone(text); await qc.invalidateQueries({ queryKey: typeKey(activeOrganizationId) }); };
  const add = useMutation({
    mutationFn: () => api.post("/v1/staff-types", { organizationId: activeOrganizationId, name: name.trim() }),
    onSuccess: async () => { setName(""); await refresh("Staff type added."); },
  });
  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => api.post(`/v1/staff-types/${v.id}/rename`, { organizationId: activeOrganizationId, name: v.name.trim() }),
    onSuccess: async () => { setEditing(null); await refresh("Staff type renamed."); },
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; active: boolean }) => api.post(`/v1/staff-types/${v.id}/active`, { organizationId: activeOrganizationId, active: v.active }),
    onSuccess: async (_r, v) => { await refresh(v.active ? "Staff type activated." : "Staff type deactivated."); },
  });
  if (!canRead) return <NotAllowed />;
  const list = types.data?.staffTypes ?? [];
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <PageHeader title="Staff Types" lead="Labels used for organizing staff. A staff type never gives access; the role does." />
      {done ? <p role="status" className="rounded-md bg-emerald-50 px-3 py-1.5 text-sm text-emerald-900">{done}</p> : null}
      {canManage ? (
        <form onSubmit={(e) => { e.preventDefault(); add.mutate(); }} className="flex flex-wrap items-end gap-2" aria-label="Add staff type">
          <label className="block min-w-[14rem] flex-1 text-sm font-medium text-slate-800">New staff type
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className={inputClass} autoComplete="off" />
          </label>
          <Button type="submit" disabled={add.isPending || !name.trim()}>{add.isPending ? "Adding…" : "Add"}</Button>
        </form>
      ) : null}
      {add.isError ? <p role="alert" className="text-sm text-red-700">{message(add.error, "The staff type could not be added.")}</p> : null}
      {rename.isError ? <p role="alert" className="text-sm text-red-700">{message(rename.error, "The staff type could not be renamed.")}</p> : null}
      {toggle.isError ? <p role="alert" className="text-sm text-red-700">{message(toggle.error, "The change could not be made.")}</p> : null}
      {types.isLoading ? <p className="text-sm text-slate-500" role="status">Loading…</p> : null}
      {types.isError ? <p role="alert" className="text-sm text-red-700">{message(types.error, "The staff types could not be loaded.")}</p> : null}
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-og-card" aria-label="Staff types">
        {list.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1">
            {editing?.id === t.id ? (
              <form onSubmit={(e) => { e.preventDefault(); rename.mutate(editing); }} className="flex flex-1 flex-wrap items-center gap-2" aria-label={`Rename ${t.name}`}>
                <input aria-label="Staff type name" value={editing.name} onChange={(e) => setEditing({ id: t.id, name: e.target.value })} maxLength={60} className={inputClass} />
                <Button type="submit" disabled={rename.isPending || !editing.name.trim()}>Save</Button>
                <Button type="button" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
              </form>
            ) : (
              <>
                <p className="min-w-0 break-words font-medium text-slate-950">
                  {t.name}
                  <span className="ml-2 text-xs font-normal text-slate-600">{Number(t.staffCount)} {Number(t.staffCount) === 1 ? "person" : "people"}</span>
                  {!t.isActive ? <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-800">Inactive</span> : null}
                </p>
                {canManage ? (
                  <div className="flex gap-1">
                    <Button type="button" variant="secondary" className="min-h-[36px] px-2 py-1 text-xs" aria-label={`Rename ${t.name}`} onClick={() => { setEditing({ id: t.id, name: t.name }); setDone(null); }}>Rename</Button>
                    <Button type="button" variant="secondary" className="min-h-[36px] px-2 py-1 text-xs" aria-label={`${t.isActive ? "Deactivate" : "Activate"} ${t.name}`} disabled={toggle.isPending}
                      onClick={() => { setDone(null); toggle.mutate({ id: t.id, active: !t.isActive }); }}>{t.isActive ? "Deactivate" : "Activate"}</Button>
                  </div>
                ) : null}
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Settings > Roles & Permissions (read only: the permissions of each role are set in the database and enforced there)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------
/** What each role is for, in a few words. A role with no permissions says so (taken from the data, not from this list). */
const ROLE_DESCRIPTION: Record<string, string> = {
  organization_owner: "Full system administration",
  organization_admin: "Manages care requests and coverage",
  manager: "Clients, caregivers, scheduling, visits and billing approval",
  scheduler: "Schedules shifts and assignments",
  coordinator: "Manages care requests and coverage",
  staff: "No permissions granted",
  read_only: "No permissions granted",
  caregiver: "Field staff: own availability and documents",
};
/** The area a permission belongs to (the part of its key before the dot), in plain words. Only used to group the rows. */
const AREA: Record<string, string> = {
  accounts: "Accounts", assignments: "Assignments", authorizations: "Authorizations", availability: "Availability", billing: "Billing", care_requests: "Care requests",
  caregiver_services: "Caregivers", caregivers: "Caregivers", clients: "Clients", continuity: "Continuity", documents: "Documents", experience: "Matching", matching: "Matching",
  organization: "Agency settings", readiness: "Readiness", reports: "Reports", services: "Services", shifts: "Scheduling", staff: "Staff", visits: "Visits",
};
const areaOf = (key: string) => AREA[key.split(".")[0] ?? ""] ?? "Other";

export function RolesPermissionsPage() {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const canRead = hasPermission("staff.read");
  const roles = useQuery({
    queryKey: ["aws-role-permissions", activeOrganizationId],
    queryFn: () => api.get<{ roles: RoleRow[] }>("/v1/role-permissions", { organizationId: activeOrganizationId }),
    enabled: !!activeOrganizationId && canRead,
  });
  if (!canRead) return <NotAllowed />;
  const list = roles.data?.roles ?? [];
  // Every permission any role has, grouped by area and sorted by its description; a role has it or it does not.
  const known = new Map<string, string>();
  for (const r of list) for (const p of r.permissions) known.set(p.key, p.description);
  const rows = [...known.entries()].map(([key, description]) => ({ key, description, area: areaOf(key) })).sort((x, y) => x.area.localeCompare(y.area) || x.description.localeCompare(y.description));
  return (
    <div className="space-y-3">
      <PageHeader title="Roles & Permissions" lead="Controls system access by role." />
      {roles.isLoading ? <p className="text-sm text-slate-500" role="status">Loading…</p> : null}
      {roles.isError ? <p role="alert" className="text-sm text-red-700">{message(roles.error, "The roles could not be loaded.")}</p> : null}
      {list.length > 0 ? (
        <>
          <div className="relative overflow-x-auto rounded-lg border border-slate-200 bg-og-card">
            <table className="w-full text-left text-sm" aria-label="Roles">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-600">
                  <th scope="col" className="px-3 py-1.5 font-semibold">Role</th>
                  <th scope="col" className="px-3 py-1.5 font-semibold">Description</th>
                  <th scope="col" className="px-3 py-1.5 text-right font-semibold">Users Assigned</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.role} className="border-b border-slate-100 last:border-0">
                    <th scope="row" className="whitespace-nowrap px-3 py-1 font-medium text-slate-950">{roleName(r.role)}</th>
                    <td className="px-3 py-1">{r.permissions.length === 0 ? "No permissions granted" : ROLE_DESCRIPTION[r.role] ?? ""}</td>
                    <td className="px-3 py-1 text-right tabular-nums">{Number(r.memberCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="relative overflow-x-auto rounded-lg border border-slate-200 bg-og-card">
            <p className="px-3 pt-1.5 text-xs text-slate-600"><span aria-hidden="true">✓</span> Granted · <span aria-hidden="true">–</span> Not granted</p>
            <table className="w-full text-left text-sm" aria-label="Permissions by role">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-600">
                  <th scope="col" className="sticky left-0 bg-og-card px-3 py-1.5 font-semibold">Permission</th>
                  {list.map((r) => <th key={r.role} scope="col" className="px-2 py-1.5 text-center font-semibold">{roleName(r.role)}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((p, i) => (
                  <Fragment key={p.key}>
                    {i === 0 || rows[i - 1]!.area !== p.area ? (
                      <tr className="bg-og-page"><th scope="colgroup" colSpan={list.length + 1} className="sticky left-0 px-3 py-1 text-xs font-bold uppercase tracking-wide text-slate-700">{p.area}</th></tr>
                    ) : null}
                    <tr className="border-b border-slate-100 last:border-0">
                      <th scope="row" className="sticky left-0 min-w-[14rem] bg-og-card px-3 py-1 text-left font-normal text-slate-900">{p.description}</th>
                      {list.map((r) => {
                        const granted = r.permissions.some((x) => x.key === p.key);
                        return (
                          <td key={r.role} className={`px-2 py-1 text-center ${granted ? "font-bold text-emerald-800" : "text-slate-400"}`}>
                            <span aria-hidden="true">{granted ? "✓" : "–"}</span><span className="sr-only">{granted ? "Granted" : "Not granted"}</span>
                          </td>
                        );
                      })}
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
