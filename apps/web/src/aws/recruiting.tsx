// Recruiting and onboarding (0054): the pipeline (Applicant to Pending documents), each person's checklist and progress, and
// exactly what is still outstanding. Every rule (the checklist, the approval gate, the assignment gate) is enforced again by
// the server; these screens only show it. The checklist stores dates and status only: no results, reports or personal details.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@carelik/ui";
import { formatDateOnly } from "@/lib/service-verification";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { CAREGIVER_STATUS_LABEL, PIPELINE_STAGES, type CaregiverStatus } from "./care-team-admin";
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

/** The stage a person moves to next. After Pending documents the one remaining step is Approve for work on the caregiver's page (0086); it is not a stage move. */
const NEXT_STAGE: Partial<Record<CaregiverStatus, CaregiverStatus>> = { applicant: "interview", interview: "offer", offer: "onboarding", onboarding: "pending_documents" };

export function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="flex items-center gap-2" role="img" aria-label={`${done} of ${total} requirements satisfied`}>
      <div className="h-2 w-28 overflow-hidden rounded-full bg-slate-200"><div className={`h-full ${done === total && total > 0 ? "bg-emerald-600" : "bg-teal-700"}`} style={{ width: `${pct}%` }} /></div>
      <span className="text-xs tabular-nums text-slate-700">{done}/{total}</span>
    </div>
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
      {canManage && r.status === "pending_documents" ? (
        <p className="mt-1"><Link className="inline-flex min-h-[44px] items-center font-semibold text-slate-900 underline md:min-h-[32px]" to={`/care-team/${r.caregiverRecordId}`}>Open the record to approve</Link></p>
      ) : null}
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
