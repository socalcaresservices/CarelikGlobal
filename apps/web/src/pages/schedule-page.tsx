import { Fragment, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, FilterBar, type ActiveFilter } from "@carelik/ui";
import { shiftStatusSchema } from "@carelik/shared";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { useTableControls } from "@/lib/use-table-controls";
import { useFilters } from "@/lib/use-filters";
import { useColumnWidths } from "@/lib/use-column-widths";
import { SortableHeader } from "@/components/sortable-header";
import { CaregiverHoursCard } from "@/components/caregiver-hours";
import {
  MAX_RECURRING_OCCURRENCES,
  WEEKDAY_OPTIONS,
  formatDateRangeSummary,
  formatWeekdaySummary,
  generateRecurringDates
} from "@/lib/recurring-shifts";

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
  caregiver_user_id: string | null;
  caregiver_record_id: string | null;
  caregiver_name: string;
  starts_at: string;
  ends_at: string;
  status: "scheduled" | "completed" | "cancelled" | "no_show";
  notes: string | null;
  needs_coverage: boolean;
  call_out_reason: string | null;
}

interface CoverageHistoryEntry {
  id: string;
  event_type: "called_out" | "reassigned";
  original_caregiver_name: string;
  replacement_caregiver_name: string | null;
  actor_name: string;
  reason: string;
  created_at: string;
}

interface BatchResult {
  createdCount: number;
  skipped: Array<{ date: string; reason: string }>;
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
  const { user } = useAuth();
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

  // needs_coverage (list_shifts) is true when a shift's caregiver called
  // out (call_out_shift) and no one has been reassigned to it yet
  // (reassign_shift). This is the only place in the app that surfaces
  // it - filed under the schedule window's own rolling 60-day range, not
  // a separate date picker, so it stays in sync with the table below it.
  const uncoveredShifts = (shiftsQuery.data ?? []).filter((shift) => shift.needs_coverage);

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
  const [repeatEnabled, setRepeatEnabled] = useState(false);
  const [repeatWeekdays, setRepeatWeekdays] = useState<Set<number>>(new Set());
  const [repeatEndDate, setRepeatEndDate] = useState("");
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  const shiftDate = startsAt.slice(0, 10);
  const schedulableAuthorizations = (authorizationsQuery.data ?? []).filter(
    (authorization) => authorization.period_start <= shiftDate && authorization.period_end >= shiftDate
  );

  const previewDates = repeatEnabled ? generateRecurringDates(shiftDate, repeatEndDate, repeatWeekdays) : [];

  function toggleRepeatWeekday(day: number) {
    setRepeatWeekdays((current) => {
      const next = new Set(current);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeOrganizationId) return;

    setFormError(null);
    setBatchResult(null);

    const startDate = new Date(startsAt);
    const endDate = new Date(endsAt);
    const startTime = startsAt.slice(11);
    const endTime = endsAt.slice(11);
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

    // {date, startsAtIso, endsAtIso} per occurrence - built explicitly
    // rather than re-deriving ends_at from each occurrence's date and a
    // shared end-time-of-day, which would silently break an overnight
    // shift (start/end on different calendar days) by discarding the
    // original end date. Recurring shifts are validated same-day just
    // below specifically so this per-date reconstruction is safe there;
    // the single-shift path never reconstructs at all - it reuses
    // startDate/endDate exactly as the pre-recurrence version did.
    let occurrences: Array<{ date: string; startsAtIso: string; endsAtIso: string }>;
    if (repeatEnabled) {
      if (endsAt.slice(0, 10) !== startsAt.slice(0, 10)) {
        setFormError("Recurring shifts must start and end on the same day.");
        return;
      }
      if (repeatWeekdays.size === 0) {
        setFormError("Select at least one weekday to repeat on.");
        return;
      }
      if (!repeatEndDate) {
        setFormError("Choose an end date for the recurring schedule.");
        return;
      }
      if (repeatEndDate < shiftDate) {
        setFormError("End date must be on or after the start date.");
        return;
      }
      const occurrenceDates = generateRecurringDates(shiftDate, repeatEndDate, repeatWeekdays);
      if (occurrenceDates.length === 0) {
        setFormError("No dates in this range match the selected weekdays.");
        return;
      }
      if (occurrenceDates.length > MAX_RECURRING_OCCURRENCES) {
        setFormError(
          `This would create ${occurrenceDates.length} shifts - narrow the date range or weekdays to ${MAX_RECURRING_OCCURRENCES} or fewer.`
        );
        return;
      }
      occurrences = occurrenceDates.map((date) => ({
        date,
        startsAtIso: new Date(`${date}T${startTime}`).toISOString(),
        endsAtIso: new Date(`${date}T${endTime}`).toISOString()
      }));
    } else {
      occurrences = [{ date: shiftDate, startsAtIso: startDate.toISOString(), endsAtIso: endDate.toISOString() }];
    }

    setSaving(true);
    try {
      const skipped: Array<{ date: string; reason: string }> = [];
      let createdCount = 0;

      // Sequential, one insert per occurrence - not a single multi-row
      // insert. A multi-row INSERT is one statement, so if any row's
      // trigger validation fails (overlap, authorization cap/expiry),
      // Postgres rolls back the entire statement. Inserting one at a
      // time lets the occurrences that pass succeed even when one date
      // conflicts, and lets each failure report its own specific reason
      // instead of aborting the whole batch on the first problem.
      for (const occurrence of occurrences) {
        const { error } = await supabase.from("shifts").insert({
          organization_id: activeOrganizationId,
          client_id: clientId,
          caregiver_record_id: caregiver.id,
          caregiver_user_id: caregiver.linked_user_id,
          service_id: authorization.service_id,
          starts_at: occurrence.startsAtIso,
          ends_at: occurrence.endsAtIso,
          notes: notes || null
        });
        if (error) {
          skipped.push({ date: occurrence.date, reason: error.message });
        } else {
          createdCount += 1;
        }
      }

      if (repeatEnabled) {
        setBatchResult({ createdCount, skipped });
        if (createdCount > 0) {
          setNotes("");
          refreshShifts();
        }
      } else if (skipped.length > 0) {
        setFormError(skipped[0]!.reason);
      } else {
        setNotes("");
        refreshShifts();
      }
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

  // Reuses call_out_shift/reassign_shift/list_shift_coverage_history
  // (supabase/migrations/20260812194149_shift_coverage_functions.sql) -
  // all pre-existing RPCs with their own permission checks and history
  // preservation; this page only calls them and renders the result, no
  // new backend logic.
  const [callOutTargetId, setCallOutTargetId] = useState<string | null>(null);
  const [callOutReason, setCallOutReason] = useState("");
  const [callOutSaving, setCallOutSaving] = useState(false);
  const [callOutError, setCallOutError] = useState<string | null>(null);

  const [reassignTargetId, setReassignTargetId] = useState<string | null>(null);
  const [reassignCaregiverUserId, setReassignCaregiverUserId] = useState("");
  const [reassignReason, setReassignReason] = useState("");
  const [reassignSaving, setReassignSaving] = useState(false);
  const [reassignError, setReassignError] = useState<string | null>(null);

  const [historyOpenId, setHistoryOpenId] = useState<string | null>(null);

  const historyQuery = useQuery({
    queryKey: ["shift-coverage-history", historyOpenId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_shift_coverage_history", {
        target_shift_id: historyOpenId!
      });
      if (error) throw error;
      return (data ?? []) as CoverageHistoryEntry[];
    },
    enabled: !!historyOpenId
  });

  // Replacement candidates: reassign_shift takes a user id, so only
  // Care Team records with a linked login can be a target - the same
  // constraint the RPC itself enforces.
  const reassignCandidates = (workforceQuery.data ?? []).filter((row) => !!row.linked_user_id);

  function candidateHasConflict(candidate: WorkforceOption, targetShift: ShiftRow) {
    const targetStart = new Date(targetShift.starts_at).getTime();
    const targetEnd = new Date(targetShift.ends_at).getTime();
    return (shiftsQuery.data ?? []).some((shift) => {
      if (shift.id === targetShift.id) return false;
      if (shift.status !== "scheduled" && shift.status !== "completed") return false;
      if (shift.caregiver_record_id !== candidate.id) return false;
      const shiftStart = new Date(shift.starts_at).getTime();
      const shiftEnd = new Date(shift.ends_at).getTime();
      return shiftStart < targetEnd && shiftEnd > targetStart;
    });
  }

  function startCallOut(shiftId: string) {
    setCallOutTargetId(shiftId);
    setCallOutReason("");
    setCallOutError(null);
  }

  async function submitCallOut(shiftId: string) {
    if (!callOutReason.trim()) {
      setCallOutError("A reason is required.");
      return;
    }
    setCallOutSaving(true);
    setCallOutError(null);
    try {
      const { error } = await supabase.rpc("call_out_shift", {
        target_shift_id: shiftId,
        reason: callOutReason.trim()
      });
      if (error) throw error;
      setCallOutTargetId(null);
      setCallOutReason("");
      refreshShifts();
    } catch (cause) {
      setCallOutError(cause instanceof Error ? cause.message : "Could not call out this shift.");
    } finally {
      setCallOutSaving(false);
    }
  }

  function startReassign(shiftId: string) {
    setReassignTargetId(shiftId);
    setReassignCaregiverUserId("");
    setReassignReason("");
    setReassignError(null);
  }

  async function submitReassign(shiftId: string) {
    if (!reassignCaregiverUserId) {
      setReassignError("Select a replacement caregiver.");
      return;
    }
    if (!reassignReason.trim()) {
      setReassignError("A reason is required.");
      return;
    }
    setReassignSaving(true);
    setReassignError(null);
    try {
      const { error } = await supabase.rpc("reassign_shift", {
        target_shift_id: shiftId,
        new_caregiver_user_id: reassignCaregiverUserId,
        reason: reassignReason.trim()
      });
      if (error) throw error;
      setReassignTargetId(null);
      setReassignCaregiverUserId("");
      setReassignReason("");
      refreshShifts();
    } catch (cause) {
      setReassignError(cause instanceof Error ? cause.message : "Could not reassign this shift.");
    } finally {
      setReassignSaving(false);
    }
  }

  function toggleHistory(shiftId: string) {
    setHistoryOpenId((current) => (current === shiftId ? null : shiftId));
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

      {uncoveredShifts.length > 0 ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Needs coverage</h3>
          <p className="mt-1 text-xs text-slate-500">
            Shifts whose caregiver called out and haven&apos;t been reassigned yet.
          </p>
          <ul className="mt-3 divide-y divide-slate-100">
            {uncoveredShifts.map((shift) => (
              <li key={shift.id} className="py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-slate-700">
                    {shift.client_name} <span className="text-slate-400">· was {shift.caregiver_name}</span>
                  </span>
                  <span className="font-medium text-red-700">
                    {new Date(shift.starts_at).toLocaleString()}
                  </span>
                </div>
                {shift.call_out_reason ? (
                  <p className="mt-0.5 text-xs text-slate-500">Reason: {shift.call_out_reason}</p>
                ) : null}

                {canManage ? (
                  reassignTargetId === shift.id ? (
                    <div className="mt-2 space-y-2 rounded-lg bg-slate-50 p-3">
                      <div>
                        <label
                          htmlFor={`reassign-caregiver-${shift.id}`}
                          className="block text-xs font-medium text-slate-600"
                        >
                          Replacement caregiver
                        </label>
                        <select
                          id={`reassign-caregiver-${shift.id}`}
                          value={reassignCaregiverUserId}
                          onChange={(event) => setReassignCaregiverUserId(event.target.value)}
                          className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-900"
                        >
                          <option value="" disabled>
                            Select a caregiver
                          </option>
                          {reassignCandidates.map((candidate) => (
                            <option key={candidate.id} value={candidate.linked_user_id!}>
                              {candidate.preferred_name || candidate.first_name} {candidate.last_name}
                              {candidateHasConflict(candidate, shift) ? " - already scheduled at this time" : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label
                          htmlFor={`reassign-reason-${shift.id}`}
                          className="block text-xs font-medium text-slate-600"
                        >
                          Reason
                        </label>
                        <input
                          id={`reassign-reason-${shift.id}`}
                          value={reassignReason}
                          onChange={(event) => setReassignReason(event.target.value)}
                          className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-900"
                        />
                      </div>
                      {reassignError ? <p className="text-xs text-red-700">{reassignError}</p> : null}
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          loading={reassignSaving}
                          onClick={() => submitReassign(shift.id)}
                        >
                          Confirm reassignment
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setReassignTargetId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={() => startReassign(shift.id)}>
                      Reassign
                    </Button>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

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

            <div className="sm:col-span-2 rounded-lg border border-slate-200 p-3">
              <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={repeatEnabled}
                  onChange={(event) => {
                    setRepeatEnabled(event.target.checked);
                    setBatchResult(null);
                  }}
                />
                Repeats
              </label>
              {repeatEnabled ? (
                <div className="mt-3 space-y-3">
                  <div>
                    <p className="text-xs font-medium text-slate-600">On these days</p>
                    <div className="mt-1.5 flex flex-wrap gap-3">
                      {WEEKDAY_OPTIONS.map((option) => (
                        <label key={option.value} className="flex items-center gap-1.5 text-xs text-slate-700">
                          <input
                            type="checkbox"
                            checked={repeatWeekdays.has(option.value)}
                            onChange={() => toggleRepeatWeekday(option.value)}
                          />
                          {option.label}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label htmlFor="repeat-end-date" className="block text-xs font-medium text-slate-600">
                      Until
                    </label>
                    <input
                      id="repeat-end-date"
                      type="date"
                      required={repeatEnabled}
                      value={repeatEndDate}
                      min={shiftDate}
                      onChange={(event) => setRepeatEndDate(event.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
                    />
                  </div>
                  {previewDates.length > 0 ? (
                    <p
                      className={`text-xs font-medium ${
                        previewDates.length > MAX_RECURRING_OCCURRENCES ? "text-red-700" : "text-slate-600"
                      }`}
                    >
                      {previewDates.length} shift{previewDates.length === 1 ? "" : "s"} will be created:{" "}
                      {formatDateRangeSummary(previewDates)}, {formatWeekdaySummary(repeatWeekdays)},{" "}
                      {startsAt.slice(11)}–{endsAt.slice(11)}
                      {previewDates.length > MAX_RECURRING_OCCURRENCES
                        ? ` (exceeds the ${MAX_RECURRING_OCCURRENCES}-shift maximum)`
                        : ""}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="sm:col-span-2">
              <Button type="submit" loading={saving}>
                {saving ? "Scheduling…" : repeatEnabled ? "Schedule shifts" : "Schedule shift"}
              </Button>
            </div>
          </form>
          {formError ? <p className="mt-3 text-sm text-red-700">{formError}</p> : null}
          {batchResult ? (
            <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">
              <p className="font-medium text-slate-900">
                {batchResult.createdCount} shift{batchResult.createdCount === 1 ? "" : "s"} created
              </p>
              {batchResult.skipped.length > 0 ? (
                <>
                  <p className="mt-1 font-medium text-amber-700">
                    {batchResult.skipped.length} skipped
                  </p>
                  <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
                    {batchResult.skipped.map((item) => (
                      <li key={item.date}>
                        {new Date(`${item.date}T00:00`).toLocaleDateString()} — {item.reason}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}
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
                <th className="w-40 py-2 pl-3 text-xs font-medium uppercase tracking-wide text-slate-500">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {table.rows.map((shift) => {
                const isPending = pendingId === shift.id;
                const isOwnShift = !!user?.id && shift.caregiver_user_id === user.id;
                const canCallOut = shift.status === "scheduled" && !shift.needs_coverage && (canManage || isOwnShift);
                const isHistoryOpen = historyOpenId === shift.id;
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
                    <td className="py-2.5 pl-3">
                      <div className="flex flex-wrap items-center gap-2">
                        {canCallOut ? (
                          <Button type="button" size="sm" variant="secondary" onClick={() => startCallOut(shift.id)}>
                            Call out
                          </Button>
                        ) : null}
                        <Button type="button" size="sm" variant="ghost" onClick={() => toggleHistory(shift.id)}>
                          {isHistoryOpen ? "Hide history" : "History"}
                        </Button>
                      </div>
                      {callOutTargetId === shift.id ? (
                        <div className="mt-2 space-y-2 rounded-lg bg-slate-50 p-2">
                          <label htmlFor={`call-out-reason-${shift.id}`} className="block text-xs font-medium text-slate-600">
                            Reason
                          </label>
                          <input
                            id={`call-out-reason-${shift.id}`}
                            value={callOutReason}
                            onChange={(event) => setCallOutReason(event.target.value)}
                            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-900"
                          />
                          {callOutError ? <p className="text-xs text-red-700">{callOutError}</p> : null}
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              size="sm"
                              loading={callOutSaving}
                              onClick={() => submitCallOut(shift.id)}
                            >
                              Confirm call out
                            </Button>
                            <Button type="button" size="sm" variant="ghost" onClick={() => setCallOutTargetId(null)}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                  {isHistoryOpen ? (
                    <tr className="border-b border-slate-100 last:border-0 bg-slate-50">
                      <td colSpan={5} className="py-2.5 px-3">
                        {historyQuery.isLoading ? (
                          <p className="text-xs text-slate-500">Loading history…</p>
                        ) : historyQuery.isError ? (
                          <p className="text-xs text-red-700">Could not load history.</p>
                        ) : (historyQuery.data ?? []).length === 0 ? (
                          <p className="text-xs text-slate-400">No coverage history for this shift.</p>
                        ) : (
                          <ul className="space-y-1.5">
                            {(historyQuery.data ?? []).map((entry) => (
                              <li key={entry.id} className="text-xs text-slate-600">
                                <span className="font-medium text-slate-800">
                                  {entry.event_type === "called_out"
                                    ? `${entry.original_caregiver_name} called out`
                                    : `Reassigned ${entry.original_caregiver_name} → ${entry.replacement_caregiver_name}`}
                                </span>{" "}
                                by {entry.actor_name} on {new Date(entry.created_at).toLocaleString()} — {entry.reason}
                              </li>
                            ))}
                          </ul>
                        )}
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
