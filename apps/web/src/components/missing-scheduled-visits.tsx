import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { useServiceVerificationBackend } from "@/lib/sv-backend-supabase";
import { newIdempotencyKey, type MissingScheduledVisit, type VisitReportFilters } from "@/lib/sv-backend";
import { formatDateTime, getAgencyTimeZone, pacificWallTimeToDate, toPacificWallTime, type PacificWallTime } from "@/lib/service-verification";
import { PacificDateTimeInputs } from "./pacific-time-out-field";

export function MissingScheduledVisits({ filters }: { filters: VisitReportFilters }) {
  const backend = useServiceVerificationBackend();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<MissingScheduledVisit | null>(null);
  const [start, setStart] = useState<PacificWallTime | null>(null);
  const [end, setEnd] = useState<PacificWallTime | null>(null);
  const [reasonLabel, setReasonLabel] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const keys = useRef(new Map<string, string>());
  const query = useQuery({
    queryKey: ["missing-scheduled-visits", activeOrganizationId, filters],
    queryFn: () => backend.listMissingScheduledVisits!(activeOrganizationId!, filters),
    enabled: !!activeOrganizationId && hasPermission("visits.read") && !!backend.listMissingScheduledVisits,
  });
  const labels = useQuery({
    queryKey: ["missing-visit-reason-labels", activeOrganizationId],
    queryFn: () => backend.listMissingVisitReasonLabels!(activeOrganizationId!),
    enabled: !!activeOrganizationId && hasPermission("visits.read") && !!backend.listMissingVisitReasonLabels,
  });
  if (!backend.listMissingScheduledVisits || !hasPermission("visits.read")) return null;
  async function save() {
    if (busy || !selected || !start || !end || !backend.recordMissingScheduledVisit) return;
    const a = pacificWallTimeToDate(start), b = pacificWallTimeToDate(end);
    if (!a.ok || !b.ok) return setError(!a.ok ? a.error : !b.ok ? b.error : "Enter both times.");
    const minutes = (b.value.getTime() - a.value.getTime()) / 60000;
    if (minutes < 1 || minutes > 1440 || b.value.getTime() > Date.now()) return setError("Enter actual times in order, no more than 24 hours apart and not in the future.");
    if (backend.listMissingVisitReasonLabels && !reasonLabel.trim()) return setError("Choose a reason category or enter a short label.");
    if (reason.trim().length < 10) return setError("Enter a reason of at least 10 characters describing what you checked.");
    const fingerprint = JSON.stringify([activeOrganizationId, selected.shiftId, a.value.toISOString(), b.value.toISOString(), reason.trim(), reasonLabel.trim()]);
    if (!keys.current.has(fingerprint)) keys.current.set(fingerprint, newIdempotencyKey());
    setBusy(true); setError("");
    try {
      await backend.recordMissingScheduledVisit({ organizationId: activeOrganizationId!, shiftId: selected.shiftId, timeIn: a.value.toISOString(), timeOut: b.value.toISOString(), reason: reason.trim(), ...(reasonLabel.trim() ? { reasonLabel: reasonLabel.trim() } : {}), idempotencyKey: keys.current.get(fingerprint)! });
      setSelected(null); setReason(""); setReasonLabel("");
      setNotice("Actual times saved. Next: collect client confirmation. Billing is pending.");
      await Promise.all(["missing-scheduled-visits", "missing-visit-reason-labels", "service-visit-report", "aws-reconcile", "aws-shifts", "monthly-chain", "monthly-service-summary", "aws-utilisation", "attention-overview"].map((key) => qc.invalidateQueries({ queryKey: [key] })));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Not saved. Try again."); }
    finally { setBusy(false); }
  }
  return <Card>
    <h3 className="font-semibold text-slate-950">Scheduled visits with both punches missing</h3>
    {labels.data?.length ? <details className="my-2 text-sm">
      <summary>Corrections by reason across all dates</summary>
      <ul>{labels.data.map(({ label, visits }) => <li key={label}>{label}: {visits}</li>)}</ul>
    </details> : null}
    <p className="mt-1 text-sm text-slate-600">Ended shifts without a visit record. A missing record does not prove no service occurred.</p>
    {query.isLoading ? <p role="status">Loading missing scheduled visits…</p> : null}
    {query.isError ? <p role="alert">Could not load missing scheduled visits. This exception report is incomplete. <button className="underline" onClick={() => void query.refetch()}>Retry</button></p> : null}
    {notice ? <p role="status" className="mt-2 text-emerald-800">{notice}</p> : null}
    {query.isSuccess && !query.data.length ? <p className="mt-2 text-sm">No missing scheduled visit records for these filters.</p> : null}
    <ul className="divide-y divide-slate-200">{(query.data ?? []).map((row) => <li key={row.shiftId} className="py-3 text-sm">
      <p className="font-semibold">Client {row.clientCode} · {row.serviceName ?? "Service not set"}</p>
      <p>{row.caregiverName} · {formatDateTime(row.startsAt)} – {formatDateTime(row.endsAt)}</p>
      {hasPermission("visits.manage") && row.canRecord && backend.recordMissingScheduledVisit ? <Button type="button" className="mt-2 min-h-11" disabled={busy} onClick={() => {
        setSelected(row); setReason(""); setReasonLabel(""); setError(""); setNotice("");
        // Never imply the scheduled times are evidence of actual work.
        setStart({ ...toPacificWallTime(row.startsAt), hour: null, minute: null, meridiem: null });
        setEnd({ ...toPacificWallTime(row.endsAt), hour: null, minute: null, meridiem: null });
      }}>Record actual times</Button> : null}
      {selected?.shiftId === row.shiftId && start && end ? <div className="mt-3 space-y-3 rounded-lg border border-slate-300 p-3">
        <p>Enter the actual times you verified ({getAgencyTimeZone()}). The scheduled hours are not copied into the punches.</p>
        <PacificDateTimeInputs label="Actual Time In" value={start} onChange={setStart} />
        <PacificDateTimeInputs label="Actual Time Out" value={end} onChange={setEnd} />
        {backend.listMissingVisitReasonLabels ? <label className="block">Reason category (required)
          <input className="mt-1 block w-full rounded border p-2" list="missing-visit-categories" maxLength={80}
            value={reasonLabel} onChange={(event) => setReasonLabel(event.target.value)} />
          <datalist id="missing-visit-categories">
            {[...new Set(["Missed punches", "Device or connection issue", "Office verified visit", "Other", ...(labels.data ?? []).map((row) => row.label)])].map((label) =>
              <option key={label} value={label} />)}
          </datalist>
          <span className="text-xs text-slate-600">Select a category or enter a short label to reuse. Keep client details in the note below.</span>
        </label> : null}
        <label className="block">What you verified (required)<textarea className="mt-1 block w-full rounded border p-2" maxLength={1000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <p className="text-sm text-slate-600">Next after saving: collect client confirmation.</p>
        {error ? <p role="alert" className="text-red-700">{error}</p> : null}
        <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save actual times"}</Button><Button disabled={busy} onClick={() => setSelected(null)}>Cancel</Button></div>
      </div> : null}
    </li>)}</ul>
  </Card>;
}
