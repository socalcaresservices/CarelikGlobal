import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { formatDateOnly, formatDateTime } from "@/lib/service-verification";
import { useAwsApi } from "../aws-workspace";
import { SummarySection } from "../ui/summary-section";
import { REQUEST_STATUS_BADGE, REQUEST_STATUS_LABEL, actionError, rangeLabel, weeklySummary, type HoursRange } from "./format";

interface Row {
  requestId: string;
  caregiverRecordId: string;
  caregiverCode: string;
  caregiverName: string;
  kind: "weekly" | "date";
  status: string;
  reason: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  windows: HoursRange[];
  requestedAt: string;
}
interface Preview {
  current: HoursRange[] | { source: string; unavailable: boolean; windows: HoursRange[] };
  proposed: HoursRange[];
  affectedShifts: { shiftId: string; startsAt: string; endsAt: string }[];
  note: string;
}

export const APPROVAL_NOTE = "Approving availability does not assign work or change booked shifts.";

function Hours({ kind, windows, unavailable }: { kind: "weekly" | "date"; windows: HoursRange[]; unavailable?: boolean }) {
  if (kind === "weekly") {
    return (
      <dl className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-0.5 text-sm">
        {weeklySummary(windows).map((d) => (
          <div key={d.weekday} className="contents"><dt className="text-slate-600">{d.name.slice(0, 3)}</dt><dd>{d.ranges.length ? d.ranges.join(", ") : <span className="text-slate-500">Not available</span>}</dd></div>
        ))}
      </dl>
    );
  }
  return <p className="text-sm">{unavailable || windows.length === 0 ? "Not available" : windows.map(rangeLabel).join(", ")}</p>;
}

function ReviewPanel({ row, canDecide, onDone }: { row: Row; canDecide: boolean; onDone: () => void }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const [note, setNote] = useState("");
  const [choice, setChoice] = useState<"approve" | "decline">("approve");
  const key = useRef(newIdempotencyKey());
  const preview = useQuery({
    queryKey: ["availability-preview", activeOrganizationId, row.requestId],
    queryFn: async () => (await api.get<{ preview: Preview }>(`/v1/availability/requests/${encodeURIComponent(row.requestId)}`, { organizationId: activeOrganizationId })).preview,
  });
  const decide = useMutation({
    mutationFn: (decision: "approve" | "decline") =>
      api.post(`/v1/availability/requests/${encodeURIComponent(row.requestId)}/review`, { organizationId: activeOrganizationId, decision, note: note.trim() || null }, { idempotencyKey: key.current }),
    onSuccess: onDone,
  });
  if (preview.isLoading) return <p className="mt-3 text-sm text-slate-500">Loading…</p>;
  if (preview.isError || !preview.data) return <p role="alert" className="mt-3 text-sm text-red-700">{actionError(preview.error, "The details could not be loaded.")}</p>;
  const p = preview.data;
  const currentWindows = Array.isArray(p.current) ? p.current : p.current.windows;
  const currentUnavailable = !Array.isArray(p.current) && p.current.unavailable;
  return (
    <div className="mt-2 space-y-2 border-t border-slate-200 pt-2">
      <div className="grid gap-4 sm:grid-cols-2">
        <section aria-label="Current hours"><h4 className="text-sm font-semibold text-slate-900">Current</h4><Hours kind={row.kind} windows={currentWindows} unavailable={currentUnavailable} /></section>
        <section aria-label="Proposed hours"><h4 className="text-sm font-semibold text-slate-900">Proposed</h4><Hours kind={row.kind} windows={p.proposed} unavailable={row.kind === "date" && p.proposed.length === 0} /></section>
      </div>
      <section aria-label="Affected shifts">
        <h4 className="text-sm font-semibold text-slate-900">Affected shifts</h4>
        {p.affectedShifts.length === 0 ? <p className="text-sm text-slate-700">No booked shifts fall outside the proposed hours.</p> : (
          <>
            <p className="text-sm text-amber-950">{p.affectedShifts.length} booked shift{p.affectedShifts.length === 1 ? "" : "s"} would fall outside the proposed hours. They stay booked and are flagged for review.</p>
            <ul className="mt-1 list-disc pl-5 text-sm text-slate-800">{p.affectedShifts.map((s) => <li key={s.shiftId}>{formatDateTime(s.startsAt)} – {formatDateTime(s.endsAt)}</li>)}</ul>
          </>
        )}
      </section>
      <p className="text-sm text-slate-700">{APPROVAL_NOTE}</p>
      {canDecide ? (
        <div className="space-y-2">
          <fieldset className="flex flex-wrap gap-x-5">
            <legend className="text-sm font-medium text-slate-800">Decision</legend>
            <label className="flex min-h-[44px] items-center gap-2 text-sm"><input type="radio" name={`decision-${row.requestId}`} className="h-5 w-5" checked={choice === "approve"} onChange={() => { setChoice("approve"); key.current = newIdempotencyKey(); }} />Approve</label>
            <label className="flex min-h-[44px] items-center gap-2 text-sm"><input type="radio" name={`decision-${row.requestId}`} className="h-5 w-5" checked={choice === "decline"} onChange={() => { setChoice("decline"); key.current = newIdempotencyKey(); }} />Decline</label>
          </fieldset>
          {choice === "decline" ? (
            <label className="block text-sm font-medium text-slate-800">Note to the caregiver (required)
              <textarea value={note} onChange={(e) => { setNote(e.target.value); key.current = newIdempotencyKey(); }} rows={2} maxLength={500} className="mt-1 block w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm" />
            </label>
          ) : null}
          {decide.isError ? <p role="alert" className="text-sm text-red-700">{actionError(decide.error, "The decision was not saved. Try again.")}</p> : null}
          <Button type="button" variant={choice === "decline" ? "danger" : "primary"} disabled={decide.isPending || (choice === "decline" && note.trim().length < 3)} onClick={() => decide.mutate(choice)}>
            {decide.isPending ? "Saving…" : choice === "decline" ? "Save: decline" : "Save: approve"}
          </Button>
        </div>
      ) : <p className="text-sm text-slate-600">Only an administrator can approve or decline.</p>}
    </div>
  );
}

/** Pending availability requests for the agency (or one caregiver), each reviewable in place. */
export function AvailabilityReview({ caregiverRecordId }: { caregiverRecordId?: string }) {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [open, setOpen] = useState<string | null>(null);
  const canDecide = hasPermission("availability.review");
  const q = useQuery({
    queryKey: ["availability-requests", activeOrganizationId],
    queryFn: async () => (await api.get<{ requests: Row[] }>("/v1/availability/requests", { organizationId: activeOrganizationId, status: "pending" })).requests,
    enabled: !!activeOrganizationId && hasPermission("availability.read"),
  });
  if (!hasPermission("availability.read")) return null;
  const rows = (q.data ?? []).filter((r) => !caregiverRecordId || r.caregiverRecordId === caregiverRecordId);
  return (
    <SummarySection title="Availability requests" defaultOpen={rows.length > 0}
      status={q.data ? <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${rows.length > 0 ? "bg-amber-100 text-amber-950" : "bg-slate-100 text-slate-800"}`}>{rows.length > 0 ? `${rows.length} pending` : "None pending"}</span> : undefined}>
      {q.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {q.isError ? <p role="alert" className="text-sm text-red-700">{actionError(q.error, "Requests could not be loaded. Reload the page.")}</p> : null}
      {q.data && rows.length === 0 ? <p className="text-sm text-slate-600">No pending requests.</p> : null}
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.requestId} className="rounded-md border border-slate-200 px-2 py-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-slate-900">{r.caregiverName} <span className="font-normal text-slate-500">({r.caregiverCode})</span></p>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${REQUEST_STATUS_BADGE[r.status] ?? ""}`}>{REQUEST_STATUS_LABEL[r.status] ?? r.status}</span>
            </div>
            <p className="mt-1 text-sm text-slate-700">{r.kind === "weekly" ? "Weekly hours" : "Specific date"} · from {formatDateOnly(r.effectiveFrom)}{r.kind === "weekly" && r.effectiveUntil ? ` to ${formatDateOnly(r.effectiveUntil)}` : ""}</p>
            <p className="text-sm text-slate-700">Reason: {r.reason}</p>
            <Button type="button" variant="secondary" className="mt-2" aria-expanded={open === r.requestId} onClick={() => setOpen(open === r.requestId ? null : r.requestId)}>
              {open === r.requestId ? "Close" : "Review"}
            </Button>
            {open === r.requestId ? (
              <ReviewPanel row={r} canDecide={canDecide} onDone={() => { setOpen(null); void qc.invalidateQueries({ queryKey: ["availability-requests"] }); void qc.invalidateQueries({ queryKey: ["availability"] }); }} />
            ) : null}
          </li>
        ))}
      </ul>
    </SummarySection>
  );
}
