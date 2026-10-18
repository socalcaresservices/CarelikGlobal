import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { useAssignments } from "./assignments-data";
import { caregiverName, useCaregivers } from "./care-team-admin";
import { clientName, useClients, useServices } from "./client-admin";
import { formatDateOnly } from "@/lib/service-verification";
import { ShortHelp } from "./help-text";
import { SummarySection } from "./ui/summary-section";

/**
 * Assignments (0024): which caregiver may serve which client for which
 * service, by date. Shown on the client page (pick a caregiver) and on the
 * caregiver page (pick a client). Every rule is enforced again by the server.
 */
export interface Assignment {
  assignmentId: string;
  caregiverRecordId: string | null;
  caregiverCode: string | null;
  caregiverName: string | null;
  clientId: string;
  clientCode: string;
  clientName: string | null;
  serviceId: string;
  serviceCode: string;
  serviceName: string;
  effectiveStart: string;
  effectiveEnd: string | null;
  state: "current" | "upcoming" | "ended";
  hasAuthorization: boolean;
  /** False while the caregiver has no sign-in or is not ready/active yet (planned). */
  grantsAccess?: boolean;
  /** 0030: the caregiver's family relationship to THIS client; null = not recorded. */
  familyRelationship?: FamilyRelationship | null;
}
type FamilyRelationship = "none" | "parent" | "spouse_partner" | "child" | "sibling" | "grandparent" | "grandchild" | "other_relative";
const RELATIONSHIP_LABEL: Record<FamilyRelationship, string> = {
  none: "Not a family member", parent: "Parent", spouse_partner: "Spouse or partner", child: "Child", sibling: "Sibling",
  grandparent: "Grandparent", grandchild: "Grandchild", other_relative: "Other relative",
};

function RelationshipField({ a, canManage }: { a: Assignment; canManage: boolean }) {
  const api = useAwsApi();
  const refresh = useRefreshAssignments();
  const { activeOrganizationId } = useOrganization();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = `rel-${a.assignmentId.slice(0, 8)}`;
  const current = a.familyRelationship ?? "";
  if (!canManage) return <p className="mt-1 text-sm text-slate-700">Family relationship: {a.familyRelationship ? RELATIONSHIP_LABEL[a.familyRelationship] : "not recorded"}</p>;
  async function change(value: string) {
    setBusy(true); setError(null);
    try {
      await api.post(`/v1/assignments/${encodeURIComponent(a.assignmentId)}/family-relationship`, { organizationId: activeOrganizationId, relationship: value || null },
        { idempotencyKey: newIdempotencyKey() });
      await refresh();
    } catch (cause) { setError(message(cause, "Not saved.")); } finally { setBusy(false); }
  }
  return (
    <div className="mt-2">
      <label htmlFor={id} className="block text-xs font-medium text-slate-600">Family relationship to this client</label>
      <select id={id} value={current} disabled={busy} onChange={(e) => void change(e.target.value)} className={inputClass}>
        <option value="">Not recorded</option>
        {(Object.keys(RELATIONSHIP_LABEL) as FamilyRelationship[]).map((k) => <option key={k} value={k}>{RELATIONSHIP_LABEL[k]}</option>)}
      </select>
      {error ? <p role="alert" className="mt-1 text-sm text-red-700">{error}</p> : null}
    </div>
  );
}

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const inputClass = "mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base";
const fmtDate = (d: string) => formatDateOnly(d);
const STATE_LABEL = { current: "Current", upcoming: "Starts later", ended: "Ended" } as const;
const STATE_BADGE = { current: "bg-emerald-100 text-emerald-900", upcoming: "bg-sky-100 text-sky-900", ended: "bg-slate-200 text-slate-800" } as const;

function useAgencyToday() {
  const { activeOrganization } = useOrganization();
  const tz = (activeOrganization as { timezone?: string } | null)?.timezone || "America/Los_Angeles";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}

function useRefreshAssignments() {
  const queryClient = useQueryClient();
  return async () => {
    for (const k of ["aws-assignments", "aws-caregivers", "aws-clients"]) await queryClient.invalidateQueries({ queryKey: [k] });
  };
}

type Added = { covered: boolean; grantsAccess: boolean };

function AddAssignmentForm({ clientId, caregiverRecordId, onDone }: { clientId?: string | undefined; caregiverRecordId?: string | undefined; onDone: (added: Added) => void }) {
  const api = useAwsApi();
  const refresh = useRefreshAssignments();
  const today = useAgencyToday();
  const { activeOrganizationId } = useOrganization();
  const caregivers = useCaregivers();
  const clients = useClients();
  const services = useServices();
  const [pick, setPick] = useState("");
  const [service, setService] = useState("");
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  const touch = () => { key.current = newIdempotencyKey(); };
  const pickingCaregiver = !caregiverRecordId;
  const eligibleCaregivers = (caregivers.data ?? []).filter((c) => c.status !== "inactive");
  async function submit() {
    if (!pick) return setState({ busy: false, error: pickingCaregiver ? "Choose the caregiver." : "Choose the client." });
    if (!service) return setState({ busy: false, error: "Choose the service." });
    if (!start) return setState({ busy: false, error: "Enter the start date." });
    if (end && end < start) return setState({ busy: false, error: "The end date cannot be before the start date." });
    setState({ busy: true, error: null });
    try {
      const r = await api.post<{ assignment: { assignmentId: string; hasAuthorization: boolean; grantsAccess?: boolean } }>("/v1/assignments", {
        organizationId: activeOrganizationId,
        caregiverRecordId: caregiverRecordId ?? pick,
        clientId: clientId ?? pick,
        serviceId: service, effectiveStart: start, effectiveEnd: end || null,
      }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await refresh();
      setState({ busy: false, error: null });
      onDone({ covered: r.assignment.hasAuthorization, grantsAccess: r.assignment.grantsAccess !== false });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The assignment was not added.") });
    }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-3 grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
      {pickingCaregiver ? (
        <div className="sm:col-span-2">
          <label htmlFor="asg-caregiver" className="block text-sm font-medium text-slate-700">Caregiver</label>
          <select id="asg-caregiver" value={pick} onChange={(e) => { setPick(e.target.value); touch(); }} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-base">
            <option value="">Choose a caregiver</option>
            {eligibleCaregivers.map((c) => (
              <option key={c.caregiverRecordId} value={c.caregiverRecordId}>
                {caregiverName(c)} ({c.caregiverCode}){!c.hasSignIn ? " — planned: no sign-in yet" : c.status === "onboarding" ? " — planned: still onboarding" : ""}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="sm:col-span-2">
          <label htmlFor="asg-client" className="block text-sm font-medium text-slate-700">Client</label>
          <select id="asg-client" value={pick} onChange={(e) => { setPick(e.target.value); touch(); }} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-base">
            <option value="">Choose a client</option>
            {(clients.data ?? []).filter((c) => c.status === "active").map((c) => (
              <option key={c.clientId} value={c.clientId}>{clientName(c) ?? "Name not set"} ({c.clientCode})</option>
            ))}
          </select>
        </div>
      )}
      <div className="sm:col-span-2">
        <label htmlFor="asg-service" className="block text-sm font-medium text-slate-700">Service</label>
        <select id="asg-service" value={service} onChange={(e) => { setService(e.target.value); touch(); }} className="mt-1 rounded-lg border border-slate-200 px-3 py-2 text-base">
          <option value="">Choose a service</option>
          {(services.data ?? []).filter((s) => s.isActive).map((s) => <option key={s.serviceId} value={s.serviceId}>{s.name} ({s.code})</option>)}
        </select>
      </div>
      <div><label htmlFor="asg-start" className="block text-sm font-medium text-slate-700">First day</label><input id="asg-start" type="date" value={start} onChange={(e) => { setStart(e.target.value); touch(); }} className={inputClass} /></div>
      <div><label htmlFor="asg-end" className="block text-sm font-medium text-slate-700">Last day (optional)</label><input id="asg-end" type="date" value={end} min={start} onChange={(e) => { setEnd(e.target.value); touch(); }} className={inputClass} /></div>
      {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
      <div className="sm:col-span-2"><Button type="submit" disabled={state.busy}>{state.busy ? "Assigning…" : "Assign"}</Button></div>
    </form>
  );
}

function EndForm({ a, onDone }: { a: Assignment; onDone: (text: string) => void }) {
  const api = useAwsApi();
  const refresh = useRefreshAssignments();
  const today = useAgencyToday();
  const { activeOrganizationId } = useOrganization();
  const upcoming = a.state === "upcoming";
  const [last, setLast] = useState(today);
  const [reason, setReason] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const key = useRef(newIdempotencyKey());
  const id = `end-${a.assignmentId.slice(0, 8)}`;
  async function submit() {
    if (reason.trim().length < 3) return setState({ busy: false, error: "Give a reason." });
    if (!upcoming && !last) return setState({ busy: false, error: "Enter the last day." });
    setState({ busy: true, error: null });
    try {
      const r = await api.post<{ outcome: string }>(`/v1/assignments/${encodeURIComponent(a.assignmentId)}/end`,
        { organizationId: activeOrganizationId, lastDay: upcoming ? null : last, reason: reason.trim() }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      await refresh();
      onDone(r.outcome === "cancelled" ? "Assignment cancelled." : r.outcome === "ended" ? "Assignment ended. Access has stopped." : `Assignment ends after ${fmtDate(last)}.`);
    } catch (cause) {
      setState({ busy: false, error: message(cause, "Not saved.") });
    }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="mt-2 grid gap-2 sm:grid-cols-2">
      {upcoming ? <p className="text-sm text-slate-700 sm:col-span-2">This assignment has not started, so it will be cancelled.</p> : (
        <div><label htmlFor={`${id}-last`} className="block text-xs font-medium text-slate-600">Last day of work</label><input id={`${id}-last`} type="date" value={last} min={a.effectiveStart} onChange={(e) => { setLast(e.target.value); key.current = newIdempotencyKey(); }} className={inputClass} /></div>
      )}
      <div className={upcoming ? "sm:col-span-2" : ""}><label htmlFor={`${id}-reason`} className="block text-xs font-medium text-slate-600">Reason for ending</label><input id={`${id}-reason`} value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); key.current = newIdempotencyKey(); }} className={inputClass} /></div>
      {state.error ? <p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p> : null}
      <div className="sm:col-span-2"><Button type="submit" variant="secondary" disabled={state.busy}>{upcoming ? "Cancel assignment" : "End assignment"}</Button></div>
    </form>
  );
}

function AssignmentRow({ a, side, canManage, onDone }: { a: Assignment; side: "client" | "caregiver"; canManage: boolean; onDone?: (text: string) => void }) {
  const [ending, setEnding] = useState(false);
  const who = side === "client"
    ? (a.caregiverRecordId ? <Link className="underline" to={`/care-team/${a.caregiverRecordId}`}>{a.caregiverName} ({a.caregiverCode})</Link> : "Caregiver record not found")
    : <Link className="underline" to={`/clients/${a.clientId}`}>{a.clientName ?? "Name not set"} ({a.clientCode})</Link>;
  return (
    <li className="rounded-lg border border-slate-200 bg-og-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-slate-950">{who}</p>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATE_BADGE[a.state]}`}>{STATE_LABEL[a.state]}</span>
      </div>
      <p className="text-sm text-slate-800">{a.serviceName} ({a.serviceCode}) · from {fmtDate(a.effectiveStart)}{a.effectiveEnd ? ` to ${fmtDate(a.effectiveEnd)}` : ", no end date"}</p>
      {a.state !== "ended" && a.grantsAccess === false ? (
        <p className="mt-1 text-sm font-semibold text-amber-900">Planned: no access yet. It starts once the caregiver has signed in and is Approved or Active.</p>
      ) : null}
      {a.state !== "ended" && !a.hasAuthorization ? (
        <p className="mt-1 text-sm font-semibold text-red-700">No current authorization covers this client and service. Add one or visits are refused.</p>
      ) : null}
      {a.state !== "ended" ? (
        <details className="mt-1">
          <summary className="inline-flex min-h-[44px] cursor-pointer items-center text-sm font-medium text-slate-800 underline">{canManage ? "Relationship and end" : "Relationship"}</summary>
          <RelationshipField a={a} canManage={canManage} />
          {canManage && !ending ? (
            <button type="button" className="mt-2 inline-flex min-h-[44px] items-center text-sm font-medium text-slate-800 underline" onClick={() => setEnding(true)}>{a.state === "upcoming" ? "Cancel" : "End"}</button>
          ) : null}
          {ending ? <EndForm a={a} onDone={(t) => { setEnding(false); onDone?.(t); }} /> : null}
        </details>
      ) : null}
    </li>
  );
}

export function AssignmentsCard({ clientId, caregiverRecordId }: { clientId?: string; caregiverRecordId?: string }) {
  const { hasPermission } = useOrganization();
  const canManage = hasPermission("assignments.manage");
  const side = clientId ? "client" : "caregiver";
  const assignments = useAssignments({ clientId, caregiverRecordId });
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<Added | null>(null);
  const [endedText, setEndedText] = useState<string | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const all = assignments.data ?? [];
  const open = all.filter((a) => a.state !== "ended");
  const ended = all.filter((a) => a.state === "ended");
  const title = side === "client" ? "Caregivers assigned" : "Clients assigned";
  const unfunded = open.filter((a) => !a.hasAuthorization).length;
  const body = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {side === "client" ? <h3 className="text-sm font-semibold text-slate-950">{title}</h3> : <span />}
        {canManage ? <Button type="button" variant="secondary" onClick={() => { setAdding((x) => !x); setAdded(null); setEndedText(null); }} aria-expanded={adding}>{adding ? "Close" : "Assign"}</Button> : null}
      </div>
      <ShortHelp className="mt-1 text-xs text-slate-600"
        details={`You can plan an assignment before the caregiver has a sign-in; it gives no access until they have signed in and are Approved or Active.`}>
        An assignment lets the caregiver see {side === "client" ? "this client" : "this person's clients"} and verify visits for that service between the first and last day.
      </ShortHelp>
      {adding ? <AddAssignmentForm clientId={clientId} caregiverRecordId={caregiverRecordId} onDone={(result) => { setAdding(false); setAdded(result); }} /> : null}
      {added !== null ? (
        <p role="status" className={`mt-2 text-sm ${added.covered ? "text-emerald-800" : "font-semibold text-red-700"}`}>
          {added.grantsAccess ? "Assigned." : "Planned. Access starts once the caregiver has signed in and is Approved or Active."}
          {added.covered ? "" : " No current authorization covers it; visits will be refused until one is added."}
        </p>
      ) : null}
      {endedText ? <p role="status" className="mt-2 text-sm text-emerald-800">{endedText}</p> : null}
      {assignments.isLoading ? <p className="mt-2 text-sm text-slate-500">Loading…</p> : null}
      {assignments.isError ? <p role="alert" className="mt-2 text-sm text-red-700">{(assignments.error as Error).message}</p> : null}
      {assignments.data && open.length === 0 ? <p className="mt-2 text-sm text-slate-600">No current or upcoming assignments.</p> : null}
      <ul className="mt-2 space-y-2">{open.map((a) => <AssignmentRow key={a.assignmentId} a={a} side={side} canManage={canManage} onDone={(t) => { setEndedText(t); setAdded(null); }} />)}</ul>
      {ended.length > 0 ? (
        <div className="mt-2">
          <button type="button" className="min-h-[44px] text-sm text-slate-700 underline" aria-expanded={showEnded} onClick={() => setShowEnded((x) => !x)}>
            {showEnded ? "Hide" : "Show"} ended assignments ({ended.length})
          </button>
          {showEnded ? <ul className="mt-2 space-y-2">{ended.map((a) => <AssignmentRow key={a.assignmentId} a={a} side={side} canManage={false} />)}</ul> : null}
        </div>
      ) : null}
    </>
  );
  if (side === "client") return <div>{body}</div>;
  return (
    <SummarySection title={title} defaultOpen={unfunded > 0}
      status={unfunded > 0 ? <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">{unfunded} without authorization</span> : undefined}
      summary={assignments.data ? `${open.length} current or upcoming` : undefined}>
      {body}
    </SummarySection>
  );
}
