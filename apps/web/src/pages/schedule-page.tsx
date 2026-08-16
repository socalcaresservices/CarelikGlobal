import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, FilterBar, type ActiveFilter } from "@carelik/ui";
import { shiftStatusSchema } from "@carelik/shared";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { useTableControls } from "@/lib/use-table-controls";
import { useFilters } from "@/lib/use-filters";
import { useColumnWidths } from "@/lib/use-column-widths";
import { SortableHeader } from "@/components/sortable-header";
import { CaregiverHoursCard } from "@/components/caregiver-hours";

// Backed by list_shifts(), a security-definer RPC (see
// supabase/migrations/20260719231000_list_shifts.sql) that resolves
// client and caregiver names server-side - RLS on user_profiles wouldn't
// let this page join in another user's display name on its own. Access
// mirrors the shifts RLS policy: org-wide with shifts.read, otherwise
// just the shifts you're the caregiver on.
//
// Bounded to a rolling window (see SHIFT_WINDOW_DAYS below) via
// list_shifts()'s own from_time/to_time params - the same params
// action-center.tsx and operational-snapshot.tsx already pass, just
// never used here before. Shifts are the highest-cardinality entity in
// the app (an active client can generate several a week, indefinitely),
// so fetching every shift ever and filtering client-side (this page's
// prior behavior) doesn't scale the way it does for smaller, naturally
// bounded lists elsewhere. A page-level date-range picker to browse
// outside this window is real follow-up work, not built here - this is
// only a safety net against unbounded growth, matching this heading's
// own "Upcoming and recent" framing.
// 60 days back, 60 days forward - generous enough that no organization's
// current shift volume should ever notice the bound today, while still
// capping the fetch as shift history accumulates over time. Chosen to
// comfortably exceed action-center.tsx's tighter 7-day signal window
// (that's a notifications widget, not the primary schedule view) without
// re-fetching a table that only ever grows.
const SHIFT_WINDOW_DAYS = 60;

interface ShiftRow {
  id: string;
  client_id: string;
  client_name: string;
  caregiver_user_id: string;
  caregiver_name: string;
  starts_at: string;
  ends_at: string;
  status: "scheduled" | "completed" | "cancelled" | "no_show";
  notes: string | null;
}

interface ClientOption {
  id: string;
  first_name: string;
  last_name: string;
}

interface WorkforceOption { id: string; linked_user_id: string | null; first_name: string; last_name: string; preferred_name: string | null; }

interface AuthorizationOption {
  id: string;
  service_id: string;
  period_start: string;
  period_end: string;
  services: { code: string; name: string } | null;
}

const statusStyles: Record<ShiftRow["status"], string> = {
  scheduled: "bg-sky-50 text-sky-700",
  completed: "bg-emerald-50 text-emerald-700",
  cancelled: "bg-slate-100 text-slate-600",
  no_show: "bg-red-50 text-red-700"
};

function toLocalInputValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
}

export function SchedulePage() {
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [clientId, setClientId] = useState(() => searchParams.get("clientId") ?? "");

  const canRead = hasPermission("shifts.read");
  const canManage = hasPermission("shifts.update");

  const shiftWindowStart = new Date(Date.now() - SHIFT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const shiftWindowEnd = new Date(Date.now() + SHIFT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const shiftsQuery = useQuery({
    queryKey: ["shifts", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_shifts", {
        target_organization_id: activeOrganizationId!,
        from_time: shiftWindowStart.toISOString(),
        to_time: shiftWindowEnd.toISOString()
      });
      if (error) throw error;
      return (data ?? []) as ShiftRow[];
    },
    enabled: !!activeOrganizationId
  });

  const clientsQuery = useQuery({
    queryKey: ["clients-for-scheduling", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("clients")
        .select("id, first_name, last_name")
        .eq("organization_id", activeOrganizationId!)
        .order("last_name");
      if (error) throw error;
      return (data ?? []) as ClientOption[];
    },
    enabled: !!activeOrganizationId && canManage
  });

  const workforceQuery = useQuery({
    queryKey: ["workforce-for-scheduling", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.from("caregiver_records").select("id, linked_user_id, first_name, last_name, preferred_name").eq("organization_id", activeOrganizationId!).in("status", ["ready", "active"]).is("deleted_at", null).order("last_name");
      if (error) throw error;
      return (data ?? []) as WorkforceOption[];
    },
    enabled: !!activeOrganizationId && canManage
  });

  const authorizationsQuery = useQuery({
    queryKey: ["authorizations-for-scheduling", activeOrganizationId, clientId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("client_authorizations")
        .select("id, service_id, period_start, period_end, services(code, name)")
        .eq("organization_id", activeOrganizationId!)
        .eq("client_id", clientId)
        .is("deleted_at", null)
        .order("period_end", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as AuthorizationOption[];
    },
    enabled: !!activeOrganizationId && !!clientId && canManage
  });

  function refreshShifts() {
    void queryClient.invalidateQueries({ queryKey: ["shifts", activeOrganizationId] });
  }

  // A client can arrive with ?clientId= already set (see the "Assign a
  // caregiver" link on the Client detail page's Schedule tab), so the
  // Care Team list is ready immediately instead of making the person
  // re-pick the client they just came from.
  const filters = useFilters<ShiftRow>(shiftsQuery.data, {
    status: (row, value) => row.status === value
  });

  const table = useTableControls<ShiftRow, "when" | "client" | "caregiver" | "status">(
    filters.rows,
    {
      matchesSearch: (row, query) =>
        row.client_name.toLowerCase().includes(query) || row.caregiver_name.toLowerCase().includes(query),
      sorters: {
        when: (a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(),
        client: (a, b) => a.client_name.localeCompare(b.client_name),
        caregiver: (a, b) => a.caregiver_name.localeCompare(b.caregiver_name),
        status: (a, b) => a.status.localeCompare(b.status)
      },
      defaultSort: "when"
    }
  );

  const scheduleActiveFilters: ActiveFilter[] = filters.values.status
    ? [
        {
          key: "status",
          label: `Status: ${filters.values.status.replace("_", " ")}`,
          onRemove: () => filters.setFilter("status", "")
        }
      ]
    : [];

  const columns = useColumnWidths("carelik:column-widths:schedule", {
    when: 190,
    client: 160,
    caregiver: 160,
    status: 150
  });

  const now = new Date();
  const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
  const inTwoHours = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  const [caregiverRecordId, setCaregiverRecordId] = useState("");
  const [authorizationId, setAuthorizationId] = useState("");
  const [startsAt, setStartsAt] = useState(toLocalInputValue(inOneHour));
  const [endsAt, setEndsAt] = useState(toLocalInputValue(inTwoHours));
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const shiftDate = startsAt.slice(0, 10);
  const schedulableAuthorizations = (authorizationsQuery.data ?? []).filter(
    (authorization) => authorization.period_start <= shiftDate && authorization.period_end >= shiftDate
  );

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeOrganizationId) return;

    setFormError(null);

    const startDate = new Date(startsAt);
    const endDate = new Date(endsAt);
    const caregiver = (workforceQuery.data ?? []).find((row: WorkforceOption) => row.id === caregiverRecordId);
    const authorization = schedulableAuthorizations.find((row) => row.id === authorizationId);
    if (!clientId || !caregiver || !authorization) {
      setFormError("Select a client, authorized service, and Care Team member.");
      return;
    }
    if (endDate.getTime() <= startDate.getTime()) {
      setFormError("End time must be after start time.");
      return;
    }

    setSaving(true);
    try {
      const { error } = await supabase.from("shifts").insert({
        organization_id: activeOrganizationId,
        client_id: clientId,
        caregiver_record_id: caregiver.id,
        caregiver_user_id: caregiver.linked_user_id,
        service_id: authorization.service_id,
        starts_at: startDate.toISOString(),
        ends_at: endDate.toISOString(),
        notes: notes || null
      });
      if (error) throw error;
      setNotes("");
      refreshShifts();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not schedule shift.");
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(shiftId: string, nextStatus: ShiftRow["status"]) {
    setRowError(null);
    setPendingId(shiftId);
    try {
      const { error } = await supabase.from("shifts").update({ status: nextStatus }).eq("id", shiftId);
      if (error) throw error;
      refreshShifts();
    } catch (cause) {
      setRowError(cause instanceof Error ? cause.message : "Could not update shift.");
    } finally {
      setPendingId(null);
    }
  }

  // Deliberately no permission gate on the page itself: list_shifts()
  // and the underlying RLS policy both let a caregiver see their own
  // assigned shifts even without shifts.read, so there's always
  // something valid to show. Only the "schedule a shift" form and status
  // controls are gated on shifts.update below.

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Schedule</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-950">
          {activeOrganization?.displayName ?? "Shifts"}
        </h2>
        {!canRead ? (
          <p className="mt-1 text-sm text-slate-500">Showing only shifts assigned to you.</p>
        ) : null}
      </div>

      {canManage ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Schedule a shift</h3>
          <form onSubmit={handleCreate} className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="shift-client" className="block text-xs font-medium text-slate-600">
                Client
              </label>
              <select
                id="shift-client"
                required
                value={clientId}
                onChange={(event) => {
                  setClientId(event.target.value);
                  setAuthorizationId("");
                }}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              >
                <option value="" disabled>
                  Select a client
                </option>
                {(clientsQuery.data ?? []).map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.first_name} {client.last_name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="shift-authorization" className="block text-xs font-medium text-slate-600">
                Authorized service
              </label>
              <select
                id="shift-authorization"
                required
                value={authorizationId}
                onChange={(event) => setAuthorizationId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              >
                <option value="" disabled>
                  Select an active authorization
                </option>
                {schedulableAuthorizations.map((authorization) => (
                  <option key={authorization.id} value={authorization.id}>
                    {authorization.services?.code} — {authorization.services?.name} ({authorization.period_start} to {authorization.period_end})
                  </option>
                ))}
              </select>
              {clientId && !authorizationsQuery.isLoading && schedulableAuthorizations.length === 0 ? (
                <p className="mt-1 text-xs text-amber-700">Add an authorization covering this shift date before scheduling.</p>
              ) : null}
            </div>
            <div>
              <label htmlFor="shift-caregiver" className="block text-xs font-medium text-slate-600">
                Caregiver
              </label>
              <select
                id="shift-caregiver"
                required
                value={caregiverRecordId}
                onChange={(event) => setCaregiverRecordId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              >
                <option value="" disabled>
                  Select a caregiver
                </option>
                {(workforceQuery.data ?? []).map((caregiver: WorkforceOption) => (
                  <option key={caregiver.id} value={caregiver.id}>
                    {caregiver.preferred_name || caregiver.first_name} {caregiver.last_name}
                    {caregiver.linked_user_id ? "" : " (no login)"}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-500">Care Team records can be scheduled before a login is linked.</p>
            </div>
            <div>
              <label htmlFor="shift-starts" className="block text-xs font-medium text-slate-600">
                Starts
              </label>
              <input
                id="shift-starts"
                type="datetime-local"
                required
                value={startsAt}
                onChange={(event) => {
                  setStartsAt(event.target.value);
                  setAuthorizationId("");
                }}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div>
              <label htmlFor="shift-ends" className="block text-xs font-medium text-slate-600">
                Ends
              </label>
              <input
                id="shift-ends"
                type="datetime-local"
                required
                value={endsAt}
                onChange={(event) => setEndsAt(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="shift-notes" className="block text-xs font-medium text-slate-600">
                Notes
              </label>
              <input
                id="shift-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" loading={saving}>
                {saving ? "Scheduling…" : "Schedule shift"}
              </Button>
            </div>
          </form>
          {formError ? <p className="mt-3 text-sm text-red-700">{formError}</p> : null}
        </Card>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold text-slate-950">Upcoming and recent shifts</h3>
          <FilterBar
            activeFilters={scheduleActiveFilters}
            onClearAll={scheduleActiveFilters.length > 0 ? filters.clearAll : undefined}
            className="w-full sm:w-auto"
          >
            <input
              type="search"
              value={table.search}
              onChange={(event) => table.setSearch(event.target.value)}
              placeholder="Search client or caregiver"
              aria-label="Search shifts"
              className="w-full max-w-xs rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
            />
            <div>
              <label htmlFor="schedule-status-filter" className="sr-only">
                Filter by status
              </label>
              <select
                id="schedule-status-filter"
                value={filters.values.status ?? ""}
                onChange={(event) => filters.setFilter("status", event.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
              >
                <option value="">All statuses</option>
                {shiftStatusSchema.options.map((option) => (
                  <option key={option} value={option}>
                    {option.replace("_", " ")}
                  </option>
                ))}
              </select>
            </div>
          </FilterBar>
        </div>
        {rowError ? <p className="mt-2 text-sm text-red-700">{rowError}</p> : null}
        {shiftsQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : shiftsQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">Could not load the schedule.</p>
        ) : (
          <div className="overflow-x-auto">
          <table className="mt-4 w-full table-fixed text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                <SortableHeader
                  label="When"
                  active={table.sortKey === "when"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("when")}
                  width={columns.widths.when}
                  onResizeStart={columns.startResize("when")}
                />
                <SortableHeader
                  label="Client"
                  active={table.sortKey === "client"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("client")}
                  width={columns.widths.client}
                  onResizeStart={columns.startResize("client")}
                />
                <SortableHeader
                  label="Caregiver"
                  active={table.sortKey === "caregiver"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("caregiver")}
                  width={columns.widths.caregiver}
                  onResizeStart={columns.startResize("caregiver")}
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
              {table.rows.map((shift) => {
                const isPending = pendingId === shift.id;
                return (
                  <tr key={shift.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2.5 whitespace-nowrap text-slate-600">
                      {new Date(shift.starts_at).toLocaleString()} –{" "}
                      {new Date(shift.ends_at).toLocaleTimeString()}
                    </td>
                    <td className="py-2.5 text-slate-800">{shift.client_name}</td>
                    <td className="py-2.5 text-slate-600">{shift.caregiver_name}</td>
                    <td className="py-2.5">
                      {canManage ? (
                        <select
                          aria-label={`Change status for ${shift.client_name} / ${shift.caregiver_name} shift`}
                          value={shift.status}
                          disabled={isPending}
                          onChange={(event) =>
                            handleStatusChange(shift.id, event.target.value as ShiftRow["status"])
                          }
                          className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-900"
                        >
                          {shiftStatusSchema.options.map((option) => (
                            <option key={option} value={option}>
                              {option.replace("_", " ")}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[shift.status]}`}
                        >
                          {shift.status.replace("_", " ")}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {table.rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-slate-400">
                    {table.search || scheduleActiveFilters.length > 0
                      ? "No shifts match your search or filters."
                      : "No shifts scheduled."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          </div>
        )}
      </Card>

      <CaregiverHoursCard />
    </section>
  );
}
