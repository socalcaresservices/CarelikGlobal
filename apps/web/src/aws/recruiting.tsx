// Recruiting and onboarding (0054): the pipeline (Applicant to Pending documents), each person's checklist and progress, and
// exactly what is still outstanding. Every rule (the checklist, the approval gate, the assignment gate) is enforced again by
// the server; these screens only show it. The checklist stores dates and status only: no results, reports or personal details.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { formatDateOnly } from "@/lib/service-verification";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { CAREGIVER_STATUS_LABEL, PIPELINE_STAGES, type CaregiverStatus } from "./care-team-admin";
import { SummarySection } from "./ui/summary-section";
import { InfoTip } from "./ui/info-tip";
import { actionBtn } from "./ui-classes";

const inputClass = "mt-0.5 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm";
const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

export interface OnboardingItem {
  requirementId: string; key: string; label: string; category: "background_check" | "training" | "document" | "clearance" | "other"; required: boolean;
  state: "done" | "waived" | "outstanding" | "expired"; detail: string | null; completedOn: string | null; expiresOn: string | null; note: string | null; expiringSoon: boolean;
}
export interface Onboarding { caregiverRecordId: string; status: CaregiverStatus; onboardingRequired: boolean; done: number; total: number; complete: boolean; items: OnboardingItem[] }
interface OverviewRow {
  caregiverRecordId: string; caregiverCode: string; caregiverName: string; status: CaregiverStatus; onboardingRequired: boolean; done: number; total: number;
  outstanding: Array<{ label: string; state: string; detail: string | null; category: string }>; nextExpiry: string | null;
}

/** The stage a person moves to next; Pending documents leads to Approved, which the server only allows once the checklist is complete. */
const NEXT_STAGE: Partial<Record<CaregiverStatus, CaregiverStatus>> = { applicant: "interview", interview: "offer", offer: "onboarding", onboarding: "pending_documents", pending_documents: "ready" };

const STATE_STYLE: Record<OnboardingItem["state"], string> = {
  done: "bg-emerald-100 text-emerald-900", waived: "bg-slate-200 text-slate-800", outstanding: "bg-amber-100 text-amber-900", expired: "bg-red-100 text-red-900",
};
const STATE_LABEL: Record<OnboardingItem["state"], string> = { done: "Done", waived: "Waived", outstanding: "Outstanding", expired: "Expired" };

export function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="flex items-center gap-2" role="img" aria-label={`${done} of ${total} requirements satisfied`}>
      <div className="h-2 w-28 overflow-hidden rounded-full bg-slate-200"><div className={`h-full ${done === total && total > 0 ? "bg-emerald-600" : "bg-teal-700"}`} style={{ width: `${pct}%` }} /></div>
      <span className="text-xs tabular-nums text-slate-700">{done}/{total}</span>
    </div>
  );
}

function useOnboarding(caregiverRecordId: string, enabled = true) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  return useQuery({
    queryKey: ["aws-onboarding", activeOrganizationId, caregiverRecordId],
    queryFn: async () => (await api.get<{ onboarding: Onboarding }>(`/v1/caregivers/${encodeURIComponent(caregiverRecordId)}/onboarding`, { organizationId: activeOrganizationId })).onboarding,
    enabled: enabled && !!activeOrganizationId,
  });
}
function useRefreshOnboarding() {
  const queryClient = useQueryClient();
  return async () => { for (const k of ["aws-onboarding", "aws-onboarding-overview", "aws-caregivers"]) await queryClient.invalidateQueries({ queryKey: [k] }); };
}

function ItemRow({ caregiverRecordId, item, canManage }: { caregiverRecordId: string; item: OnboardingItem; canManage: boolean }) {
  const api = useAwsApi();
  const refresh = useRefreshOnboarding();
  const { activeOrganizationId } = useOrganization();
  const [open, setOpen] = useState<"complete" | "waive" | "reopen" | null>(null);
  const [form, setForm] = useState({ completedOn: "", expiresOn: "", note: "", reason: "" });
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  const id = `ob-${item.key}`;
  async function submit(action: "complete" | "waive" | "reopen") {
    if (action !== "complete" && form.reason.trim().length < 3) return setState({ busy: false, error: "Give the reason." });
    setState({ busy: true, error: null });
    try {
      await api.post(`/v1/caregivers/${encodeURIComponent(caregiverRecordId)}/onboarding/items`, {
        organizationId: activeOrganizationId, requirementKey: item.key, action, completedOn: form.completedOn || null, expiresOn: form.expiresOn || null,
        note: form.note.trim() || null, reason: form.reason.trim() || null,
      }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await refresh();
      setForm({ completedOn: "", expiresOn: "", note: "", reason: "" });
      setOpen(null);
      setState({ busy: false, error: null });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not saved.") });
    }
  }
  const satisfied = item.state === "done" || item.state === "waived";
  return (
    <li className="px-2 py-1 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <p className="font-medium text-slate-950 md:w-52">{item.label}{item.required ? "" : " (optional)"}</p>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATE_STYLE[item.state]}`}>{STATE_LABEL[item.state]}</span>
        <p className="min-w-0 flex-1 text-xs text-slate-700">
          {item.completedOn ? `Recorded ${formatDateOnly(item.completedOn)}` : item.detail ?? "Not recorded"}
          {item.expiresOn ? ` · ${item.state === "expired" ? "expired" : "expires"} ${formatDateOnly(item.expiresOn)}${item.expiringSoon ? " — soon" : ""}` : ""}
          {item.note ? ` · ${item.note}` : ""}
          {item.category === "document" ? <> · Checked from approved documents. <Link className="inline-flex min-h-[44px] items-center underline md:min-h-[28px]" to="/documents">Open Documents</Link></> : null}
        </p>
        {item.category !== "document" && canManage ? (
          <div className="flex flex-wrap gap-1.5">
            {!satisfied ? <button type="button" className={`${actionBtn} md:min-h-7 md:py-0`} onClick={() => setOpen(open === "complete" ? null : "complete")}>{item.state === "expired" ? "Record renewal" : "Mark done"}</button> : null}
            {!satisfied && item.category !== "clearance" ? <button type="button" className={`${actionBtn} md:min-h-7 md:py-0`} onClick={() => setOpen(open === "waive" ? null : "waive")}>Waive</button> : null}
            {satisfied ? <button type="button" className={`${actionBtn} md:min-h-7 md:py-0`} onClick={() => setOpen(open === "reopen" ? null : "reopen")}>Reopen</button> : null}
          </div>
        ) : null}
      </div>
      {open ? (
        <form onSubmit={(e) => { e.preventDefault(); void submit(open); }} className="mt-1 grid gap-2 rounded-md bg-slate-50 p-2 sm:grid-cols-2">
          {open === "complete" ? (
            <>
              <div><label htmlFor={`${id}-on`} className="block text-xs font-medium text-slate-600">Date completed (today if blank)</label><input id={`${id}-on`} type="date" value={form.completedOn} onChange={(e) => setForm({ ...form, completedOn: e.target.value })} className={inputClass} /></div>
              <div><label htmlFor={`${id}-exp`} className="block text-xs font-medium text-slate-600">Expires on (optional)</label><input id={`${id}-exp`} type="date" value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} className={inputClass} /></div>
              <div className="sm:col-span-2"><label htmlFor={`${id}-note`} className="block text-xs font-medium text-slate-600">Note (optional, no results or personal details)</label><input id={`${id}-note`} value={form.note} maxLength={200} onChange={(e) => setForm({ ...form, note: e.target.value })} className={inputClass} /></div>
            </>
          ) : (
            <div className="sm:col-span-2"><label htmlFor={`${id}-reason`} className="block text-xs font-medium text-slate-600">Reason</label><input id={`${id}-reason`} value={form.reason} maxLength={500} onChange={(e) => setForm({ ...form, reason: e.target.value })} className={inputClass} /></div>
          )}
          {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={state.busy}>{open === "complete" ? "Save" : open === "waive" ? "Waive" : "Reopen"}</Button>
            <button type="button" className="text-sm underline" onClick={() => setOpen(null)}>Close</button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

/** Checklist and progress on the caregiver's page. */
export function OnboardingCard({ caregiverRecordId, status, canManage }: { caregiverRecordId: string; status: CaregiverStatus; canManage: boolean }) {
  const api = useAwsApi();
  const refresh = useRefreshOnboarding();
  const { activeOrganizationId } = useOrganization();
  const onboarding = useOnboarding(caregiverRecordId);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  if (onboarding.isLoading) return <Card className="p-4"><p className="text-sm text-slate-500">Loading…</p></Card>;
  if (onboarding.isError) return <Card className="p-4"><p role="alert" className="text-sm text-red-700">{(onboarding.error as Error).message}</p></Card>;
  const o = onboarding.data!;
  const outstanding = o.items.filter((i) => i.required && (i.state === "outstanding" || i.state === "expired"));
  async function start() {
    setState({ busy: true, error: null });
    try {
      await api.post(`/v1/caregivers/${encodeURIComponent(caregiverRecordId)}/onboarding/start`, { organizationId: activeOrganizationId });
      await refresh();
      setState({ busy: false, error: null });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not started.") });
    }
  }
  return (
    <SummarySection title="Onboarding" defaultOpen={o.onboardingRequired && !o.complete}
      status={o.onboardingRequired ? <ProgressBar done={o.done} total={o.total} /> : undefined}
      summary={o.onboardingRequired ? (o.complete ? "Every required item is satisfied." : `Cannot be Approved or assigned yet. Still outstanding: ${outstanding.map((i) => i.label).join(", ")}.`) : "Not required for this caregiver"}>
      {!o.onboardingRequired ? (
        <div className="text-sm text-slate-700">
          <p className="flex items-center gap-1.5">Not required (added before the checklist).<InfoTip>Added before the onboarding checklist, so it is not required. Their scheduling is unchanged.</InfoTip></p>
          {canManage && status !== "inactive" ? <Button className="mt-1" type="button" variant="secondary" disabled={state.busy} onClick={() => void start()}>Start the checklist</Button> : null}
        </div>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-og-card" aria-label="Onboarding checklist">{o.items.map((i) => <ItemRow key={i.key} caregiverRecordId={caregiverRecordId} item={i} canManage={canManage} />)}</ul>
      )}
      {state.error ? <p role="alert" className="mt-2 text-sm text-red-700">{state.error}</p> : null}
    </SummarySection>
  );
}

function AddApplicant({ onDone }: { onDone: (id: string) => void }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [v, setV] = useState({ first: "", last: "" });
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  async function submit() {
    if (!v.first.trim() || !v.last.trim()) return setState({ busy: false, error: "Enter the first and last name." });
    setState({ busy: true, error: null });
    try {
      const r = await api.post<{ caregiver: { caregiverRecordId: string } }>("/v1/caregivers",
        { organizationId: activeOrganizationId, firstName: v.first.trim(), lastName: v.last.trim(), preferredName: null, status: "applicant" }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      for (const k of ["aws-onboarding-overview", "aws-caregivers"]) await queryClient.invalidateQueries({ queryKey: [k] });
      setV({ first: "", last: "" });
      setState({ busy: false, error: null });
      onDone(r.caregiver.caregiverRecordId);
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The applicant was not added.") });
    }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <div><label htmlFor="ap-first" className="block text-xs font-medium text-slate-700">First name</label><input id="ap-first" autoComplete="off" value={v.first} maxLength={80} onChange={(e) => { setV({ ...v, first: e.target.value }); key.current = newIdempotencyKey(); }} className={inputClass} /></div>
      <div><label htmlFor="ap-last" className="block text-xs font-medium text-slate-700">Last name</label><input id="ap-last" autoComplete="off" value={v.last} maxLength={80} onChange={(e) => { setV({ ...v, last: e.target.value }); key.current = newIdempotencyKey(); }} className={inputClass} /></div>
      <Button type="submit" disabled={state.busy}>{state.busy ? "Adding…" : "Add applicant"}</Button>
      {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-3">{state.error}</p> : null}
    </form>
  );
}

function PersonCard({ r, canManage }: { r: OverviewRow; canManage: boolean }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const next = NEXT_STAGE[r.status];
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  async function move() {
    if (!next) return;
    setState({ busy: true, error: null });
    try {
      await api.post(`/v1/caregivers/${encodeURIComponent(r.caregiverRecordId)}/status`,
        { organizationId: activeOrganizationId, status: next, reason: `Moved to ${CAREGIVER_STATUS_LABEL[next]} from the Recruiting board` }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      for (const k of ["aws-onboarding-overview", "aws-caregivers", "aws-onboarding"]) await queryClient.invalidateQueries({ queryKey: [k] });
      setState({ busy: false, error: null });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not moved.") });
    }
  }
  return (
    <li className="rounded-lg border border-slate-200 bg-og-card px-2 py-1.5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link className="inline-flex min-h-[44px] items-center font-semibold text-slate-950 underline md:min-h-[32px]" to={`/care-team/${r.caregiverRecordId}`}>{r.caregiverName}</Link>
        <ProgressBar done={r.done} total={r.total} />
      </div>
      {r.outstanding.length > 0 ? (
        <p className="text-xs text-amber-900">Outstanding: {r.outstanding.map((o) => (o.state === "expired" ? `${o.label} (expired)` : o.label)).join(", ")}</p>
      ) : <p className="text-xs text-emerald-800">Every required item is satisfied.</p>}
      {r.nextExpiry ? <p className="text-xs text-slate-600">Next expiry {formatDateOnly(r.nextExpiry)}</p> : null}
      {canManage && next ? (
        <div className="mt-1">
          <button type="button" disabled={state.busy} onClick={() => void move()} className={actionBtn}>
            Move to {CAREGIVER_STATUS_LABEL[next]}
          </button>
        </div>
      ) : null}
      {state.error ? <p role="alert" className="mt-1 text-sm text-red-700">{state.error}</p> : null}
    </li>
  );
}

export function RecruitingPage() {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const canManage = hasPermission("caregivers.manage");
  const canSee = canManage || hasPermission("readiness.read");
  const [added, setAdded] = useState<string | null>(null);
  const overview = useQuery({
    queryKey: ["aws-onboarding-overview", activeOrganizationId],
    queryFn: async () => (await api.get<{ caregivers: OverviewRow[] }>("/v1/onboarding/overview", { organizationId: activeOrganizationId })).caregivers,
    enabled: !!activeOrganizationId && canSee,
  });
  if (!canSee) return <p className="text-sm text-slate-600">You do not have access to recruiting.</p>;
  const rows = overview.data ?? [];
  return (
    <div className="max-w-5xl space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link to="/care-team" className="text-sm text-slate-700 underline">← Caregivers</Link>
        <h1 className="text-xl font-bold tracking-tight text-slate-950">Recruiting</h1>
        <InfoTip label="About Recruiting">Nobody can be Approved, assigned or scheduled until every required item is satisfied.</InfoTip>
      </div>
      {canManage ? <AddApplicant onDone={setAdded} /> : null}
      {added ? <p role="status" className="text-sm text-emerald-800">Applicant added. <Link className="underline" to={`/care-team/${added}`}>Open the record</Link>.</p> : null}
      {overview.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {overview.isError ? <p role="alert" className="text-sm text-red-700">{(overview.error as Error).message}</p> : null}
      {overview.data && rows.length === 0 ? <p className="text-sm text-slate-600">Nobody is in the pipeline. Add an applicant above.</p> : null}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {PIPELINE_STAGES.map((stage) => {
          const list = rows.filter((r) => r.status === stage);
          return (
            <section key={stage} aria-label={CAREGIVER_STATUS_LABEL[stage]} className="min-w-0">
              <h2 className="mb-1 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-700">
                <span>{CAREGIVER_STATUS_LABEL[stage]}</span><span className="rounded-full bg-slate-100 px-2 text-xs normal-case text-slate-700">{list.length}</span>
              </h2>
              <ul className="space-y-1">{list.map((r) => <PersonCard key={r.caregiverRecordId} r={r} canManage={canManage} />)}</ul>
              {list.length === 0 ? <p className="text-xs text-slate-500">None</p> : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
