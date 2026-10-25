import { useQueryClient } from "@tanstack/react-query";
import { nameWithCode } from "./name-label";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { AssignmentsCard } from "./assignments-card";
import { useAwsApi } from "./aws-workspace";
import {
  CAREGIVER_STAGES, CAREGIVER_STATUS_BADGE, CAREGIVER_STATUS_LABEL, caregiverName, signInLabel, useCaregivers,
  type Caregiver, type CaregiverStatus,
} from "./care-team-admin";
import { formatDateTime } from "@/lib/service-verification";
import { CaregiverReadiness } from "./readiness/caregiver-readiness";
import { OnboardingCard } from "./recruiting";
import { ReadinessCard } from "./readiness/readiness-card";
import { AvailabilityReview } from "./readiness/availability-review";
import { useCaregiverCompliance } from "./compliance/queries";
import { SummarySection } from "./ui/summary-section";
import { InfoTip } from "./ui/info-tip";
import { CompactAlert } from "./ui/compact-alert";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const inputClass = "mt-0.5 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm";
const STATUSES = CAREGIVER_STAGES;

function useRefreshCareTeam() {
  const queryClient = useQueryClient();
  return async () => {
    for (const k of ["aws-caregivers", "aws-document-people"]) await queryClient.invalidateQueries({ queryKey: [k] });
  };
}

function NameFields({ v, set, idPrefix }: { v: { first: string; last: string; preferred: string }; set: (k: "first" | "last" | "preferred") => (x: string) => void; idPrefix: string }) {
  return (
    <>
      <div><label htmlFor={`${idPrefix}-first`} className="block text-xs font-medium text-slate-700">First name</label><input id={`${idPrefix}-first`} value={v.first} maxLength={80} autoComplete="off" onChange={(e) => set("first")(e.target.value)} className={inputClass} /></div>
      <div><label htmlFor={`${idPrefix}-last`} className="block text-xs font-medium text-slate-700">Last name</label><input id={`${idPrefix}-last`} value={v.last} maxLength={80} autoComplete="off" onChange={(e) => set("last")(e.target.value)} className={inputClass} /></div>
      <div className="sm:col-span-2"><label htmlFor={`${idPrefix}-preferred`} className="block text-xs font-medium text-slate-700">Preferred name (optional)</label><input id={`${idPrefix}-preferred`} value={v.preferred} maxLength={80} autoComplete="off" onChange={(e) => set("preferred")(e.target.value)} className={inputClass} /></div>
    </>
  );
}

function AddCaregiverForm({ onDone }: { onDone: (id: string) => void }) {
  const api = useAwsApi();
  const refresh = useRefreshCareTeam();
  const { activeOrganizationId } = useOrganization();
  const [v, setV] = useState({ first: "", last: "", preferred: "" });
  const [status, setStatus] = useState<Exclude<CaregiverStatus, "inactive" | "interview" | "offer" | "pending_documents">>("applicant");
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  const set = (k: "first" | "last" | "preferred") => (x: string) => { setV((o) => ({ ...o, [k]: x })); key.current = newIdempotencyKey(); };
  async function submit() {
    if (!v.first.trim() || !v.last.trim()) return setState({ busy: false, error: "Enter the caregiver's first and last name." });
    setState({ busy: true, error: null });
    try {
      const r = await api.post<{ caregiver: { caregiverRecordId: string } }>("/v1/caregivers", {
        organizationId: activeOrganizationId, firstName: v.first.trim(), lastName: v.last.trim(), preferredName: v.preferred.trim() || null, status,
      }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await refresh();
      setState({ busy: false, error: null });
      onDone(r.caregiver.caregiverRecordId);
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The caregiver was not added.") });
    }
  }
  return (
    <Card>
      <div className="flex items-center gap-1.5">
        <h2 className="text-sm font-semibold text-slate-950">Add a caregiver</h2>
        <InfoTip>Approved and Active need the onboarding checklist complete. Start a new person as an Applicant or Onboarding, then approve them when the checklist is done.</InfoTip>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-2 grid gap-2 sm:grid-cols-2">
        <NameFields v={v} set={set} idPrefix="new-cg" />
        <div>
          <label htmlFor="new-cg-status" className="block text-xs font-medium text-slate-700">Starting status</label>
          <select id="new-cg-status" value={status} onChange={(e) => { setStatus(e.target.value as typeof status); key.current = newIdempotencyKey(); }} className="mt-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm">
            {(["applicant", "onboarding", "ready", "active"] as const).map((s) => <option key={s} value={s}>{CAREGIVER_STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
        <div className="sm:col-span-2"><Button type="submit" disabled={state.busy}>{state.busy ? "Adding…" : "Add caregiver"}</Button></div>
      </form>
    </Card>
  );
}

/** Care Team (0023): caregiver records, their status and whether they can sign in. */
export function CareTeamPage() {
  const { hasPermission } = useOrganization();
  const canManage = hasPermission("caregivers.manage");
  const caregivers = useCaregivers();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<CaregiverStatus | "current" | "all">("current");
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (caregivers.data ?? []).filter((c) => (status === "all" || (status === "current" ? c.status !== "inactive" : c.status === status))
      && (!s || [caregiverName(c), c.caregiverCode].some((x) => x.toLowerCase().includes(s))));
  }, [caregivers.data, search, status]);
  if (!hasPermission("caregivers.manage") && !hasPermission("visits.manage")) return <p className="text-sm text-slate-600">You do not have access to the Care Team.</p>;
  const counts = (caregivers.data ?? []).reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }), {});
  return (
    <div className="max-w-4xl space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5"><h1 className="text-xl font-bold tracking-tight text-og-ink">Caregivers</h1><InfoTip label="About Caregivers" title="Caregivers">Manage caregiver profiles, services and onboarding.</InfoTip></div>
        {canManage ? <Button type="button" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>{adding ? "Close" : "Add caregiver"}</Button> : null}
      </div>
      {adding ? <AddCaregiverForm onDone={(id) => { setAdding(false); setAdded(id); }} /> : null}
      {added ? <p role="status" className="text-sm text-emerald-800">Caregiver added. <Link className="underline" to={`/care-team/${added}`}>Open the record</Link>.</p> : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex min-w-[220px] flex-1 items-center gap-1.5">
          <label htmlFor="cg-search" className="text-xs font-medium text-slate-700">Search</label>
          <input id="cg-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or code" className="block w-full rounded-lg border border-slate-200 px-2.5 py-1 text-sm md:min-h-8" />
        </div>
        <div className="flex items-center gap-1.5">
          <label htmlFor="cg-status" className="text-xs font-medium text-slate-700">Status</label>
          <select id="cg-status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="rounded-lg border border-slate-200 px-2 py-1 text-sm md:min-h-8">
            <option value="current">Current ({(caregivers.data ?? []).filter((c) => c.status !== "inactive").length})</option>
            {STATUSES.map((s) => <option key={s} value={s}>{CAREGIVER_STATUS_LABEL[s]} ({counts[s] ?? 0})</option>)}
            <option value="all">All ({caregivers.data?.length ?? 0})</option>
          </select>
        </div>
      </div>
      {caregivers.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {caregivers.isError ? <p role="alert" className="text-sm text-red-700">{(caregivers.error as Error).message}</p> : null}
      {caregivers.data && shown.length === 0 ? <p className="text-sm text-slate-600">No caregivers match.</p> : null}
      {shown.length > 0 ? (
        <div className="rounded-lg border border-slate-200 bg-og-card">
          <table className="w-full text-left text-sm" aria-label="Caregivers">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-600">
                <th scope="col" className="w-10 px-3 py-1 text-right font-semibold">No.</th>
                <th scope="col" className="px-3 py-1 font-semibold">Caregiver</th>
                <th scope="col" className="px-3 py-1 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c, i) => (
                <tr key={c.caregiverRecordId} className="border-b border-slate-100 last:border-0">
                  <td className="w-10 px-3 py-1 text-right align-middle tabular-nums text-slate-600" data-testid="row-no">{i + 1}</td>
                  <th scope="row" className="px-3 py-1 font-normal">
                    <Link to={`/care-team/${c.caregiverRecordId}`} className="inline-flex min-h-[44px] flex-wrap items-baseline gap-x-3 gap-y-0 py-0.5 md:min-h-[30px]">
                      <span className="font-semibold text-slate-950 underline">{nameWithCode(caregiverName(c), c.caregiverCode, c.duplicateName)}</span>
                      <span className={`text-xs font-normal ${c.hasSignIn ? "text-slate-700" : "text-amber-900"}`}>
                        {signInLabel(c)} · {c.activeAssignments} active assignment{c.activeAssignments === 1 ? "" : "s"}{c.openVisits > 0 ? ` · ${c.openVisits} visit in progress` : ""}
                      </span>
                    </Link>
                  </th>
                  <td className="px-3 py-1 align-middle"><span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${CAREGIVER_STATUS_BADGE[c.status]}`}>{CAREGIVER_STATUS_LABEL[c.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {/* Status first, then the list, then the control rows: readiness and availability requests are collapsed one-line summaries below the list. */}
      <ReadinessCard />
      <AvailabilityReview />
    </div>
  );
}

function CaregiverDetails({ c }: { c: Caregiver }) {
  const api = useAwsApi();
  const refresh = useRefreshCareTeam();
  const { activeOrganizationId } = useOrganization();
  const [v, setV] = useState({ first: c.firstName, last: c.lastName, preferred: c.preferredName ?? "" });
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  const key = useRef(newIdempotencyKey());
  useEffect(() => setV({ first: c.firstName, last: c.lastName, preferred: c.preferredName ?? "" }), [c.firstName, c.lastName, c.preferredName]);
  const set = (k: "first" | "last" | "preferred") => (x: string) => { setV((o) => ({ ...o, [k]: x })); key.current = newIdempotencyKey(); setState((s) => ({ ...s, done: false })); };
  async function save() {
    if (!v.first.trim() || !v.last.trim()) return setState({ busy: false, error: "Enter the caregiver's first and last name.", done: false });
    setState({ busy: true, error: null, done: false });
    try {
      await api.post(`/v1/caregivers/${encodeURIComponent(c.caregiverRecordId)}/details`, {
        organizationId: activeOrganizationId, firstName: v.first.trim(), lastName: v.last.trim(), preferredName: v.preferred.trim() || null,
      }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await refresh();
      setState({ busy: false, error: null, done: true });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not saved."), done: false });
    }
  }
  return (
    <SummarySection title="Name" summary={caregiverName(c)}>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="grid gap-2 sm:grid-cols-2">
        <NameFields v={v} set={set} idPrefix="edit-cg" />
        {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
        {state.done ? <p role="status" className="text-sm text-emerald-800 sm:col-span-2">Saved. The change is in the record's history.</p> : null}
        <div className="flex items-center gap-2 sm:col-span-2"><Button type="submit" disabled={state.busy}>{state.busy ? "Saving…" : "Save name"}</Button><InfoTip>Past visits keep the name they were recorded with.</InfoTip></div>
      </form>
    </SummarySection>
  );
}

function CaregiverStatusCard({ c }: { c: Caregiver }) {
  const api = useAwsApi();
  const refresh = useRefreshCareTeam();
  const { activeOrganizationId } = useOrganization();
  const options = STATUSES.filter((s) => s !== c.status);
  const [status, setStatus] = useState<CaregiverStatus>(options[0]!);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  const key = useRef(newIdempotencyKey());
  useEffect(() => setStatus(STATUSES.filter((s) => s !== c.status)[0]!), [c.status]);
  async function save() {
    if (reason.trim().length < 3) return setState({ busy: false, error: "Give a reason for the change.", done: null });
    setState({ busy: true, error: null, done: null });
    try {
      const r = await api.post<{ result: { endedAssignments: number; signInStatus: string | null } }>(`/v1/caregivers/${encodeURIComponent(c.caregiverRecordId)}/status`,
        { organizationId: activeOrganizationId, status, reason: reason.trim() }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setReason("");
      await refresh();
      const parts = [`Status changed to ${CAREGIVER_STATUS_LABEL[status]}.`];
      if (r.result.endedAssignments > 0) parts.push(`${r.result.endedAssignments} assignment${r.result.endedAssignments === 1 ? "" : "s"} ended.`);
      if (r.result.signInStatus === "suspended") parts.push("Their sign-in is suspended for this agency.");
      if (status !== "inactive" && c.status === "inactive" && r.result.signInStatus === "active") parts.push("Their sign-in works again. Re-add assignments as needed.");
      setState({ busy: false, error: null, done: parts.join(" ") });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Status not changed."), done: null });
    }
  }
  return (
    <SummarySection title="Status" id="status" status={<span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${CAREGIVER_STATUS_BADGE[c.status]}`}>{CAREGIVER_STATUS_LABEL[c.status]}</span>}>
      <CompactAlert summary="Inactive ends assignments and suspends sign-in">Making a caregiver inactive ends their assignments and suspends their sign-in at once. It is refused during a visit.</CompactAlert>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="mt-2 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="cg-status-new" className="block text-xs font-medium text-slate-700">Change to</label>
          <select id="cg-status-new" value={status} onChange={(e) => { setStatus(e.target.value as CaregiverStatus); key.current = newIdempotencyKey(); }} className="mt-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm">
            {options.map((s) => <option key={s} value={s}>{CAREGIVER_STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        <div className="min-w-[220px] flex-1">
          <label htmlFor="cg-status-reason" className="block text-xs font-medium text-slate-700">Reason</label>
          <input id="cg-status-reason" value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} className={inputClass} />
        </div>
        <Button type="submit" variant="secondary" disabled={state.busy}>{state.busy ? "Saving…" : "Change status"}</Button>
      </form>
      {state.error ? <p role="alert" className="mt-2 text-sm text-red-700">{state.error}</p> : null}
      {state.done ? <p role="status" className="mt-2 text-sm text-emerald-800">{state.done}</p> : null}
    </SummarySection>
  );
}


const fmtWhen = (iso: string) => formatDateTime(iso);

/**
 * Sign-in and invitation (0025). The server checks caregivers.manage, the
 * agency and that only a caregiver sign-in is created; Cognito emails the
 * temporary password, which Ogevia never sees, shows or stores.
 */
function SignInCard({ c, canManage }: { c: Caregiver; canManage: boolean }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["aws-caregivers"] }).then(() => queryClient.invalidateQueries({ queryKey: ["aws-assignments"] }));
  async function invite() {
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return setState({ busy: false, error: "Enter the caregiver's own email address.", done: null });
    setState({ busy: true, error: null, done: null });
    try {
      const r = await api.post<{ invitation: { existingAccount: boolean } }>(`/v1/caregivers/${encodeURIComponent(c.caregiverRecordId)}/invitation`,
        { organizationId: activeOrganizationId, email: value });
      await refresh();
      setEmail("");
      setState({ busy: false, error: null, done: r.invitation.existingAccount
        ? "This email already had an Ogevia sign-in. It is now linked to this caregiver; they sign in with their existing password."
        : "Invitation sent. The caregiver gets an email with a temporary password and sets their own on first sign-in." });
    } catch (cause) {
      setState({ busy: false, error: cause instanceof Error ? cause.message : "The invitation was not sent.", done: null });
    }
  }
  async function resend() {
    setState({ busy: true, error: null, done: null });
    try {
      await api.post(`/v1/caregivers/${encodeURIComponent(c.caregiverRecordId)}/invitation/resend`, { organizationId: activeOrganizationId });
      await refresh();
      setState({ busy: false, error: null, done: "Invitation sent again with a new temporary password." });
    } catch (cause) {
      setState({ busy: false, error: cause instanceof Error ? cause.message : "The invitation was not sent.", done: null });
    }
  }
  const pending = !!c.invitedAt && !c.firstSignedInAt;
  return (
    <SummarySection title="Sign-in" id="sign-in" defaultOpen={!c.hasSignIn || pending}
      summary={`${c.activeAssignments} active assignment${c.activeAssignments === 1 ? "" : "s"}${c.openVisits > 0 ? ` · ${c.openVisits} visit in progress` : ""}`}
      status={<span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${c.hasSignIn && !pending ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>{signInLabel(c)}</span>}>
      <div className="text-sm text-slate-800">
      {c.invitedAt ? (
        <ul className="mt-1 space-y-0.5 text-slate-700">
          <li>Invited {fmtWhen(c.invitedAt)} to <span className="break-all">{c.invitationEmail}</span></li>
          {c.invitationSendCount && c.invitationSendCount > 1 && c.invitationLastSentAt ? <li>Sent {c.invitationSendCount} times, last {fmtWhen(c.invitationLastSentAt)}</li> : null}
          <li>{c.firstSignedInAt ? `First signed in ${fmtWhen(c.firstSignedInAt)}` : "Has not signed in yet"}</li>
        </ul>
      ) : null}
      {c.plannedAssignments ? <p className="mt-1">{c.plannedAssignments} planned, no access yet</p> : null}
      {c.hasSignIn && (c.status === "onboarding") ? <CompactAlert className="mt-1" summary="Onboarding: no clients visible yet">Still onboarding: they can sign in but see no clients until they are Approved or Active.</CompactAlert> : null}
      {canManage && !c.hasSignIn && c.status !== "inactive" ? (
        <form onSubmit={(e) => { e.preventDefault(); void invite(); }} className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
          <div>
            <label htmlFor="invite-email" className="block text-xs font-medium text-slate-700">Caregiver's email</label>
            <input id="invite-email" type="email" autoComplete="off" inputMode="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} className="mt-0.5 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm" />
          </div>
          <Button type="submit" disabled={state.busy}>{state.busy ? "Sending…" : "Send invitation"}</Button>
          <p className="flex items-center gap-1.5 text-xs text-slate-600 sm:col-span-2">Use the caregiver&apos;s own email.<InfoTip>They get a caregiver sign-in for this agency only. Ogevia never shows or stores the temporary password.</InfoTip></p>
        </form>
      ) : null}
      {canManage && pending ? (
        <div className="mt-2 flex items-center gap-2">
          <Button type="button" variant="secondary" disabled={state.busy} onClick={() => void resend()}>{state.busy ? "Sending…" : "Resend invitation"}</Button>
          <InfoTip>Temporary passwords expire. Resend if the caregiver cannot find the email.</InfoTip>
        </div>
      ) : null}
      {state.error ? <p role="alert" className="mt-2 text-red-700">{state.error}</p> : null}
      {state.done ? <p role="status" className="mt-2 text-emerald-800">{state.done}</p> : null}
      </div>
    </SummarySection>
  );
}

/** One caregiver record (0023). */
const HIRE_LABEL = { direct_hire: "Direct Hire", eor: "EOR (employer of record)" } as const;
const SCHEDULING_LABEL = { fixed: "Fixed — works scheduled shifts", flexible: "Flexible — authorized visits without a scheduled shift" } as const;

/** 0030: hire type and scheduling arrangement are separate facts; neither implies a family relationship. */
function EmploymentCard({ c, canManage }: { c: Caregiver; canManage: boolean }) {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [hire, setHire] = useState<string>(c.hireType ?? "");
  const [mode, setMode] = useState<string>(c.schedulingMode ?? "fixed");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  const key = useRef(newIdempotencyKey());
  async function save() {
    setState({ busy: true, error: null, done: null });
    try {
      await api.post(`/v1/caregivers/${encodeURIComponent(c.caregiverRecordId)}/employment`, { organizationId: activeOrganizationId, hireType: hire || null, schedulingMode: mode },
        { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await qc.invalidateQueries({ queryKey: ["aws-caregivers"] });
      setState({ busy: false, error: null, done: "Saved. Visit rules are unchanged: sign-in, assignment, authorization, confirmation and hour limits still apply." });
    } catch (cause) { setState({ busy: false, error: cause instanceof Error ? cause.message : "Not saved.", done: null }); }
  }
  return (
    <SummarySection title="Hire type and scheduling" summary={`${c.hireType ? HIRE_LABEL[c.hireType] : "Hire type not recorded"} · ${c.schedulingMode === "flexible" ? "Flexible" : "Fixed"}`}>
      {!canManage ? (
        <p className="mt-1 text-sm text-slate-700">{c.hireType ? HIRE_LABEL[c.hireType] : "Hire type not recorded"} · {SCHEDULING_LABEL[c.schedulingMode ?? "fixed"]}</p>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="grid gap-2 sm:grid-cols-2">
          <div><label htmlFor="emp-hire" className="block text-xs font-medium text-slate-700">Hire type</label>
            <select id="emp-hire" value={hire} onChange={(e) => { setHire(e.target.value); key.current = newIdempotencyKey(); }} className="mt-0.5 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm">
              <option value="">Not recorded</option><option value="direct_hire">{HIRE_LABEL.direct_hire}</option><option value="eor">{HIRE_LABEL.eor}</option>
            </select></div>
          <div><label htmlFor="emp-mode" className="block text-xs font-medium text-slate-700">Scheduling</label>
            <select id="emp-mode" value={mode} onChange={(e) => { setMode(e.target.value); key.current = newIdempotencyKey(); }} className="mt-0.5 block w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm">
              <option value="fixed">{SCHEDULING_LABEL.fixed}</option><option value="flexible">{SCHEDULING_LABEL.flexible}</option>
            </select></div>
          <p className="flex items-center gap-1.5 text-xs text-slate-600 sm:col-span-2">Family relationship is recorded per client on each assignment.<InfoTip>EOR does not mean family, and Direct Hire does not require fixed shifts.</InfoTip></p>
          {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
          {state.done ? <p role="status" className="text-sm text-emerald-800 sm:col-span-2">{state.done}</p> : null}
          <div className="sm:col-span-2"><Button type="submit" variant="secondary" disabled={state.busy}>{state.busy ? "Saving…" : "Save hire type and scheduling"}</Button></div>
        </form>
      )}
    </SummarySection>
  );
}

/** The overall outcome first, then each item to fix with its action. Everything shown here comes from data the sections below already load. */
function CaregiverOutcome({ c, canManage }: { c: Caregiver; canManage: boolean }) {
  const { hasPermission } = useOrganization();
  const canRead = hasPermission("readiness.read") || hasPermission("caregivers.manage") || hasPermission("caregivers.compliance.manage");
  const comp = useCaregiverCompliance(c.caregiverRecordId, canRead);
  const pending = !!c.invitedAt && !c.firstSignedInAt;
  const items: Array<{ text: string; to: string; label: string }> = [];
  if (c.status === "inactive") items.push({ text: "Inactive: cannot be scheduled", to: "#status", label: "Change status" });
  else if (c.status !== "ready" && c.status !== "active") items.push({ text: `Status is ${CAREGIVER_STATUS_LABEL[c.status]}; it must be Approved or Active`, to: "#status", label: "Change status" });
  if (c.status !== "inactive" && (!c.hasSignIn || pending)) items.push({ text: pending ? "Invited, but has not signed in" : "Cannot sign in until invited", to: "#sign-in", label: canManage ? (pending ? "Resend invitation" : "Send invitation") : "See sign-in" });
  const hold = comp.data?.hold ?? null;
  if (hold) items.push({ text: `On compliance hold: ${hold.reasons.map((r) => r.message).join("; ")}`, to: "#compliance", label: "Fix" });
  else if (comp.data && !comp.data.eligible && comp.data.enforcementActive) items.push({ text: "Not eligible for new work", to: "#compliance", label: "Fix" });
  const unknown = canRead && comp.isError;
  const ready = items.length === 0 && !unknown && (comp.data !== undefined || !canRead);
  const headline = ready ? "Ready to schedule" : hold ? `On hold: ${hold.reasons[0]?.message ?? "compliance"}` : items.length > 0 ? `Not ready: ${items.length} item${items.length === 1 ? "" : "s"} to fix` : unknown ? "Compliance could not be checked, so readiness is unknown. Reload the page." : "Checking…";
  return (
    <section aria-label="Caregiver outcome" data-testid="caregiver-outcome" className="space-y-1">
      <p className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-sm font-semibold ${ready ? "bg-emerald-100 text-emerald-900" : hold ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-900"}`}>
          <span aria-hidden="true">{ready ? "✓" : "⚠"}</span><span>{headline}</span>
        </span>
      </p>
      {items.length > 0 ? (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-og-card">
          {items.map((i) => (
            <li key={i.text} className="flex flex-wrap items-center gap-x-3 gap-y-0 px-2 py-1 text-sm">
              <span className="min-w-0 flex-1 text-slate-900">{i.text}</span>
              <a className="inline-flex min-h-[44px] items-center font-semibold text-slate-900 underline md:min-h-[32px]" href={i.to}>{i.label}</a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function CaregiverDetailPage() {
  const { caregiverRecordId } = useParams<{ caregiverRecordId: string }>();
  const { hasPermission } = useOrganization();
  const caregivers = useCaregivers();
  if (!hasPermission("caregivers.manage") && !hasPermission("visits.manage")) return <p className="text-sm text-slate-600">You do not have access to the Care Team.</p>;
  if (caregivers.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (caregivers.isError) return <p role="alert" className="text-sm text-red-700">{(caregivers.error as Error).message}</p>;
  const c = caregivers.data?.find((x) => x.caregiverRecordId === caregiverRecordId);
  if (!c) return <p className="text-sm text-slate-600">Caregiver not found. <Link to="/care-team" className="underline">Back to the Care Team</Link></p>;
  const canManage = hasPermission("caregivers.manage");
  return (
    <div className="max-w-3xl space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link to="/care-team" className="text-sm text-slate-700 underline">← Care Team</Link>
        <h1 className="text-xl font-bold tracking-tight text-slate-950">{caregiverName(c)}</h1>
        <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${CAREGIVER_STATUS_BADGE[c.status]}`}>{CAREGIVER_STATUS_LABEL[c.status]}</span>
        <span className="text-xs text-slate-500">{c.caregiverCode}</span>
      </div>
      <CaregiverOutcome c={c} canManage={canManage} />
      {canManage ? <OnboardingCard caregiverRecordId={c.caregiverRecordId} status={c.status} canManage={canManage} /> : null}
      <SignInCard c={c} canManage={canManage} />
      <AssignmentsCard caregiverRecordId={c.caregiverRecordId} />
      <CaregiverReadiness caregiverRecordId={c.caregiverRecordId} />
      <EmploymentCard c={c} canManage={canManage} />
      {canManage ? <CaregiverDetails c={c} /> : null}
      {canManage ? <CaregiverStatusCard c={c} /> : null}
    </div>
  );
}
