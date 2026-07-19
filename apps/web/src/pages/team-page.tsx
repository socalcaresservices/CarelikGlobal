import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Card } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { useTableControls } from "@/lib/use-table-controls";
import { useColumnWidths } from "@/lib/use-column-widths";
import { SortableHeader } from "@/components/sortable-header";
import { PlainHeader } from "@/components/resizable-th";
import { getWeekEnd, getWeekStart } from "@/lib/week";

// Member roster, same source as AccessPage (list_organization_members) -
// but framed as "who's on the team" rather than "who can do what", so it
// lives on its own page instead of being folded into Access, which is
// about roles/invites/permissions. Name links to the same /team/:id
// detail page Access already links to.
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

  const canRead = hasPermission("membership.read");

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
    status: 130
  });

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
              </tr>
            </thead>
            <tbody>
              {table.rows.map((member) => {
                const hours = hoursByUserId.get(member.user_id);
                return (
                  <tr key={member.membership_id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2.5 text-slate-800">
                      <Link to={`/team/${member.user_id}`} className="hover:underline">
                        {member.display_name}
                      </Link>
                    </td>
                    <td className="py-2.5 text-slate-600">{formatRole(member.role)}</td>
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
                  </tr>
                );
              })}
              {table.rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-slate-400">
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
