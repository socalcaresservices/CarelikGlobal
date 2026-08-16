import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Share2 } from "lucide-react";
import { Button, Card, EmptyState, FilterBar, type ActiveFilter } from "@carelik/ui";
import { systemRoleSchema, membershipStatusSchema } from "@carelik/shared";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { useOrgPath } from "@/lib/use-org-path";
import { supabase } from "@/lib/supabase";
import { inviteMember, type InvitableRole } from "@/lib/invitations";
import { useTableControls } from "@/lib/use-table-controls";
import { useFilters } from "@/lib/use-filters";
import { useColumnWidths } from "@/lib/use-column-widths";
import { SortableHeader } from "@/components/sortable-header";
import { PlainHeader } from "@/components/resizable-th";
import { getWeekEnd, getWeekStart } from "@/lib/week";

// Member roster, same source as AccessPage (list_organization_members) -
// but framed as "who's on the team" rather than "who can do what". The
// user asked for invite/edit-role/revoke to live here directly, same as
// Clients has its own add/edit/remove - so this duplicates that part of
// Access's mutation logic deliberately (Access stays the permissions-
// focused view; Team is the caregiver-focused one). Name links to the
// same /team/:id detail page Access already links to.
interface MemberRow {
  membership_id: string;
  user_id: string;
  display_name: string;
  role: string;
  status: "invited" | "active" | "suspended" | "revoked";
}

// A caregiver who exists as a workforce roster record but has not (yet)
// been granted login access - linked_user_id is still null. Once
// "Invite to Ogevia" links them to a real account, they show up in the
// members table below like any other caregiver instead of here.
interface CaregiverRecordRow {
  id: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
}

// Backed by get_caregiver_hours() (see
// supabase/migrations/20260719240000_caregiver_hour_targets.sql) - the
// same RPC the Schedule page's caregiver-hours widget uses. Merged in
// by user_id for the "This week" column; a row with no match (caller
// lacks shifts.read and it isn't their own row) just shows "-" rather
// than a fabricated number.
interface CaregiverHoursRow {
  caregiver_user_id: string;
  target_hours_per_week: number | null;
  scheduled_hours: number;
}

const invitableRoles = systemRoleSchema.options.filter(
  (role): role is InvitableRole => role !== "platform_owner"
);

// "Invite a team member" is for roles that need login access from the
// start (admins, coordinators, ...) - never caregiver. A new caregiver
// always starts as a caregiver_records roster row via "Add a caregiver"
// below (no login), then gets linked to a real account via "Invite to
// Ogevia" on that row - see access-page.tsx's identical split for the
// same reasoning.
const inviteRoleOptions = invitableRoles.filter((role) => role !== "caregiver");

const statusStyles: Record<MemberRow["status"], string> = {
  active: "bg-emerald-50 text-emerald-700",
  invited: "bg-amber-50 text-amber-700",
  suspended: "bg-slate-100 text-slate-600",
  revoked: "bg-red-50 text-red-700"
};

function formatRole(role: string) {
  return role.replace(/_/g, " ");
}

function formatHours(hours: number) {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

// Reuses the existing sign-in route, not a new permanent public token -
// anyone opening this link still has to authenticate as a real Ogevia
// account before seeing any assignment. The message is deliberately
// generic: no client name, code, or service ever goes in a share
// message, since email/SMS aren't a secure channel for that.
const STAFF_PORTAL_SHARE_MESSAGE =
  "You have access to the Ogevia staff portal. Open the secure link and sign in to view your assignments.";

function ShareStaffPortalCard() {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const portalLink = `${window.location.origin}/login`;
  const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  async function handleCopy() {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(`${STAFF_PORTAL_SHARE_MESSAGE}\n${portalLink}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError("Could not copy the link. Copy it manually instead.");
    }
  }

  async function handleNativeShare() {
    try {
      await navigator.share({ text: STAFF_PORTAL_SHARE_MESSAGE, url: portalLink });
    } catch {
      // User cancelled the share sheet, or the platform rejected it - not
      // an error worth surfacing.
    }
  }

  return (
    <Card>
      <div className="flex items-center gap-2">
        <Share2 className="h-4 w-4 text-slate-500" />
        <h3 className="font-semibold text-slate-950">Share staff portal</h3>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Send a caregiver the sign-in link. The message never includes client names, codes, or schedules - only
        someone who signs in with their own Ogevia account sees their assignments.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={handleCopy}>
          {copied ? "Copied" : "Copy link"}
        </Button>
        <a
          href={`mailto:?subject=${encodeURIComponent("Ogevia staff portal access")}&body=${encodeURIComponent(`${STAFF_PORTAL_SHARE_MESSAGE}\n${portalLink}`)}`}
          className="inline-flex items-center justify-center rounded-lg border border-slate-200 px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Email link
        </a>
        <a
          href={`sms:?body=${encodeURIComponent(`${STAFF_PORTAL_SHARE_MESSAGE} ${portalLink}`)}`}
          className="inline-flex items-center justify-center rounded-lg border border-slate-200 px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Text link
        </a>
        {canNativeShare ? (
          <Button type="button" variant="secondary" onClick={handleNativeShare}>
            Share…
          </Button>
        ) : null}
      </div>
      {copyError ? <p className="mt-2 text-sm text-red-700">{copyError}</p> : null}
    </Card>
  );
}

export function TeamPage() {
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const orgPath = useOrgPath();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const canRead = hasPermission("membership.read");
  const canInvite = hasPermission("membership.invite");
  const canManage = hasPermission("membership.update");

  const membersQuery = useQuery({
    queryKey: ["team-members", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_organization_members", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as MemberRow[];
    },
    enabled: !!activeOrganizationId && canRead
  });

  function refreshMembers() {
    void queryClient.invalidateQueries({ queryKey: ["team-members", activeOrganizationId] });
  }

  // Caregivers who exist as a roster record but have no login yet -
  // never shows anyone already in membersQuery above (that RPC only
  // returns real memberships). Once linked via "Invite to Ogevia", a row
  // disappears from here and appears there instead.
  const unlinkedCaregiversQuery = useQuery({
    queryKey: ["caregiver-records-unlinked", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("caregiver_records")
        .select("id, first_name, last_name, phone, email")
        .eq("organization_id", activeOrganizationId!)
        .is("linked_user_id", null)
        .is("deleted_at", null)
        .order("last_name");
      if (error) throw error;
      return (data ?? []) as CaregiverRecordRow[];
    },
    enabled: !!activeOrganizationId && canManage
  });

  function refreshCaregiverRecords() {
    void queryClient.invalidateQueries({ queryKey: ["caregiver-records-unlinked", activeOrganizationId] });
  }

  const weekStart = getWeekStart(new Date());
  const weekEnd = getWeekEnd(weekStart);

  const hoursQuery = useQuery({
    queryKey: ["team-hours", activeOrganizationId, weekStart.toISOString()],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_caregiver_hours", {
        target_organization_id: activeOrganizationId!,
        week_start: weekStart.toISOString(),
        week_end: weekEnd.toISOString()
      });
      if (error) throw error;
      return (data ?? []) as CaregiverHoursRow[];
    },
    enabled: !!activeOrganizationId && canRead
  });

  const hoursByUserId = new Map(
    (hoursQuery.data ?? []).map((row) => [row.caregiver_user_id, row] as const)
  );

  const filters = useFilters<MemberRow>(membersQuery.data, {
    role: (row, value) => row.role === value,
    status: (row, value) => row.status === value
  });

  const table = useTableControls<MemberRow, "name" | "role" | "status">(filters.rows, {
    matchesSearch: (row, query) => row.display_name.toLowerCase().includes(query),
    sorters: {
      name: (a, b) => a.display_name.localeCompare(b.display_name),
      role: (a, b) => a.role.localeCompare(b.role),
      status: (a, b) => a.status.localeCompare(b.status)
    }
  });

  const teamActiveFilters: ActiveFilter[] = [
    filters.values.role
      ? { key: "role", label: `Role: ${formatRole(filters.values.role)}`, onRemove: () => filters.setFilter("role", "") }
      : null,
    filters.values.status
      ? { key: "status", label: `Status: ${filters.values.status}`, onRemove: () => filters.setFilter("status", "") }
      : null
  ].filter((entry): entry is ActiveFilter => entry !== null);

  const columns = useColumnWidths("carelik:column-widths:team", {
    name: 220,
    role: 150,
    hours: 150,
    status: 130,
    actions: 90
  });

  function downloadTeamAsCSV() {
    if (!table.rows.length) return;
    const orgName = activeOrganization?.displayName ?? "team";
    const timestamp = new Date().toISOString().split("T")[0];
    const filename = `${orgName}-team-${timestamp}.csv`;

    const rows = table.rows.map((member) => {
      const hours = hoursByUserId.get(member.user_id);
      return [
        member.display_name,
        formatRole(member.role),
        hours ? formatHours(hours.scheduled_hours) : "—",
        hours?.target_hours_per_week ? formatHours(hours.target_hours_per_week) : "—",
        member.status
      ];
    });

    const csvContent = [
      ["Name", "Role", "Scheduled Hours", "Target Hours", "Status"],
      ...rows
    ]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // "Add a caregiver": a plain insert into caregiver_records, gated on
  // membership.update, never membership.invite - this is a workforce
  // roster record, not an account. See invite-member/index.ts's own
  // comment for why that distinction matters (this used to go through
  // that edge function and require membership.invite just to add a
  // roster row - the exact "You do not have permission to invite
  // members" bug for anyone who only had membership.update).
  const [caregiverFirstName, setCaregiverFirstName] = useState("");
  const [caregiverLastName, setCaregiverLastName] = useState("");
  const [caregiverPhone, setCaregiverPhone] = useState("");
  const [caregiverEmail, setCaregiverEmail] = useState("");
  const [addingCaregiver, setAddingCaregiver] = useState(false);
  const [caregiverFormError, setCaregiverFormError] = useState<string | null>(null);
  const [caregiverFormSuccess, setCaregiverFormSuccess] = useState<string | null>(null);

  // The "Add a caregiver" form already sits on this page (see the Card
  // just below), always rendered rather than behind a toggle - so the
  // empty state's call to action doesn't need its own modal or route, it
  // just needs to get the user's eyes and cursor there.
  function focusInviteForm() {
    document.getElementById("team-invite-first-name")?.focus();
  }

  async function handleAddCaregiverRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeOrganizationId) return;

    setAddingCaregiver(true);
    setCaregiverFormError(null);
    setCaregiverFormSuccess(null);
    try {
      const { error } = await supabase.from("caregiver_records").insert({
        organization_id: activeOrganizationId,
        first_name: caregiverFirstName,
        last_name: caregiverLastName,
        phone: caregiverPhone || null,
        email: caregiverEmail || null
      });
      if (error) throw error;
      setCaregiverFormSuccess(`Added ${caregiverFirstName} ${caregiverLastName} to the roster.`);
      setCaregiverFirstName("");
      setCaregiverLastName("");
      setCaregiverPhone("");
      setCaregiverEmail("");
      refreshCaregiverRecords();
    } catch (cause) {
      setCaregiverFormError(cause instanceof Error ? cause.message : "Could not add caregiver. Try again.");
    } finally {
      setAddingCaregiver(false);
    }
  }

  const [caregiverRecordPendingId, setCaregiverRecordPendingId] = useState<string | null>(null);
  const [caregiverRecordActionError, setCaregiverRecordActionError] = useState<string | null>(null);

  // Sends the real sign-in invitation and links it back to this roster
  // row (caregiverRecordId) instead of creating a second, disconnected
  // caregiver - see invite-member/index.ts.
  async function handleInviteCaregiverRecord(row: CaregiverRecordRow) {
    if (!activeOrganizationId) return;
    if (!row.email) {
      setCaregiverRecordActionError(`Add an email for ${row.first_name} ${row.last_name} before inviting them.`);
      return;
    }
    setCaregiverRecordActionError(null);
    setCaregiverRecordPendingId(row.id);
    try {
      await inviteMember({
        email: row.email,
        organizationId: activeOrganizationId,
        role: "caregiver",
        caregiverRecordId: row.id
      });
      refreshCaregiverRecords();
      refreshMembers();
    } catch (cause) {
      setCaregiverRecordActionError(cause instanceof Error ? cause.message : "Could not send the invite.");
    } finally {
      setCaregiverRecordPendingId(null);
    }
  }

  async function handleRemoveCaregiverRecord(row: CaregiverRecordRow) {
    setCaregiverRecordActionError(null);
    setCaregiverRecordPendingId(row.id);
    try {
      const { error } = await supabase
        .from("caregiver_records")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", row.id);
      if (error) throw error;
      refreshCaregiverRecords();
    } catch (cause) {
      setCaregiverRecordActionError(cause instanceof Error ? cause.message : "Could not remove this caregiver.");
    } finally {
      setCaregiverRecordPendingId(null);
    }
  }

  // "Invite a team member": office/admin roles that need login access
  // immediately - never caregiver, see inviteRoleOptions above.
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InvitableRole>(inviteRoleOptions[0]!);
  const [inviting, setInviting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeOrganizationId) return;

    setInviting(true);
    setFormError(null);
    setFormSuccess(null);
    try {
      await inviteMember({
        email: inviteEmail,
        organizationId: activeOrganizationId,
        role: inviteRole
      });
      setFormSuccess(`Invited ${inviteEmail}.`);
      setInviteEmail("");
      refreshMembers();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not send the invite. Try again.");
    } finally {
      setInviting(false);
    }
  }

  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [pendingMembershipId, setPendingMembershipId] = useState<string | null>(null);

  // Auto-clear success messages after 3 seconds
  useEffect(() => {
    if (actionSuccess) {
      const timeout = setTimeout(() => setActionSuccess(null), 3000);
      return () => clearTimeout(timeout);
    }
  }, [actionSuccess]);

  async function handleRoleChange(membershipId: string, nextRole: string) {
    setActionError(null);
    setActionSuccess(null);
    setPendingMembershipId(membershipId);
    try {
      const { error } = await supabase
        .from("organization_memberships")
        .update({ role: nextRole })
        .eq("id", membershipId);
      if (error) throw error;
      setActionSuccess(`Role updated to ${formatRole(nextRole)}.`);
      refreshMembers();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not update role.");
    } finally {
      setPendingMembershipId(null);
    }
  }

  async function handleRevoke(membershipId: string) {
    setActionError(null);
    setActionSuccess(null);
    setPendingMembershipId(membershipId);
    try {
      const { error } = await supabase
        .from("organization_memberships")
        .update({ status: "revoked" })
        .eq("id", membershipId);
      if (error) throw error;
      setActionSuccess("Access revoked.");
      refreshMembers();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not revoke access.");
    } finally {
      setPendingMembershipId(null);
    }
  }

  if (!canRead) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Team</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h2>
          <p className="mt-3 text-slate-600">
            You don&apos;t have permission to view the team roster for this organization.
          </p>
        </Card>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Team</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-950">
          {activeOrganization?.displayName ?? "Caregivers"}
        </h2>
      </div>

      {canInvite ? <ShareStaffPortalCard /> : null}

      {canManage ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Add a caregiver</h3>
          <p className="mt-1 text-sm text-slate-500">
            Type in their info and they&apos;ll show up in the roster right away — no sign-in required. Invite them
            to Ogevia later, whenever they're ready to log in themselves.
          </p>
          <form onSubmit={handleAddCaregiverRecord} className="mt-4 flex flex-wrap items-end gap-3">
            <div className="min-w-[160px]">
              <label htmlFor="team-invite-first-name" className="block text-xs font-medium text-slate-600">
                First name
              </label>
              <input
                id="team-invite-first-name"
                type="text"
                required
                value={caregiverFirstName}
                onChange={(event) => setCaregiverFirstName(event.target.value)}
                placeholder="Sam"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div className="min-w-[160px]">
              <label htmlFor="team-invite-last-name" className="block text-xs font-medium text-slate-600">
                Last name
              </label>
              <input
                id="team-invite-last-name"
                type="text"
                required
                value={caregiverLastName}
                onChange={(event) => setCaregiverLastName(event.target.value)}
                placeholder="Caregiver"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div className="min-w-[160px]">
              <label htmlFor="team-invite-phone" className="block text-xs font-medium text-slate-600">
                Phone
              </label>
              <input
                id="team-invite-phone"
                type="tel"
                value={caregiverPhone}
                onChange={(event) => setCaregiverPhone(event.target.value)}
                placeholder="(555) 555-0100"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div className="min-w-[220px] flex-1">
              <label htmlFor="team-invite-email" className="block text-xs font-medium text-slate-600">
                Email <span className="font-normal text-slate-400">(needed to invite them later)</span>
              </label>
              <input
                id="team-invite-email"
                type="email"
                value={caregiverEmail}
                onChange={(event) => setCaregiverEmail(event.target.value)}
                placeholder="name@example.com"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <Button type="submit" loading={addingCaregiver}>
              {addingCaregiver ? "Adding…" : "Add caregiver"}
            </Button>
          </form>
          {caregiverFormError ? <p className="mt-3 text-sm text-red-700">{caregiverFormError}</p> : null}
          {caregiverFormSuccess ? <p className="mt-3 text-sm text-emerald-700">{caregiverFormSuccess}</p> : null}
        </Card>
      ) : null}

      {canManage && (unlinkedCaregiversQuery.data ?? []).length > 0 ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Caregivers without login yet</h3>
          <p className="mt-1 text-sm text-slate-500">
            On the roster, not yet invited - they can't sign in or be scheduled until you invite them.
          </p>
          {caregiverRecordActionError ? <p className="mt-2 text-sm text-red-700">{caregiverRecordActionError}</p> : null}
          <ul className="mt-3 divide-y divide-slate-100">
            {(unlinkedCaregiversQuery.data ?? []).map((row) => {
              const isPending = caregiverRecordPendingId === row.id;
              return (
                <li key={row.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div>
                    <span className="font-medium text-slate-900">
                      {row.first_name} {row.last_name}
                    </span>
                    <span className="ml-2 text-slate-500">{row.email ?? row.phone ?? "No contact info"}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => handleInviteCaregiverRecord(row)}
                      className="text-xs font-medium text-slate-700 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Invite to Ogevia
                    </button>
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => handleRemoveCaregiverRecord(row)}
                      className="text-xs font-medium text-red-700 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {canInvite ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Invite a team member</h3>
          <p className="mt-1 text-sm text-slate-500">
            For office/admin roles who need to sign in and use the app right away.
          </p>
          <form onSubmit={handleInvite} className="mt-4 flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <label htmlFor="team-office-invite-email" className="block text-xs font-medium text-slate-600">
                Email
              </label>
              <input
                id="team-office-invite-email"
                type="email"
                required
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                placeholder="name@example.com"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div>
              <label htmlFor="team-office-invite-role" className="block text-xs font-medium text-slate-600">
                Role
              </label>
              <select
                id="team-office-invite-role"
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as InvitableRole)}
                className="mt-1 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              >
                {inviteRoleOptions.map((option) => (
                  <option key={option} value={option}>
                    {formatRole(option)}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" loading={inviting}>
              {inviting ? "Sending…" : "Send invite"}
            </Button>
          </form>
          {formError ? <p className="mt-3 text-sm text-red-700">{formError}</p> : null}
          {formSuccess ? <p className="mt-3 text-sm text-emerald-700">{formSuccess}</p> : null}
        </Card>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold text-slate-950">All caregivers</h3>
          <div className="flex flex-wrap items-center gap-2">
            {table.rows.length > 0 && (
              <button
                type="button"
                onClick={downloadTeamAsCSV}
                className="text-xs font-medium text-slate-600 hover:text-slate-900"
              >
                Download as CSV
              </button>
            )}
              <FilterBar
                activeFilters={teamActiveFilters}
                onClearAll={teamActiveFilters.length > 0 ? filters.clearAll : undefined}
                className="w-full sm:w-auto"
              >
                <input
                  type="search"
                  value={table.search}
                  onChange={(event) => table.setSearch(event.target.value)}
                  placeholder="Search by name"
                  aria-label="Search team"
                  className="w-full max-w-xs rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
                />
                <div>
                  <label htmlFor="team-role-filter" className="sr-only">
                    Filter by role
                  </label>
                  <select
                    id="team-role-filter"
                    value={filters.values.role ?? ""}
                    onChange={(event) => filters.setFilter("role", event.target.value)}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
                  >
                    <option value="">All roles</option>
                    {invitableRoles.map((option) => (
                      <option key={option} value={option}>
                        {formatRole(option)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="team-status-filter" className="sr-only">
                    Filter by status
                  </label>
                  <select
                    id="team-status-filter"
                    value={filters.values.status ?? ""}
                    onChange={(event) => filters.setFilter("status", event.target.value)}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
                  >
                    <option value="">All statuses</option>
                    {membershipStatusSchema.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
              </FilterBar>
            </div>
          </div>
        {actionError ? <p className="mt-2 text-sm text-red-700">{actionError}</p> : null}
        {actionSuccess ? <p className="mt-2 text-sm text-emerald-700">{actionSuccess}</p> : null}
        {membersQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : membersQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">Could not load the team roster.</p>
        ) : (
          <div className="overflow-x-auto">
          <table className="mt-4 w-full table-fixed text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                <SortableHeader
                  label="Name"
                  active={table.sortKey === "name"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("name")}
                  width={columns.widths.name}
                  onResizeStart={columns.startResize("name")}
                />
                <SortableHeader
                  label="Role"
                  active={table.sortKey === "role"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("role")}
                  width={columns.widths.role}
                  onResizeStart={columns.startResize("role")}
                />
                <PlainHeader
                  label="This week"
                  width={columns.widths.hours}
                  onResizeStart={columns.startResize("hours")}
                />
                <SortableHeader
                  label="Status"
                  active={table.sortKey === "status"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("status")}
                  width={columns.widths.status}
                  onResizeStart={columns.startResize("status")}
                />
                {canManage ? (
                  <PlainHeader label="" width={columns.widths.actions} onResizeStart={columns.startResize("actions")} />
                ) : null}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((member) => {
                const hours = hoursByUserId.get(member.user_id);
                const isSelf = member.user_id === user?.id;
                const isPending = pendingMembershipId === member.membership_id;
                const canModifyRow = canManage && !isSelf && member.status !== "revoked";
                return (
                  <tr key={member.membership_id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2.5 text-slate-800">
                      <Link to={orgPath(`/team/${member.user_id}`)} className="hover:underline">
                        {member.display_name}
                      </Link>
                      {isSelf ? <span className="ml-1 text-xs text-slate-400">(you)</span> : null}
                    </td>
                    <td className="py-2.5 text-slate-600">
                      {canModifyRow ? (
                        <select
                          aria-label={`Change role for ${member.display_name}`}
                          value={member.role}
                          disabled={isPending}
                          onChange={(event) => handleRoleChange(member.membership_id, event.target.value)}
                          className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-900"
                        >
                          {invitableRoles.map((option) => (
                            <option key={option} value={option}>
                              {formatRole(option)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        formatRole(member.role)
                      )}
                    </td>
                    <td className="py-2.5 text-slate-600">
                      {hours
                        ? `${formatHours(hours.scheduled_hours)}h${
                            hours.target_hours_per_week !== null
                              ? ` / ${formatHours(hours.target_hours_per_week)}h`
                              : ""
                          }`
                        : "—"}
                    </td>
                    <td className="py-2.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[member.status]}`}
                      >
                        {member.status}
                      </span>
                    </td>
                    {canManage ? (
                      <td className="py-2.5 text-right">
                        {canModifyRow ? (
                          <button
                            type="button"
                            disabled={isPending}
                            onClick={() => handleRevoke(member.membership_id)}
                            className="text-xs font-medium text-red-700 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Revoke
                          </button>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
              {table.rows.length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 5 : 4}>
                    {table.search || teamActiveFilters.length > 0 ? (
                      <EmptyState message="No caregivers match your search or filters." />
                    ) : (
                      <EmptyState
                        message="You're ready to build your workforce. Add your first caregiver above and they'll show up here."
                        action={
                          canManage ? (
                            <Button variant="secondary" size="sm" onClick={focusInviteForm}>
                              Add your first caregiver
                            </Button>
                          ) : undefined
                        }
                      />
                    )}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          </div>
        )}
      </Card>
    </section>
  );
}
