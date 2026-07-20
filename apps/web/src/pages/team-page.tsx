import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Card } from "@carelik/ui";
import { systemRoleSchema } from "@carelik/shared";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { inviteMember, type InvitableRole } from "@/lib/invitations";
import { useTableControls } from "@/lib/use-table-controls";
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

export function TeamPage() {
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
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

  const table = useTableControls<MemberRow, "name" | "role" | "status">(membersQuery.data, {
    matchesSearch: (row, query) => row.display_name.toLowerCase().includes(query),
    sorters: {
      name: (a, b) => a.display_name.localeCompare(b.display_name),
      role: (a, b) => a.role.localeCompare(b.role),
      status: (a, b) => a.status.localeCompare(b.status)
    }
  });

  const columns = useColumnWidths("carelik:column-widths:team", {
    name: 220,
    role: 150,
    hours: 150,
    status: 130,
    actions: 90
  });

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitableRole>("caregiver");
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
      const result = await inviteMember({
        email,
        organizationId: activeOrganizationId,
        role,
        firstName,
        lastName,
        phone: phone || undefined
      });
      setFormSuccess(
        result.status === "active"
          ? `Added ${firstName} ${lastName}.`
          : `Invited ${email}.`
      );
      setFirstName("");
      setLastName("");
      setPhone("");
      setEmail("");
      refreshMembers();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not add caregiver. Try again.");
    } finally {
      setInviting(false);
    }
  }

  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingMembershipId, setPendingMembershipId] = useState<string | null>(null);

  async function handleRoleChange(membershipId: string, nextRole: string) {
    setActionError(null);
    setPendingMembershipId(membershipId);
    try {
      const { error } = await supabase
        .from("organization_memberships")
        .update({ role: nextRole })
        .eq("id", membershipId);
      if (error) throw error;
      refreshMembers();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not update role.");
    } finally {
      setPendingMembershipId(null);
    }
  }

  async function handleRevoke(membershipId: string) {
    setActionError(null);
    setPendingMembershipId(membershipId);
    try {
      const { error } = await supabase
        .from("organization_memberships")
        .update({ status: "revoked" })
        .eq("id", membershipId);
      if (error) throw error;
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

      {canInvite ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Add a caregiver</h3>
          <p className="mt-1 text-sm text-slate-500">
            Type in their info and they&apos;ll show up in the roster right away — no sign-in required.
          </p>
          <form onSubmit={handleInvite} className="mt-4 flex flex-wrap items-end gap-3">
            <div className="min-w-[160px]">
              <label htmlFor="team-invite-first-name" className="block text-xs font-medium text-slate-600">
                First name
              </label>
              <input
                id="team-invite-first-name"
                type="text"
                required
                value={firstName}
                onChange={(event) => setFirstName(event.target.value)}
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
                value={lastName}
                onChange={(event) => setLastName(event.target.value)}
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
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="(555) 555-0100"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div className="min-w-[220px] flex-1">
              <label htmlFor="team-invite-email" className="block text-xs font-medium text-slate-600">
                Email
              </label>
              <input
                id="team-invite-email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div>
              <label htmlFor="team-invite-role" className="block text-xs font-medium text-slate-600">
                Role
              </label>
              <select
                id="team-invite-role"
                value={role}
                onChange={(event) => setRole(event.target.value as InvitableRole)}
                className="mt-1 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              >
                {invitableRoles.map((option) => (
                  <option key={option} value={option}>
                    {formatRole(option)}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={inviting}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {inviting ? "Adding…" : "Add caregiver"}
            </button>
          </form>
          {formError ? <p className="mt-3 text-sm text-red-700">{formError}</p> : null}
          {formSuccess ? <p className="mt-3 text-sm text-emerald-700">{formSuccess}</p> : null}
        </Card>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold text-slate-950">All caregivers</h3>
          <input
            type="search"
            value={table.search}
            onChange={(event) => table.setSearch(event.target.value)}
            placeholder="Search by name"
            aria-label="Search team"
            className="w-full max-w-xs rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
          />
        </div>
        {actionError ? <p className="mt-2 text-sm text-red-700">{actionError}</p> : null}
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
                      <Link to={`/team/${member.user_id}`} className="hover:underline">
                        {member.display_name}
                      </Link>
                      {isSelf ? <span className="ml-1 text-xs text-slate-400">(you)</span> : null}
                    </td>
                    <td className="py-2.5 text-slate-600">
                      {canModifyRow ? (
                        <select
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
                  <td colSpan={canManage ? 5 : 4} className="py-4 text-center text-slate-400">
                    {table.search ? "No caregivers match your search." : "No team members yet."}
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
