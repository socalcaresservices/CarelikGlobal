import { Fragment, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, FilterBar, StatusBadge, type ActiveFilter } from "@carelik/ui";
import { shiftStatusSchema } from "@carelik/shared";
import { useAuth } from "@carelik/auth";
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
  needs_coverage: boolean;
  call_out_reason: string | null;
}

interface ClientOption {
  id: string;
  first_name: string;
  last_name: string;
}

interface MemberOption {
  user_id: string;
  display_name: string;
}

// Backed by list_caregiver_matches() - see
// supabase/migrations/20260719280000_caregiver_client_matching.sql for
// the full CareScore weighting. Already sorted best-match-first by the
// RPC itself.
interface CaregiverMatchRow {
  caregiver_user_id: string;
  caregiver_name: string;
  match_score: number;
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
  const { user } = useAuth();
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const queryClient = useQueryClient();

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

  const membersQuery = useQuery({
    queryKey: ["members-for-scheduling", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_organization_members", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return ((data ?? []) as Array<{ user_id: string; display_name: string; status: string }>)
        .filter((member) => member.status === "active")
        .map((member): MemberOption => ({ user_id: member.user_id, display_name: member.display_name }));
    },
    enabled: !!activeOrganizationId && canManage
  });

  function refreshShifts() {
    void queryClient.invalidateQueries({ queryKey: ["shifts", activeOrganizationId] });
  }

  // A client can arrive with ?clientId= already set (see the "Assign a
  // caregiver" link on the Client detail page's Schedule tab), so the
  // CareScore-ranked caregiver list is ready immediately instead of
  // making the person re-pick the client they just came from.
  const [searchParams] = useSearchParams();
  const [clientId, setClientId] = useState(() => searchParams.get("clientId") ?? "");

  const matchesQuery = useQuery({
    queryKey: ["caregiver-matches", activeOrganizationId, clientId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_caregiver_matches", {
        target_organization_id: activeOrganizationId!,
        target_client_id: clientId
      });
      if (error) throw error;
      return (data ?? []) as CaregiverMatchRow[];
    },
    enabled: !!activeOrganizationId && !!clientId && canManage
  });

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

  const [caregiverId, setCaregiverId] = useState("");
  const [startsAt, setStartsAt] = useState(toLocalInputValue(inOneHour));
  const [endsAt, setEndsAt] = useState(toLocalInputValue(inTwoHours));
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeOrganizationId) return;

    setFormError(null);

    const startDate = new Date(startsAt);
    const endDate = new Date(endsAt);
    if (endDate.getTime() <= startDate.getTime()) {
      setFormError("End time must be after start time.");
      return;
    }

    setSaving(true);
    try {
      const { error } = await supabase.from("shifts").insert({
        organization_id: activeOrganizationId,
        client_id: clientId,
        caregiver_user_id: caregiverId,
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

  // Call-out / replacement (20260812230000_shift_coverage.sql). Calling
  // out never touches the shift row - "needs coverage" is read back from
  // list_shifts()'s needs_coverage flag, which is derived from the
  // coverage-event log. Reassigning updates the SAME shift's
  // caregiver_user_id - same id, same times, same authorization
  // reservation, no duplicate shift or visit.
  const [callOutShiftId, setCallOutShiftId] = useState<string | null>(null);
  const [callOutReason, setCallOutReason] = useState("");
  const [callOutError, setCallOutError] = useState<string | null>(null);
  const [callingOut, setCallingOut] = useState(false);

  const [reassignShiftId, setReassignShiftId] = useState<string | null>(null);
  const [reassignCaregiverId, setReassignCaregiverId] = useState("");
  const [reassignReason, setReassignReason] = useState("");
  const [reassignError, setReassignError] = useState<string | null>(null);
  const [reassigning, setReassigning] = useState(false);

  function startCallOut(shiftId: string) {
    setCallOutShiftId(shiftId);
    setCallOutReason("");
    setCallOutError(null);
  }

  async function handleCallOut(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!callOutShiftId || !callOutReason.trim()) return;
    setCallingOut(true);
    setCallOutError(null);
    try {
      const { error } = await supabase.rpc("call_out_shift", {
        target_shift_id: callOutShiftId,
        reason: callOutReason.trim()
      });
      if (error) throw error;
      setCallOutShiftId(null);
      refreshShifts();
    } catch (cause) {
      setCallOutError(cause instanceof Error ? cause.message : "Could not call out this shift.");
    } finally {
      setCallingOut(false);
    }
  }

  function startReassign(shiftId: string) {
    setReassignShiftId(shiftId);
    setReassignCaregiverId("");
    setReassignReason("");
    setReassignError(null);
  }

  async function handleReassign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reassignShiftId || !reassignCaregiverId || !reassignReason.trim()) return;
    setReassigning(true);
    setReassignError(null);
    try {
      const { error } = await supabase.rpc("reassign_shift", {
        target_shift_id: reassignShiftId,
        new_caregiver_user_id: reassignCaregiverId,
        reason: reassignReason.trim()
      });
      if (error) throw error;
      setReassignShiftId(null);
      refreshShifts();
    } catch (cause) {
      setReassignError(cause instanceof Error ? cause.message : "Could not reassign this shift.");
    } finally {
      setReassigning(false);
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
                onChange={(event) => setClientId(event.target.value)}
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
              <label htmlFor="shift-caregiver" className="block text-xs font-medium text-slate-600">
                Caregiver
              </label>
              <select
                id="shift-caregiver"
                required
                value={caregiverId}
                onChange={(event) => setCaregiverId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              >
                <option value="" disabled>
                  Select a caregiver
                </option>
                {matchesQuery.data
                  ? matchesQuery.data.map((match) => (
                      <option key={match.caregiver_user_id} value={match.caregiver_user_id}>
                        {match.caregiver_name} — CareScore {match.match_score}
                      </option>
                    ))
                  : (membersQuery.data ?? []).map((member) => (
                      <option key={member.user_id} value={member.user_id}>
                        {member.display_name}
                      </option>
                    ))}
              </select>
              {clientId ? (
                <p className="mt-1 text-xs text-slate-500">
                  {matchesQuery.isLoading
                    ? "Ranking caregivers for this client…"
                    : "Ranked by CareScore, best match first."}
                </p>
              ) : null}
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
                onChange={(event) => setStartsAt(event.target.value)}
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
                <th className="pb-2 font-medium">Coverage</th>
              </tr>
            </thead>
            <tbody>
              {table.rows.map((shift) => {
                const isPending = pendingId === shift.id;
                const isOwnShift = user?.id === shift.caregiver_user_id;
                const canCallOut = shift.status === "scheduled" && !shift.needs_coverage && (isOwnShift || canManage);
                return (
                  <Fragment key={shift.id}>
                    <tr className="border-b border-slate-100 last:border-0">
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
                      <td className="py-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          {shift.needs_coverage ? (
                            <>
                              <StatusBadge label="Needs coverage" tone="warning" />
                              {canManage ? (
                                <button
                                  type="button"
                                  onClick={() => startReassign(shift.id)}
                                  className="text-xs font-medium text-slate-700 underline-offset-2 hover:underline"
                                >
                                  Reassign
                                </button>
                              ) : null}
                            </>
                          ) : canCallOut ? (
                            <button
                              type="button"
                              onClick={() => startCallOut(shift.id)}
                              className="text-xs font-medium text-slate-700 underline-offset-2 hover:underline"
                            >
                              Call out
                            </button>
                          ) : (
                            <span className="text-xs text-slate-300">—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {shift.needs_coverage && shift.call_out_reason ? (
                      <tr className="border-b border-slate-100 last:border-0 bg-amber-50">
                        <td colSpan={5} className="px-2 py-2 text-xs text-amber-800">
                          Called out: {shift.call_out_reason}
                        </td>
                      </tr>
                    ) : null}
                    {callOutShiftId === shift.id ? (
                      <tr className="border-b border-slate-100 last:border-0 bg-slate-50">
                        <td colSpan={5} className="p-3">
                          <form onSubmit={handleCallOut} className="flex flex-wrap items-end gap-3">
                            <div className="min-w-[240px] flex-1">
                              <label
                                htmlFor={`call-out-reason-${shift.id}`}
                                className="block text-xs font-medium text-slate-600"
                              >
                                Reason for calling out
                              </label>
                              <input
                                id={`call-out-reason-${shift.id}`}
                                required
                                value={callOutReason}
                                onChange={(event) => setCallOutReason(event.target.value)}
                                placeholder="e.g. Family emergency"
                                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                              />
                            </div>
                            <Button type="submit" size="sm" loading={callingOut}>
                              Confirm call-out
                            </Button>
                            <button
                              type="button"
                              onClick={() => setCallOutShiftId(null)}
                              className="text-sm font-medium text-slate-600 hover:text-slate-900"
                            >
                              Cancel
                            </button>
                          </form>
                          {callOutError ? <p className="mt-2 text-sm text-red-700">{callOutError}</p> : null}
                        </td>
                      </tr>
                    ) : null}
                    {reassignShiftId === shift.id ? (
                      <tr className="border-b border-slate-100 last:border-0 bg-slate-50">
                        <td colSpan={5} className="p-3">
                          <form onSubmit={handleReassign} className="flex flex-wrap items-end gap-3">
                            <div>
                              <label
                                htmlFor={`reassign-caregiver-${shift.id}`}
                                className="block text-xs font-medium text-slate-600"
                              >
                                Cover with
                              </label>
                              <select
                                id={`reassign-caregiver-${shift.id}`}
                                required
                                value={reassignCaregiverId}
                                onChange={(event) => setReassignCaregiverId(event.target.value)}
                                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                              >
                                <option value="" disabled>
                                  Select a caregiver
                                </option>
                                {(membersQuery.data ?? [])
                                  .filter((member) => member.user_id !== shift.caregiver_user_id)
                                  .map((member) => (
                                    <option key={member.user_id} value={member.user_id}>
                                      {member.display_name}
                                    </option>
                                  ))}
                              </select>
                            </div>
                            <div className="min-w-[220px] flex-1">
                              <label
                                htmlFor={`reassign-reason-${shift.id}`}
                                className="block text-xs font-medium text-slate-600"
                              >
                                Reason
                              </label>
                              <input
                                id={`reassign-reason-${shift.id}`}
                                required
                                value={reassignReason}
                                onChange={(event) => setReassignReason(event.target.value)}
                                placeholder="e.g. Covering the call-out"
                                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                              />
                            </div>
                            <Button type="submit" size="sm" loading={reassigning}>
                              Confirm reassignment
                            </Button>
                            <button
                              type="button"
                              onClick={() => setReassignShiftId(null)}
                              className="text-sm font-medium text-slate-600 hover:text-slate-900"
                            >
                              Cancel
                            </button>
                          </form>
                          {reassignError ? <p className="mt-2 text-sm text-red-700">{reassignError}</p> : null}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
              {table.rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-slate-400">
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
