import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Card, FilterBar, type ActiveFilter } from "@carelik/ui";
import { systemRoleSchema, membershipStatusSchema } from "@carelik/shared";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { inviteMember, type InvitableRole } from "@/lib/invitations";
import { useTableControls } from "@/lib/use-table-controls";
import { useFilters } from "@/lib/use-filters";
import { useColumnWidths } from "@/lib/use-column-widths";
import { SortableHeader } from "@/components/sortable-header";

interface MemberRow {
  membership_id: string;
  user_id: string;
  display_name: string;
  role: string;
  status: "invited" | "active" | "suspended" | "revoked";
  invited_by: string | null;
  joined_at: string | null;
  created_at: string;
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

export function AccessPage() {
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const canRead = hasPermission("membership.read");
  const canInvite = hasPermission("membership.invite");
  const canManage = hasPermission("membership.update");

  const membersQuery = useQuery({
    queryKey: ["organization-members", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_organization_members", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as MemberRow[];
    },
    enabled: !!activeOrganizationId && canRead
  });

  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingMembershipId, setPendingMembershipId] = useState<string | null>(null);

  function refreshMembers() {
    void queryClient.invalidateQueries({
      queryKey: ["organization-members", activeOrganizationId]
    });
  }

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

  const accessActiveFilters: ActiveFilter[] = [
    filters.values.role
      ? { key: "role", label: `Role: ${formatRole(filters.values.role)}`, onRemove: () => filters.setFilter("role", "") }
      : null,
    filters.values.status
      ? { key: "status", label: `Status: ${filters.values.status}`, onRemove: () => filters.setFilter("status", "") }
      : null
  ].filter((entry): entry is ActiveFilter => entry !== null);

  const columns = useColumnWidths("carelik:column-widths:access", {
    name: 220,
    role: 160,
    status: 130
  });

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

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitableRole>("staff");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeOrganizationId) return;

    setSubmitting(true);
    setFormError(null);
    setFormSuccess(null);
    try {
      await inviteMember({ email, organizationId: activeOrganizationId, role });
      setFormSuccess(`Invited ${email}.`);
      setEmail("");
      void queryClient.invalidateQueries({
        queryKey: ["organization-members", activeOrganizationId]
      });
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Invite failed. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!canRead) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Access control</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h2>
          <p className="mt-3 text-slate-600">
            You don&apos;t have permission to view membership for this organization.
          </p>
        </Card>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Access control</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-950">
          {activeOrganization?.displayName ?? "Members"}
        </h2>
      </div>

      {canInvite ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Invite a member</h3>
          <form onSubmit={handleInvite} className="mt-4 flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <label htmlFor="invite-email" className="block text-xs font-medium text-slate-600">
                Email
              </label>
              <input
                id="invite-email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div>
              <label htmlFor="invite-role" className="block text-xs font-medium text-slate-600">
                Role
              </label>
              <select
                id="invite-role"
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
              disabled={submitting}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? "Sending…" : "Send invite"}
            </button>
          </form>
          {formError ? <p className="mt-3 text-sm text-red-700">{formError}</p> : null}
          {formSuccess ? <p className="mt-3 text-sm text-emerald-700">{formSuccess}</p> : null}
        </Card>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold text-slate-950">Members</h3>
          <FilterBar
            activeFilters={accessActiveFilters}
            onClearAll={accessActiveFilters.length > 0 ? filters.clearAll : undefined}
            className="w-full sm:w-auto"
          >
            <input
              type="search"
              value={table.search}
              onChange={(event) => table.setSearch(event.target.value)}
              placeholder="Search by name"
              aria-label="Search members"
              className="w-full max-w-xs rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
            />
            <div>
              <label htmlFor="access-role-filter" className="sr-only">
                Filter by role
              </label>
              <select
                id="access-role-filter"
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
              <label htmlFor="access-status-filter" className="sr-only">
                Filter by status
              </label>
              <select
                id="access-status-filter"
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
        {actionError ? <p className="mt-2 text-sm text-red-700">{actionError}</p> : null}
        {membersQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : membersQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">Could not load members.</p>
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
                <SortableHeader
                  label="Status"
                  active={table.sortKey === "status"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("status")}
                  width={columns.widths.status}
                  onResizeStart={columns.startResize("status")}
                />
                {canManage ? <th className="pb-2 font-medium" /> : null}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((member) => {
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
                  <td colSpan={canManage ? 4 : 3} className="py-4 text-center text-slate-400">
                    {table.search || accessActiveFilters.length > 0
                      ? "No members match your search or filters."
                      : "No members yet."}
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
