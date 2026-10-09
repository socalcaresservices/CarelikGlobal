import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@carelik/ui";
import type { AwsApiClient } from "@/lib/aws-api";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { formatClockTime, formatDateTime } from "@/lib/service-verification";
import { MyExperienceCard, MyServicesCard } from "./readiness-cards";
import { WEEKDAYS, type AvailUnavailable, type AvailWindow } from "./availability-format";
import { AvailabilitySummary } from "./availability-ui";

type AvailState = {
  hasRecord: boolean;
  timezone?: string;
  version?: number;
  provided?: boolean;
  windows?: AvailWindow[];
  unavailable?: AvailUnavailable[];
  pending: null | { requestId: string; requestedAt: string; reason: string; stale: boolean; windows: AvailWindow[] | null; unavailable: AvailUnavailable[] | null };
  lastDecision: null | { status: "approved" | "declined"; reviewedAt: string; note: string | null };
};
type Opportunity = { offerId: string; status: string; serviceCode: string; serviceName: string; startsAt: string; endsAt: string; clientLabel: string };
const when = (value: string) => formatDateTime(value);
const errorText = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

export function CaregiverAvailabilityPage({ api }: { api: AwsApiClient }) {
  const { activeOrganizationId } = useOrganization();
  const qc = useQueryClient();
  const [days, setDays] = useState<Set<number>>(new Set());
  const [start, setStart] = useState("08:00");
  const [end, setEnd] = useState("20:00");
  const [off, setOff] = useState<string[]>([]);
  const [offDraft, setOffDraft] = useState("");
  const [reason, setReason] = useState("");
  const key = useRef(newIdempotencyKey());
  const hydrated = useRef<number | null>(null);

  const state = useQuery({
    queryKey: ["my-availability-state", activeOrganizationId],
    queryFn: async () => (await api.get<{ availability: AvailState }>("/v1/availability/me/state", { organizationId: activeOrganizationId })).availability,
    enabled: !!activeOrganizationId,
  });
  const opportunities = useQuery({
    queryKey: ["my-care-opportunities", activeOrganizationId],
    queryFn: () => api.get<{ opportunities: Opportunity[] }>("/v1/care-opportunities", { organizationId: activeOrganizationId }),
    enabled: !!activeOrganizationId,
    refetchInterval: 15_000,
  });

  const current = state.data;
  // Fill the form from the APPROVED availability once per version; never overwrite what the caregiver is typing.
  useEffect(() => {
    if (!current?.hasRecord || hydrated.current === (current.version ?? 0)) return;
    hydrated.current = current.version ?? 0;
    const recurring = (current.windows ?? []).filter((w) => w.weekday !== null);
    if (recurring.length) {
      setDays(new Set(recurring.map((w) => w.weekday!)));
      setStart(recurring[0]!.startLocal.slice(0, 5));
      setEnd(recurring[0]!.endLocal.slice(0, 5));
    }
    setOff((current.unavailable ?? []).map((u) => u.date));
  }, [current]);

  const saved = current?.windows ?? [];
  const savedRecurring = saved.filter((w) => w.weekday !== null);
  const mixed =
    saved.some((w) => w.weekday === null) ||
    savedRecurring.some((w) => w.startLocal !== savedRecurring[0]!.startLocal || w.endLocal !== savedRecurring[0]!.endLocal) ||
    new Set(savedRecurring.map((w) => w.weekday)).size !== savedRecurring.length;
  const datedKept = saved.filter((w) => w.weekday === null);

  const submit = useMutation({
    mutationFn: () => api.post("/v1/availability/me", {
      organizationId: activeOrganizationId,
      windows: [
        ...[...days].sort((a, b) => a - b).map((weekday) => ({ weekday, specific_date: null, start_local: start, end_local: end })),
        ...datedKept.map((w) => ({ weekday: null, specific_date: w.specificDate, start_local: w.startLocal, end_local: w.endLocal })),
      ],
      unavailableDates: off,
      reason: reason.trim(),
      expectedVersion: current?.version ?? 0,
    }, { idempotencyKey: key.current }),
    onSuccess: () => {
      key.current = newIdempotencyKey();
      setReason("");
      void qc.invalidateQueries({ queryKey: ["my-availability-state", activeOrganizationId] });
    },
  });
  const cancel = useMutation({
    mutationFn: (requestId: string) => api.post(`/v1/availability/requests/${requestId}/cancel`, { organizationId: activeOrganizationId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["my-availability-state", activeOrganizationId] }),
  });
  const respond = useMutation({
    mutationFn: ({ offerId, available }: { offerId: string; available: boolean }) => api.post("/v1/care-opportunities/" + offerId + "/respond", { organizationId: activeOrganizationId, available }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["my-care-opportunities", activeOrganizationId] }),
  });

  const pending = current?.pending ?? null;
  const canSubmit = !!days.size && !!start && !!end && start !== end && reason.trim().length > 0 && !pending;

  return <section className="space-y-6">
    <div><h1 className="text-2xl font-semibold text-slate-950">Availability</h1><p className="mt-1 text-sm text-slate-600">Request a change to your regular availability. Your agency reviews it; matching uses only what is approved. An availability response is not an assignment until the agency confirms it.</p></div>

    {state.isLoading ? <p className="text-sm text-slate-500" role="status">Loading…</p> : null}
    {state.isError ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{errorText(state.error, "Availability could not be loaded.")} <button type="button" className="underline" onClick={() => void state.refetch()}>Try again</button></p> : null}
    {current && !current.hasRecord ? <p role="note" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Your agency has not set up your caregiver record yet, so availability cannot be requested. Ask your agency.</p> : null}

    {current?.hasRecord ? <>
      <Card>
        <h2 className="font-semibold text-slate-950">Approved availability</h2>
        <div className="mt-2"><AvailabilitySummary windows={saved} unavailable={current.unavailable ?? []} empty="Nothing approved yet. Until it is approved you will not appear as available for matching." /></div>
        {current.timezone ? <p className="mt-2 text-xs text-slate-500">Times are in the agency time zone ({current.timezone}).</p> : null}
        {current.lastDecision ? <p className="mt-2 text-xs text-slate-600">Last request {current.lastDecision.status} on {when(current.lastDecision.reviewedAt)}.{current.lastDecision.note ? ` Note: ${current.lastDecision.note}` : ""}</p> : null}
      </Card>

      {pending ? <Card>
        <h2 className="font-semibold text-slate-950">Waiting for approval</h2>
        <p className="mt-1 text-sm text-slate-700">Sent {when(pending.requestedAt)}. Your approved availability stays in effect until it is approved.</p>
        <p className="mt-1 text-sm text-slate-600">Reason: {pending.reason}</p>
        <div className="mt-2"><AvailabilitySummary windows={pending.windows ?? saved} unavailable={pending.unavailable ?? current.unavailable ?? []} /></div>
        {pending.stale ? <p role="note" className="mt-2 text-sm font-medium text-amber-900">Your approved availability changed after you sent this. The reviewer will see both.</p> : null}
        {cancel.isError ? <p role="alert" className="mt-2 text-sm text-red-700">{errorText(cancel.error, "The request was not cancelled.")}</p> : null}
        <Button className="mt-3" variant="secondary" loading={cancel.isPending} onClick={() => cancel.mutate(pending.requestId)}>Cancel this request</Button>
      </Card> : null}

      <Card>
        <h2 className="font-semibold text-slate-950">Request a change</h2>
        <fieldset className="mt-3"><legend className="sr-only">Days</legend>
          <div className="flex flex-wrap gap-2">{WEEKDAYS.map((label, weekday) => <label key={label} className="flex min-h-[40px] items-center gap-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"><input type="checkbox" checked={days.has(weekday)} disabled={!!pending} onChange={(e) => setDays((c) => { const n = new Set(c); if (e.target.checked) n.add(weekday); else n.delete(weekday); return n; })} />{label}</label>)}</div>
        </fieldset>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-sm">From<input type="time" value={start} disabled={!!pending} onChange={(e) => setStart(e.target.value)} className="mt-1 block rounded-lg border border-slate-200 px-3 py-2" /></label>
          <label className="text-sm">To<input type="time" value={end} disabled={!!pending} onChange={(e) => setEnd(e.target.value)} className="mt-1 block rounded-lg border border-slate-200 px-3 py-2" /></label>
        </div>
        {start && end && start === end ? <p role="alert" className="mt-2 text-sm text-red-700">From and To cannot be the same time.</p> : null}
        {start && end && end < start ? <p className="mt-2 text-sm text-slate-700" data-testid="overnight-note">Overnight: each selected day starts at {start} and ends the next morning at {end}. For example, Saturday 10:00 PM to 6:00 AM covers Saturday night into Sunday.</p> : null}
        {mixed ? <p role="note" className="mt-2 text-sm font-medium text-amber-900">Your approved availability has different times on different days. This request uses one time range for the selected days; dates set for a single day are kept.</p> : null}

        <div className="mt-4">
          <p className="text-sm font-medium text-slate-700">Days off</p>
          <div className="mt-1 flex flex-wrap items-end gap-2">
            <label className="text-sm">Date<input type="date" value={offDraft} disabled={!!pending} onChange={(e) => setOffDraft(e.target.value)} className="mt-1 block rounded-lg border border-slate-200 px-3 py-2" /></label>
            <Button variant="secondary" disabled={!offDraft || off.includes(offDraft) || !!pending} onClick={() => { setOff((o) => [...o, offDraft].sort()); setOffDraft(""); }}>Add day off</Button>
          </div>
          {off.length ? <ul className="mt-2 flex flex-wrap gap-2">{off.map((d) => <li key={d} className="flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-sm">{d}<button type="button" aria-label={`Remove ${d}`} disabled={!!pending} className="min-h-[24px] min-w-[24px] text-slate-600" onClick={() => setOff((o) => o.filter((x) => x !== d))}>×</button></li>)}</ul> : null}
        </div>

        <label className="mt-4 block text-sm font-medium text-slate-700">Reason for the change (required)
          <input value={reason} maxLength={500} disabled={!!pending} onChange={(e) => setReason(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base" />
        </label>
        {submit.isError ? <p role="alert" className="mt-2 text-sm text-red-700">{errorText(submit.error, "The request was not sent.")} Your entries are kept.</p> : null}
        {submit.isSuccess ? <p role="status" className="mt-2 text-sm text-teal-800">Sent for approval.</p> : null}
        <Button className="mt-3" disabled={!canSubmit} loading={submit.isPending} onClick={() => submit.mutate()}>Send for approval</Button>
        {pending ? <p className="mt-2 text-xs text-slate-500">Cancel the waiting request to send a different one.</p> : null}
      </Card>
    </> : null}

    <MyServicesCard />
    <MyExperienceCard />

    <Card>
      <h2 className="font-semibold text-slate-950">Care opportunities</h2>
      <div className="mt-3 space-y-3">{(opportunities.data?.opportunities ?? []).map((o)=><div key={o.offerId} className="rounded-lg border border-slate-100 p-3"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-medium text-slate-900">{o.serviceName} · {o.clientLabel}</p><p className="text-sm text-slate-600">{when(o.startsAt)}–{formatClockTime(o.endsAt)}</p><p className="text-xs capitalize text-slate-500">{o.status.replaceAll("_"," ")}</p></div>{o.status==="sent"?<div className="flex gap-2"><Button size="sm" className="min-h-[40px]" loading={respond.isPending} onClick={()=>respond.mutate({offerId:o.offerId,available:true})}>Available</Button><Button size="sm" variant="secondary" className="min-h-[40px]" loading={respond.isPending} onClick={()=>respond.mutate({offerId:o.offerId,available:false})}>Not available</Button></div>:null}</div></div>)}
      {!opportunities.isLoading && (opportunities.data?.opportunities ?? []).length===0?<p className="text-sm text-slate-500">No open opportunities.</p>:null}</div>
    </Card>
  </section>;
}
