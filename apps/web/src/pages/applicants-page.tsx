import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Card, FilterBar, PageHeader, StatusBadge, type ActiveFilter, type StatusTone } from "@carelik/ui";
import { applicantStatusSchema, type ApplicantStatus } from "@carelik/shared";
import { useOrganization } from "@/providers/organization-provider";
import { useOrgPath } from "@/lib/use-org-path";
import { supabase } from "@/lib/supabase";
import { useTableControls } from "@/lib/use-table-controls";
import { useFilters } from "@/lib/use-filters";
import { useColumnWidths } from "@/lib/use-column-widths";
import { SortableHeader } from "@/components/sortable-header";
import { PlainHeader } from "@/components/resizable-th";

// Staff-facing review list. The public form that creates these rows
// lives at /apply/:orgSlug (apply-page.tsx) - no session required
// there. This page is the other half: reviewing, deciding, and (from
// the detail page) converting an applicant into a caregiver.

interface ApplicantRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  status: ApplicantStatus;
  desired_weekly_hours: number | null;
  created_at: string;
  reviewed_by_name: string | null;
  hired_caregiver_user_id: string | null;
}

const statusTone: Record<ApplicantStatus, StatusTone> = {
  new: "info",
  reviewing: "warning",
  hired: "success",
  rejected: "neutral",
  withdrawn: "neutral"
};

function formatHours(hours: number) {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

export function ApplicantsPage() {
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const orgPath = useOrgPath();

  const canRead = hasPermission("applicants.read");

  const applicantsQuery = useQuery({
    queryKey: ["applicants", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_applicants", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as ApplicantRow[];
    },
    enabled: !!activeOrganizationId && canRead
  });

  const filters = useFilters<ApplicantRow>(applicantsQuery.data, {
    status: (row, value) => row.status === value
  });

  const table = useTableControls<ApplicantRow, "name" | "status" | "applied">(filters.rows, {
    matchesSearch: (row, query) =>
      `${row.first_name} ${row.last_name}`.toLowerCase().includes(query) ||
      row.email.toLowerCase().includes(query) ||
      (row.phone ?? "").toLowerCase().includes(query),
    sorters: {
      name: (a, b) => `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`),
      status: (a, b) => a.status.localeCompare(b.status),
      applied: (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    }
  });

  const columns = useColumnWidths("carelik:column-widths:applicants", {
    name: 200,
    status: 120,
    hours: 140,
    applied: 140
  });

  const activeFilters: ActiveFilter[] = filters.values.status
    ? [
        {
          key: "status",
          label: `Status: ${filters.values.status}`,
          onRemove: () => filters.setFilter("status", "")
        }
      ]
    : [];

  if (!canRead) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Applicants</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h2>
          <p className="mt-3 text-slate-600">
            You don&apos;t have permission to view job applicants for this organization.
          </p>
        </Card>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        eyebrow="Applicants"
        title={activeOrganization?.displayName ?? "Job applicants"}
        description="Reviewed here, converted to a caregiver profile without re-entering anything they already told you."
      />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold text-slate-950">All applicants</h3>
          <FilterBar
            activeFilters={activeFilters}
            onClearAll={activeFilters.length > 0 ? filters.clearAll : undefined}
            className="w-full sm:w-auto"
          >
            <input
              type="search"
              value={table.search}
              onChange={(event) => table.setSearch(event.target.value)}
              placeholder="Search name, email, or phone"
              aria-label="Search applicants"
              className="w-full max-w-xs rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
            />
            <div>
              <label htmlFor="applicant-status-filter" className="sr-only">
                Filter by status
              </label>
              <select
                id="applicant-status-filter"
                value={filters.values.status ?? ""}
                onChange={(event) => filters.setFilter("status", event.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
              >
                <option value="">All statuses</option>
                {applicantStatusSchema.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
          </FilterBar>
        </div>
        {applicantsQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : applicantsQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">Could not load applicants.</p>
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
                    label="Status"
                    active={table.sortKey === "status"}
                    direction={table.direction}
                    onClick={() => table.toggleSort("status")}
                    width={columns.widths.status}
                    onResizeStart={columns.startResize("status")}
                  />
                  <PlainHeader
                    label="Desired hours"
                    width={columns.widths.hours}
                    onResizeStart={columns.startResize("hours")}
                  />
                  <SortableHeader
                    label="Applied"
                    active={table.sortKey === "applied"}
                    direction={table.direction}
                    onClick={() => table.toggleSort("applied")}
                    width={columns.widths.applied}
                    onResizeStart={columns.startResize("applied")}
                  />
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row) => (
                  <tr key={row.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2.5 text-slate-800">
                      <Link to={orgPath(`/applicants/${row.id}`)} className="hover:underline">
                        {row.first_name} {row.last_name}
                      </Link>
                    </td>
                    <td className="py-2.5">
                      <StatusBadge label={row.status} tone={statusTone[row.status]} />
                    </td>
                    <td className="py-2.5 text-slate-600">
                      {row.desired_weekly_hours != null ? `${formatHours(row.desired_weekly_hours)}h/week` : "—"}
                    </td>
                    <td className="py-2.5 text-slate-500">{new Date(row.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
                {table.rows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-4 text-center text-slate-400">
                      {table.search || activeFilters.length > 0
                        ? "No applicants match your search or filters."
                        : "No applicants yet."}
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
