import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Card, FilterBar, PageHeader, StatusBadge, type ActiveFilter, type StatusTone } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { useTableControls } from "@/lib/use-table-controls";
import { useFilters } from "@/lib/use-filters";
import { useColumnWidths } from "@/lib/use-column-widths";
import { SortableHeader } from "@/components/sortable-header";
import { PlainHeader } from "@/components/resizable-th";

// Human-controlled recruiting workspace. Ogevia displays administrative
// pipeline data here; it does not rank, recommend, select, or reject people.
interface CandidateRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  pipeline_stage: string;
  source: string;
  position_applied_for: string | null;
  applied_at: string;
  desired_weekly_hours: number | null;
  available_start_date: string | null;
  imported_at: string | null;
  created_at: string;
}

const PIPELINE_STAGES = [
  "imported",
  "application_needed",
  "application_received",
  "screening",
  "interview",
  "conditional_offer",
  "hired_onboarding_required",
  "onboarding_scheduled",
  "onboarding",
  "compliance_pending",
  "ready_to_work",
  "care_team",
  "on_hold",
  "rejected",
  "withdrawn"
] as const;

const stageTone: Record<string, StatusTone> = {
  imported: "neutral",
  application_needed: "warning",
  application_received: "info",
  screening: "info",
  interview: "info",
  conditional_offer: "warning",
  hired_onboarding_required: "success",
  onboarding_scheduled: "warning",
  onboarding: "warning",
  compliance_pending: "warning",
  ready_to_work: "success",
  care_team: "success",
  on_hold: "neutral",
  rejected: "neutral",
  withdrawn: "neutral"
};

function formatLabel(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatHours(hours: number) {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

export function ApplicantsPage() {
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const canRead = hasPermission("applicants.read");

  const candidatesQuery = useQuery({
    queryKey: ["candidates", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_candidates_v1", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as CandidateRow[];
    },
    enabled: !!activeOrganizationId && canRead
  });

  const filters = useFilters<CandidateRow>(candidatesQuery.data, {
    stage: (row, value) => row.pipeline_stage === value,
    source: (row, value) => row.source === value
  });

  const table = useTableControls<CandidateRow, "name" | "stage" | "applied">(filters.rows, {
    matchesSearch: (row, query) =>
      `${row.first_name} ${row.last_name}`.toLowerCase().includes(query) ||
      row.email.toLowerCase().includes(query) ||
      (row.phone ?? "").toLowerCase().includes(query) ||
      (row.position_applied_for ?? "").toLowerCase().includes(query),
    sorters: {
      name: (a, b) => `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`),
      stage: (a, b) => a.pipeline_stage.localeCompare(b.pipeline_stage),
      applied: (a, b) => new Date(b.applied_at).getTime() - new Date(a.applied_at).getTime()
    },
    defaultSort: "applied"
  });

  const sourceOptions = Array.from(new Set((candidatesQuery.data ?? []).map((row) => row.source))).sort();

  const columns = useColumnWidths("carelik:column-widths:candidates", {
    name: 210,
    stage: 170,
    source: 120,
    position: 170,
    hours: 120,
    applied: 120
  });

  const activeFilters: ActiveFilter[] = [
    filters.values.stage
      ? {
          key: "stage",
          label: `Stage: ${formatLabel(filters.values.stage)}`,
          onRemove: () => filters.setFilter("stage", "")
        }
      : null,
    filters.values.source
      ? {
          key: "source",
          label: `Source: ${formatLabel(filters.values.source)}`,
          onRemove: () => filters.setFilter("source", "")
        }
      : null
  ].filter((entry): entry is ActiveFilter => entry !== null);

  if (!canRead) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Candidates</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h2>
          <p className="mt-3 text-slate-600">You don&apos;t have permission to view candidates for this organization.</p>
        </Card>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        eyebrow="People"
        title="Candidates"
        description={`Recruiting and onboarding pipeline${activeOrganization?.displayName ? ` for ${activeOrganization.displayName}` : ""}. Candidate stages are changed by authorized staff.`}
      />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold text-slate-950">Candidate pipeline</h3>
            <p className="mt-1 text-xs text-slate-500">Imported applicants, direct applications, onboarding, and ready-to-work records in one view.</p>
          </div>
          <FilterBar
            activeFilters={activeFilters}
            onClearAll={activeFilters.length > 0 ? filters.clearAll : undefined}
            className="w-full sm:w-auto"
          >
            <input
              type="search"
              value={table.search}
              onChange={(event) => table.setSearch(event.target.value)}
              placeholder="Search name, email, phone, or position"
              aria-label="Search candidates"
              className="w-full max-w-xs rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
            />
            <select
              aria-label="Filter by pipeline stage"
              value={filters.values.stage ?? ""}
              onChange={(event) => filters.setFilter("stage", event.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
            >
              <option value="">All stages</option>
              {PIPELINE_STAGES.map((stage) => (
                <option key={stage} value={stage}>{formatLabel(stage)}</option>
              ))}
            </select>
            <select
              aria-label="Filter by source"
              value={filters.values.source ?? ""}
              onChange={(event) => filters.setFilter("source", event.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
            >
              <option value="">All sources</option>
              {sourceOptions.map((source) => (
                <option key={source} value={source}>{formatLabel(source)}</option>
              ))}
            </select>
          </FilterBar>
        </div>

        {candidatesQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : candidatesQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">Could not load candidates. Apply the Candidate Hiring V1 database migration before deploying this page.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="mt-4 w-full min-w-[900px] table-fixed text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <SortableHeader
                    label="Candidate"
                    active={table.sortKey === "name"}
                    direction={table.direction}
                    onClick={() => table.toggleSort("name")}
                    width={columns.widths.name}
                    onResizeStart={columns.startResize("name")}
                  />
                  <SortableHeader
                    label="Stage"
                    active={table.sortKey === "stage"}
                    direction={table.direction}
                    onClick={() => table.toggleSort("stage")}
                    width={columns.widths.stage}
                    onResizeStart={columns.startResize("stage")}
                  />
                  <PlainHeader label="Source" width={columns.widths.source} onResizeStart={columns.startResize("source")} />
                  <PlainHeader label="Position" width={columns.widths.position} onResizeStart={columns.startResize("position")} />
                  <PlainHeader label="Desired hours" width={columns.widths.hours} onResizeStart={columns.startResize("hours")} />
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
                      <Link to={`/applicants/${row.id}`} className="font-medium hover:underline">
                        {row.first_name} {row.last_name}
                      </Link>
                      <p className="truncate text-xs text-slate-500">{row.email}{row.phone ? ` · ${row.phone}` : ""}</p>
                    </td>
                    <td className="py-2.5">
                      <StatusBadge label={formatLabel(row.pipeline_stage)} tone={stageTone[row.pipeline_stage] ?? "neutral"} />
                    </td>
                    <td className="py-2.5 text-slate-600">{formatLabel(row.source)}</td>
                    <td className="truncate py-2.5 text-slate-600">{row.position_applied_for ?? "—"}</td>
                    <td className="py-2.5 text-slate-600">
                      {row.desired_weekly_hours != null ? `${formatHours(row.desired_weekly_hours)}h/week` : "—"}
                    </td>
                    <td className="py-2.5 text-slate-500">{new Date(row.applied_at).toLocaleDateString()}</td>
                  </tr>
                ))}
                {table.rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-slate-400">
                      {table.search || activeFilters.length > 0 ? "No candidates match this view." : "No candidates yet."}
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
