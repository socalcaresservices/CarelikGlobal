import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { AssignmentsCard } from "./assignments-card";
import { useAwsApi } from "./aws-workspace";
import {
  CAREGIVER_STATUS_BADGE, CAREGIVER_STATUS_LABEL, caregiverName, signInLabel, useCaregivers,
  type Caregiver, type CaregiverStatus,
} from "./care-team-admin";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const inputClass = "mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base";
const STATUSES = ["onboarding", "ready", "active", "inactive"] as const;

function useRefreshCareTeam() {
  const queryClient = useQueryClient();
  return async () => {
    for (const k of ["aws-caregivers", "aws-document-people"]) await queryClient.invalidateQueries({ queryKey: [k] });
  };
}

function NameFields({ v, set, idPrefix }: { v: { first: string; last: string; preferred: string }; set: (k: "first" | "last" | "preferred") => (x: string) => void; idPrefix: string }) {
  return (
    <>
      <div><label htmlFor={`${idPrefix}-first`} className="block text-sm font-medium text-slate-700">First name</label><input id={`${idPrefix}-first`} value={v.first} maxLength={80} autoComplete="off" onChange={(e) => set("first")(e.target.value)} className={inputClass} /></div>
      <div><label htmlFor={`${idPrefix}-last`} className="block text-sm font-medium text-slate-700">Last name</label><input id={`${idPrefix}-last`} value={v.last} maxLength={80} autoComplete="off" onChange={(e) => set("last")(e.target.value)} className={inputClass} /></div>
      <div className="sm:col-span-2"><label htmlFor={`${idPrefix}-preferred`} className="block text-sm font-medium text-slate-700">Preferred name (optional)</label><input id={`${idPrefix}-preferred`} value={v.preferred} maxLength={80} autoComplete="off" onChange={(e) => set("preferred")(e.target.value)} className={inputClass} /></div>
    </>
  );
}

function AddCaregiverForm({ onDone }: { onDone: (id: string) => void }) {
  const api = useAwsApi();
  const refresh = useRefreshCareTeam();
  const { activeOrganizationId } = useOrganization();
  const [v, setV] = useState({ first: "", last: "", preferred: "" });
  const [status, setStatus] = useState<Exclude<CaregiverStatus, "inactive">>("onboarding");
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
    <Card className="p-4">
      <h2 className="text-base font-semibold text-slate-950">Add a caregiver</h2>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-3 grid gap-3 sm:grid-cols-2">
        <NameFields v={v} set={set} idPrefix="new-cg" />
        <div>
          <label htmlFor="new-cg-status" className="block text-sm font-medium text-slate-700">Starting status</label>
          <select id="new-cg-status" value={status} onChange={(e) => { setStatus(e.target.value as typeof status); key.current = newIdempotencyKey(); }} className="mt-1 rounded-lg border border-slate-200 px-3 py-2 text-base">
            {(["onboarding", "ready", "active"] as const).map((s) => <option key={s} value={s}>{CAREGIVER_STATUS_LABEL[s]}</option>)}
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
    <div className="max-w-4xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-950">Care Team</h1>
          <p className="mt-1 text-sm text-slate-600">Caregiver records, their status and whether they can sign in.</p>
        </div>
        {canManage ? <Button type="button" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>{adding ? "Close" : "Add caregiver"}</Button> : null}
      </div>
      {adding ? <AddCaregiverForm onDone={(id) => { setAdding(false); setAdded(id); }} /> : null}
      {added ? <p role="status" className="text-sm text-emerald-800">Caregiver added. <Link className="underline" to={`/care-team/${added}`}>Open the record</Link>.</p> : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <label htmlFor="cg-search" className="block text-sm font-medium text-slate-700">Search</label>
          <input id="cg-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or code" className={inputClass} />
        </div>
        <div>
          <label htmlFor="cg-status" className="block text-sm font-medium text-slate-700">Status</label>
          <select id="cg-status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="mt-1 rounded-lg border border-slate-200 px-3 py-2 text-base">
            <option value="current">Current ({(caregivers.data ?? []).filter((c) => c.status !== "inactive").length})</option>
            {STATUSES.map((s) => <option key={s} value={s}>{CAREGIVER_STATUS_LABEL[s]} ({counts[s] ?? 0})</option>)}
            <option value="all">All ({caregivers.data?.length ?? 0})</option>
          </select>
        </div>
      </div>
      {caregivers.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {caregivers.isError ? <p role="alert" className="text-sm text-red-700">{(caregivers.error as Error).message}</p> : null}
      {caregivers.data && shown.length === 0 ? <p className="text-sm text-slate-600">No caregivers match.</p> : null}
      <ul className="space-y-2">
        {shown.map((c) => (
          <li key={c.caregiverRecordId}>
            <Link to={`/care-team/${c.caregiverRecordId}`} className="block rounded-xl border border-slate-200 bg-white p-3 hover:border-slate-400">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold text-slate-950">{caregiverName(c)} <span className="font-normal text-slate-500">({c.caregiverCode})</span></p>
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${CAREGIVER_STATUS_BADGE[c.status]}`}>{CAREGIVER_STATUS_LABEL[c.status]}</span>
              </div>
              <p className={`mt-1 text-sm ${c.hasSignIn ? "text-slate-700" : "text-amber-900"}`}>
                {signInLabel(c)} · {c.activeAssignments} active assignment{c.activeAssignments === 1 ? "" : "s"}{c.openVisits > 0 ? ` · ${c.openVisits} visit in progress` : ""}
              </p>
            </Link>
          </li>
        ))}
      </ul>
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
    <Card className="p-4">
      <h2 className="text-base font-semibold text-slate-950">Name</h2>
      <p className="mt-1 text-xs text-slate-600">Past visits keep the name they were recorded with.</p>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="mt-3 grid gap-3 sm:grid-cols-2">
        <NameFields v={v} set={set} idPrefix="edit-cg" />
        {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
        {state.done ? <p role="status" className="text-sm text-emerald-800 sm:col-span-2">Saved. The change is in the record's history.</p> : null}
        <div className="sm:col-span-2"><Button type="submit" disabled={state.busy}>{state.busy ? "Saving…" : "Save name"}</Button></div>
      </form>
    </Card>
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
    <Card className="p-4">
      <h2 className="text-base font-semibold text-slate-950">Status</h2>
      <p className="mt-1 text-sm text-slate-600">
        Making a caregiver inactive ends their active assignments and suspends their sign-in for this agency straight away. It is refused while they have a visit in progress.
      </p>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="cg-status-new" className="block text-sm font-medium text-slate-700">Change to</label>
          <select id="cg-status-new" value={status} onChange={(e) => { setStatus(e.target.value as CaregiverStatus); key.current = newIdempotencyKey(); }} className="mt-1 rounded-lg border border-slate-200 px-3 py-2 text-base">
            {options.map((s) => <option key={s} value={s}>{CAREGIVER_STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        <div className="min-w-[220px] flex-1">
          <label htmlFor="cg-status-reason" className="block text-sm font-medium text-slate-700">Reason</label>
          <input id="cg-status-reason" value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} className={inputClass} />
        </div>
        <Button type="submit" variant="secondary" disabled={state.busy}>{state.busy ? "Saving…" : "Change status"}</Button>
      </form>
      {state.error ? <p role="alert" className="mt-2 text-sm text-red-700">{state.error}</p> : null}
      {state.done ? <p role="status" className="mt-2 text-sm text-emerald-800">{state.done}</p> : null}
    </Card>
  );
}

/** One caregiver record (0023). */
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
    <div className="max-w-3xl space-y-4">
      <Link to="/care-team" className="text-sm text-slate-700 underline">← Care Team</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-950">{caregiverName(c)}</h1>
        <span className="text-sm text-slate-500">{c.caregiverCode}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${CAREGIVER_STATUS_BADGE[c.status]}`}>{CAREGIVER_STATUS_LABEL[c.status]}</span>
      </div>
      <Card className="p-4 text-sm text-slate-800">
        <p><span className="font-semibold">{signInLabel(c)}.</span> {c.hasSignIn ? "" : "Inviting a caregiver to sign in is not available on this screen yet."}</p>
        <p className="mt-1">{c.activeAssignments} active assignment{c.activeAssignments === 1 ? "" : "s"}{c.openVisits > 0 ? ` · ${c.openVisits} visit in progress` : ""}</p>
      </Card>
      <AssignmentsCard caregiverRecordId={c.caregiverRecordId} />
      {canManage ? <CaregiverDetails c={c} /> : null}
      {canManage ? <CaregiverStatusCard c={c} /> : null}
    </div>
  );
}
