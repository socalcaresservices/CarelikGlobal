import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { formatDateOnly, formatDateTime } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";
import { WORK_STATUS_BADGE, WORK_STATUS_LABEL } from "../care-team-admin";
import { OVERRIDE_BADGE_TEXT, useCaregiverReadiness, type ReadinessItem } from "./readiness-data";
import { ProfileRow, StatusChip, rowButton } from "../profile-ui";
import { chipFor } from "./readiness-chip";
import { ApproveOverrideDialog, OverrideDetails } from "./readiness-override";
import { useReadinessOverrides } from "./readiness-overrides-data";

interface ComplianceRead {
  eligible: boolean;
  background: { qualifies: boolean; state: string };
  requirements: { requirement: string; blocking: boolean; message: string | null }[];
  hold: { reasons: { requirement: string; message: string }[] } | null;
}

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const inputClass = "mt-0.5 block w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm";
const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-900 hover:bg-slate-50 disabled:opacity-50 md:min-h-[32px]";

function useRefreshReadiness() {
  const qc = useQueryClient();
  return async () => {
    for (const k of ["caregiver-readiness", "aws-caregivers", "aws-staff", "aws-accounts", "caregiver-compliance", "compliance-holds", "document-readiness"]) await qc.invalidateQueries({ queryKey: [k] });
  };
}

/** What a row says on its second line. Dates come from the server as YYYY-MM-DD and are never passed through a time zone. */
function line(i: ReadinessItem): string {
  const by = i.actorName ? ` by ${i.actorName}` : "";
  if (i.state === "met") {
    if (i.requirement === "signin") return i.detail ?? "";
    const when = i.metOn ? formatDateOnly(i.metOn) : "";
    const text = `${when}${by}`.trim();
    return text || (i.requirement === "background" ? "Verified" : (i.detail ?? "Done"));
  }
  if (i.requirement === "signin") return i.detail ?? "Not signed in";
  if (i.state === "overdue") return `${i.detail ?? "Missing"} · overdue since ${i.dueDate ? formatDateOnly(i.dueDate) : "the due date"}`;
  if (i.dueDate && (i.state === "pending" || i.state === "problem")) return `${i.detail ?? "Missing"} · due ${formatDateOnly(i.dueDate)}`;
  return i.detail ?? "Not done";
}

type Panel = null | "verify" | "training" | "contact" | "extend" | "override" | "details";

function Row({ item, caregiverRecordId, canManage, canCompliance, hasContact, canOverride = false, backgroundClear = false, children }: {
  item: ReadinessItem; caregiverRecordId: string; canManage: boolean; canCompliance: boolean; hasContact: boolean; canOverride?: boolean; backgroundClear?: boolean; children?: ReactNode;
}) {
  const api = useAwsApi();
  const refresh = useRefreshReadiness();
  const { activeOrganizationId } = useOrganization();
  const [panel, setPanel] = useState<Panel>(null);
  const [approving, setApproving] = useState(false);
  const isDoc = item.requirement === "cpr" || item.requirement === "tb";
  const overrides = useReadinessOverrides(caregiverRecordId, isDoc && canCompliance);   // available only where the release switch is on
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  const [f, setF] = useState({ result: "approved", note: "", date: "", email: "", reason: "" });
  const key = useRef(newIdempotencyKey());
  const base = `/v1/caregivers/${encodeURIComponent(caregiverRecordId)}`;
  const set = (k: keyof typeof f) => (v: string) => { setF((o) => ({ ...o, [k]: v })); key.current = newIdempotencyKey(); };

  async function run(task: () => Promise<unknown>, done: string, failure: string) {
    setState({ busy: true, error: null, done: null });
    try { await task(); await refresh(); key.current = newIdempotencyKey(); setPanel(null); setState({ busy: false, error: null, done }); }
    catch (cause) { setState({ busy: false, error: message(cause, failure), done: null }); }
  }
  const sendLink = () => run(() => api.post(`${base}/signin-link`, { organizationId: activeOrganizationId }), "Sign-in link sent.", "The sign-in link was not sent.");
  const addAndSend = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) return setState({ busy: false, error: "Enter the caregiver's own email address.", done: null });
    await run(async () => {
      await api.post(`${base}/contact`, { organizationId: activeOrganizationId, email: f.email.trim() }, { idempotencyKey: key.current });
      if (!hasContact) await api.post(`${base}/signin-link`, { organizationId: activeOrganizationId });
    }, hasContact ? "Contact email saved." : "Email saved and sign-in link sent.", hasContact ? "The contact email could not be saved." : "The sign-in link was not sent.");
  };
  const toggle = (p: Exclude<Panel, null>) => { setState((s) => ({ ...s, error: null, done: null })); setPanel(panel === p ? null : p); };

  const a = item.nextAction;
  const actions: ReactNode[] = [];
  if (item.requirement === "background") {
    if (a === "verify" && (canManage || canCompliance)) actions.push(<button key="v" type="button" className={btn} aria-expanded={panel === "verify"} onClick={() => toggle("verify")}>{canCompliance ? "Verify" : "Update status"}</button>);
  }
  if (item.requirement === "training" && canManage) {
    actions.push(a === "reopen"
      ? <button key="t" type="button" className={btn} aria-expanded={panel === "training"} onClick={() => toggle("training")}>Reopen</button>
      : <button key="t" type="button" className={btn} aria-expanded={panel === "training"} onClick={() => toggle("training")}>Mark done</button>);
  }
  if (item.requirement === "signin" && item.state !== "met" && canManage) {
    if (a === "add_contact") actions.push(<button key="c" type="button" className={btn} aria-expanded={panel === "contact"} onClick={() => toggle("contact")}>Add email</button>);
    else actions.push(<button key="s" type="button" className={btn} disabled={state.busy} onClick={() => void sendLink()}>{state.busy ? "Sending…" : a === "resend_link" ? "Resend sign-in link" : "Send sign-in link"}</button>);
  }
  // An administrator can approve before the first sign-in (0090). The background check is never waived: without it there is no button, only the reason why.
  if (item.requirement === "signin" && item.state !== "met" && canOverride && backgroundClear) {
    actions.push(<button key="o" type="button" className={btn} aria-expanded={panel === "override"} onClick={() => toggle("override")}>Approve by override</button>);
  }
  const setupGap = (item.requirement === "cpr" || item.requirement === "tb") && /not set up/i.test(item.detail ?? "");
  // R7: an agency setup gap is fixed once, in the header ("Set up CPR and TB"), not per row. Uploading cannot fix it, so no Upload or Extend here.
  if (!setupGap && (item.requirement === "cpr" || item.requirement === "tb") && item.state !== "met") {
    actions.push(<Link key="u" to="/documents" className={btn}>Upload</Link>);
    // Extend moves the grace period of a document that is missing or waiting for review; it does nothing for an expired, rejected or expiry-less one, so it is not offered there
    if (canCompliance && (!item.extra.issueStatus || item.extra.issueStatus === "missing" || item.extra.issueStatus === "awaiting_review")) actions.push(<button key="x" type="button" className={btn} aria-expanded={panel === "extend"} onClick={() => toggle("extend")}>Extend</button>);
  }

  // 0123: ONE short row for a document issue: CPR | Expired Doc | Blocked | Approve, or CPR | Expired Doc | Admin Approved | Details.
  const issue = isDoc && item.extra.issueKey ? item.extra.issueLabel ?? "Document issue" : null;
  const ovr = item.extra.override && typeof item.extra.override === "object" ? item.extra.override : null;
  if (issue && !ovr && item.blocksShifts && canCompliance && overrides.available) actions.unshift(<button key="approve" type="button" className={btn} onClick={() => setApproving(true)}>Approve</button>);
  if (issue && ovr) actions.unshift(<button key="details" type="button" className={btn} aria-expanded={panel === "details"} onClick={() => toggle("details")}>Details</button>);
  const chip = chipFor(item);
  const value = (
    <>
      {issue ? <span className="font-medium" data-testid="issue-label">{issue}</span> : null}
      <span className={issue ? "block text-xs text-slate-600" : undefined}>{line(item)}</span>
      {item.requirement === "signin" && item.extra.override ? <span className="ml-2 inline-block rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900" data-testid="override-badge">{OVERRIDE_BADGE_TEXT}</span> : null}
      {item.requirement === "signin" && item.state !== "met" && canOverride && !backgroundClear ? <p className="text-xs text-slate-600" data-testid="override-needs-background">An administrator can approve before the first sign-in once the background check is clear. There is no override for the background check.</p> : null}
      {item.requirement === "signin" && item.extra.lastSentAt ? <p className="text-xs text-slate-600">Last sent {formatDateTime(item.extra.lastSentAt)}</p> : null}
      {item.requirement === "signin" && item.state !== "met" ? <p className="text-xs text-slate-600">Confirm the caregiver's email, send the invitation, then ask them to sign in once. Resend if it expired; check spam before sending again.</p> : null}
      {item.state === "overdue" && item.blocksShifts ? <p className="text-xs font-semibold text-red-800">Blocks new shift assignments</p> : null}
      {item.state === "overdue" && !item.blocksShifts ? <p className="text-xs text-slate-600">Flagged only; the agency has not switched enforcement on</p> : null}
    </>
  );
  return (
    <ProfileRow requirement={item.requirement} label={isDoc ? (item.requirement === "cpr" ? "CPR" : "TB") : item.label} status={<StatusChip tone={chip.tone}>{chip.label}</StatusChip>} value={value}
      action={actions.length > 0 ? <>{actions}</> : null}
      panel={<>
      {panel === "details" && ovr ? <OverrideDetails caregiverRecordId={caregiverRecordId} item={item} canRevoke={canCompliance && overrides.available} /> : null}
      {approving ? <ApproveOverrideDialog caregiverRecordId={caregiverRecordId} item={item} onClose={() => setApproving(false)} /> : null}
      {panel === "verify" ? (
        <form className="mt-2 grid gap-2 sm:grid-cols-[auto_1fr_auto] sm:items-end" onSubmit={(e) => {
          e.preventDefault();
          if (f.note.trim().length < 3) return setState({ busy: false, error: "Enter a short evidence note.", done: null });
          void run(() => canCompliance
            ? api.post(`${base}/background-check/verify`, { organizationId: activeOrganizationId, result: f.result, evidenceNote: f.note.trim() }, { idempotencyKey: key.current })
            : api.post(`${base}/background-check/status`, { organizationId: activeOrganizationId, status: "requested", note: f.note.trim() }, { idempotencyKey: key.current }),
            "Background check saved.", "Not saved.");
        }}>
          {canCompliance ? (
            <div><label htmlFor={`bg-result-${caregiverRecordId}`} className="block text-xs font-medium text-slate-700">Result</label>
              <select id={`bg-result-${caregiverRecordId}`} value={f.result} onChange={(e) => set("result")(e.target.value)} className={inputClass}><option value="approved">Approved</option><option value="not_approved">Not approved</option></select></div>
          ) : <p className="text-xs text-slate-600">Only an administrator can verify the result. This records that it was requested.</p>}
          <div><label htmlFor={`bg-note-${caregiverRecordId}`} className="block text-xs font-medium text-slate-700">Evidence note (no results or personal details)</label>
            <input id={`bg-note-${caregiverRecordId}`} value={f.note} maxLength={500} onChange={(e) => set("note")(e.target.value)} className={inputClass} /></div>
          <Button type="submit" disabled={state.busy}>{state.busy ? "Saving…" : "Save"}</Button>
        </form>
      ) : null}
      {panel === "training" ? (
        <form className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={(e) => {
          e.preventDefault();
          const reopen = a === "reopen";
          if (reopen && f.reason.trim().length < 3) return setState({ busy: false, error: "Give a reason to reopen.", done: null });
          void run(() => api.post(`${base}/onboarding/items`, {
            organizationId: activeOrganizationId, requirementKey: "training", action: reopen ? "reopen" : "complete",
            ...(reopen ? { reason: f.reason.trim() } : { completedOn: f.date || null }),
          }, { idempotencyKey: key.current }), reopen ? "Training reopened." : "Training recorded.", "Not saved.");
        }}>
          {a === "reopen"
            ? <div className="sm:col-span-2"><label htmlFor={`tr-reason-${caregiverRecordId}`} className="block text-xs font-medium text-slate-700">Reason</label><input id={`tr-reason-${caregiverRecordId}`} value={f.reason} maxLength={500} onChange={(e) => set("reason")(e.target.value)} className={inputClass} /></div>
            : <div className="sm:col-span-2"><label htmlFor={`tr-date-${caregiverRecordId}`} className="block text-xs font-medium text-slate-700">Completed on (blank = today)</label><input id={`tr-date-${caregiverRecordId}`} type="date" value={f.date} onChange={(e) => set("date")(e.target.value)} className={inputClass} /></div>}
          <Button type="submit" disabled={state.busy}>{state.busy ? "Saving…" : "Save"}</Button>
        </form>
      ) : null}
      {panel === "contact" ? (
        <form className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); void addAndSend(); }}>
          <div><label htmlFor={`ct-email-${caregiverRecordId}`} className="block text-xs font-medium text-slate-700">Caregiver's own email</label>
            <input id={`ct-email-${caregiverRecordId}`} type="email" inputMode="email" autoComplete="off" value={f.email} maxLength={254} onChange={(e) => set("email")(e.target.value)} className={inputClass} /></div>
          <Button type="submit" disabled={state.busy}>{state.busy ? "Saving…" : hasContact ? "Save contact email" : "Save and send sign-in link"}</Button>
          <p className="text-xs text-slate-600 sm:col-span-2">{hasContact ? "This changes the contact address. The existing sign-in stays the same." : "The caregiver gets an email with a temporary password and sets their own at first sign-in."}</p>
        </form>
      ) : null}
      {panel === "override" ? (
        <form className="mt-2 space-y-2 rounded-md border border-amber-300 bg-amber-50 p-2" aria-label="Approve by override" onSubmit={(e) => {
          e.preventDefault();
          if (f.reason.trim().length < 5) return setState({ busy: false, error: "Write why you are approving this caregiver before their first sign-in (at least 5 characters).", done: null });
          void run(() => api.post(`${base}/signin-override`, { organizationId: activeOrganizationId, reason: f.reason.trim() }), "Approved by override. It is recorded with your name, the time and your reason, and the badge stays until the first sign-in.", "Not recorded.");
        }}>
          <p className="text-sm text-amber-950">This caregiver has not signed in yet. You can approve them for work anyway. They cannot verify a visit until they sign in, and the schedule warns about their shifts.</p>
          <p className="text-sm text-amber-950">Required training and the other requirements still apply. The background check cannot be overridden.</p>
          <div><label htmlFor={`ov-reason-${caregiverRecordId}`} className="block text-xs font-medium text-slate-800">Reason (required)</label>
            <textarea id={`ov-reason-${caregiverRecordId}`} value={f.reason} maxLength={500} rows={3} onChange={(e) => set("reason")(e.target.value)} className={inputClass} /></div>
          <Button type="submit" disabled={state.busy}>{state.busy ? "Saving…" : "Record override"}</Button>
        </form>
      ) : null}
      {panel === "extend" ? (
        <form className="mt-2 grid gap-2 sm:grid-cols-[1fr_2fr_auto] sm:items-end" onSubmit={(e) => {
          e.preventDefault();
          if (!f.date) return setState({ busy: false, error: "Choose the new due date.", done: null });
          if (f.reason.trim().length < 3) return setState({ busy: false, error: "Give a reason for the extension.", done: null });
          void run(() => api.post(`${base}/cpr-tb/extend`, { organizationId: activeOrganizationId, requirement: item.requirement, newDueDate: f.date, reason: f.reason.trim() }, { idempotencyKey: key.current }),
            "Due date extended. The change is in the audit history.", "Not extended.");
        }}>
          <div><label htmlFor={`ex-date-${item.requirement}`} className="block text-xs font-medium text-slate-700">New due date</label><input id={`ex-date-${item.requirement}`} type="date" value={f.date} min={item.dueDate ?? undefined} onChange={(e) => set("date")(e.target.value)} className={inputClass} /></div>
          <div><label htmlFor={`ex-reason-${item.requirement}`} className="block text-xs font-medium text-slate-700">Reason (required)</label><input id={`ex-reason-${item.requirement}`} value={f.reason} maxLength={500} onChange={(e) => set("reason")(e.target.value)} className={inputClass} /></div>
          <Button type="submit" disabled={state.busy}>{state.busy ? "Saving…" : "Extend"}</Button>
        </form>
      ) : null}
      {state.error ? <p role="alert" className="mt-1 text-sm text-red-700">{state.error}</p> : null}
      {state.done ? <p role="status" className="mt-1 text-sm text-emerald-800">{state.done}</p> : null}
      {children}
      </>} />
  );
}

/** The whole readiness story in one list: five requirements and the single Approve for work step. Replaces Onboarding, Compliance, Documents status and the status picker. */
export function ReadinessChecklist({ caregiverRecordId, canManage, hasContact }: { caregiverRecordId: string; canManage: boolean; hasContact: boolean }) {
  const { hasPermission, activeOrganizationId } = useOrganization();
  const api = useAwsApi();
  const refresh = useRefreshReadiness();
  const canCompliance = hasPermission("caregivers.compliance.manage");
  const canRead = canManage || canCompliance || hasPermission("readiness.read");
  const q = useCaregiverReadiness(caregiverRecordId, canRead);
  // The server's own compliance read: whether the caregiver can be scheduled and, if not, why. A failed read only hides the extra reasons; it never shows or hides a hold by guess.
  const comp = useQuery({
    queryKey: ["caregiver-compliance", activeOrganizationId, caregiverRecordId],
    queryFn: async () => (await api.get<{ compliance: ComplianceRead }>(`/v1/caregivers/${encodeURIComponent(caregiverRecordId)}/compliance`, { organizationId: activeOrganizationId })).compliance,
    enabled: !!activeOrganizationId && canRead, retry: false,
  });
  const [approve, setApprove] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const inFlight = useRef(false);
  const approveKey = useRef(newIdempotencyKey());
  if (!canRead) return null;
  if (q.isLoading) return <Card className="p-4"><p className="text-sm text-slate-500">Loading…</p></Card>;
  if (q.isError || !q.data) return <Card className="p-4"><p role="alert" className="text-sm text-red-700">{message(q.error, "Readiness could not be loaded. Reload the page.")}</p></Card>;
  const r = q.data;
  const inactive = r.status === "inactive";
  const isApproved = r.status === "approved" || r.status === "active";
  async function doApprove() {
    if (inFlight.current) return; // a double-click sends one request; the server also guarantees one approval record
    inFlight.current = true;
    setApprove({ busy: true, error: null });
    try {
      await api.post(`/v1/caregivers/${encodeURIComponent(caregiverRecordId)}/approve`, { organizationId: activeOrganizationId }, { idempotencyKey: approveKey.current });
      approveKey.current = newIdempotencyKey();
      await refresh();
      setApprove({ busy: false, error: null });
    } catch (cause) {
      setApprove({ busy: false, error: message(cause, "Not approved.") });
    } finally { inFlight.current = false; }
  }
  const waiting = r.waitingOn.length > 0 ? `Waiting on: ${r.waitingOn.join(", ")}` : null;
  const canSetup = hasPermission("readiness.manage") || hasPermission("documents.requirements.manage");
  const setupGaps = r.items.filter((i) => (i.requirement === "cpr" || i.requirement === "tb") && /not set up/i.test(i.detail ?? ""));
  // Scheduling holds are shown with the server's own reason. Work approval never implies "eligible to schedule": the two are shown side by side and only the server's holds decide.
  const holdReasons: string[] = r.items.filter((i) => i.blocksShifts).map((h) => `${h.label}: ${h.detail ?? "Needs attention"}`);
  const c = comp.data;
  if (c && !c.eligible) {
    const bg = r.items.find((x) => x.requirement === "background");
    if (!c.background.qualifies) holdReasons.push(`Background check: ${bg?.detail ?? "No approved result is verified"}`);
    for (const x of c.requirements) if (x.blocking && x.message) holdReasons.push(`${x.requirement === "cpr" ? "CPR certificate" : "TB clearance"}: ${x.message}`);
    for (const x of c.hold?.reasons ?? []) if (x.message) holdReasons.push(x.message);
  }
  const holds = [...new Set(holdReasons)];
  const attention = r.items.filter((i) => i.state !== "met").length;
  return (
    <section aria-label="Readiness" data-testid="readiness-checklist" className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span data-testid="work-approval-chip" className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-sm font-semibold ${WORK_STATUS_BADGE[r.status]}`}>Work approval: {isApproved ? (r.status === "active" ? "Approved · Active" : "Approved") : WORK_STATUS_LABEL[r.status]}</span>
        {attention > 0 ? <span className="inline-block rounded-md bg-red-50 px-2 py-0.5 text-sm font-semibold text-red-900">{attention} compliance item{attention === 1 ? "" : "s"} need{attention === 1 ? "s" : ""} attention</span> : null}
        {!isApproved && !inactive ? <span className="text-sm font-semibold text-slate-900">{r.met} of {r.total} done</span> : null}
        <span className="text-sm text-slate-700">
          {r.hireDate ? `Hired ${formatDateOnly(r.hireDate)}` : "Hire date not recorded"}
          {r.cprTbDueDate ? ` · CPR/TB due ${formatDateOnly(r.cprTbDueDate)}` : ""}
        </span>
      </div>
      {holds.length > 0 ? (
        <div role="status" data-testid="scheduling-hold" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
          <p className="font-semibold">Scheduling hold</p>
          <ul className="list-disc pl-5">{holds.map((h) => <li key={h}>{h}</li>)}</ul>
          <p className="text-xs">Work approval is a separate step. These reasons come from the agency's scheduling rules.</p>
        </div>
      ) : null}
      {setupGaps.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="cpr-tb-setup">
          {canSetup ? <Link to="/care-team#readiness-setup" className={rowButton}>Set up CPR and TB</Link> : <span className="text-sm text-slate-700">Ask an administrator to set up CPR and TB.</span>}
          <span className="text-xs text-slate-600">An agency setup step: it does not change this caregiver's work approval.</span>
        </div>
      ) : null}
      <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-og-card" aria-label="Requirements">
        {r.items.map((i) => <Row key={i.requirement} item={i} caregiverRecordId={caregiverRecordId} canManage={canManage} canCompliance={canCompliance} hasContact={hasContact}
          canOverride={hasPermission("caregivers.signin_override")} backgroundClear={r.items.find((x) => x.requirement === "background")?.state === "met"} />)}
        <ProfileRow requirement="approve" label="Work approval"
          status={<StatusChip tone={isApproved ? "ok" : "neutral"}>{isApproved ? "Approved" : "Not approved"}</StatusChip>}
          value={<span id="approve-reason">{isApproved
            ? r.approvalSource === "legacy_status" ? "Approved before this checklist existed" : `Approved ${r.approvedAt ? formatDateTime(r.approvedAt) : ""}${r.approvedByName ? ` by ${r.approvedByName}` : ""}`.trim()
            : inactive ? (waiting ?? "Inactive. Approve to reactivate.") : waiting ?? "Every required item is done"}</span>}
          action={canManage && !isApproved ? (
            <button type="button" className={btn} disabled={!r.canApprove || approve.busy} aria-describedby="approve-reason" onClick={() => void doApprove()}>
              {approve.busy ? "Approving…" : inactive ? "Reactivate" : "Approve"}
            </button>
          ) : null}
          panel={approve.error ? <p role="alert" className="text-sm text-red-700">{approve.error}</p> : null} />
      </ul>
      {r.items.some((i) => (i.state === "pending" || i.state === "overdue") && i.kind === "flexible") ? (
        <p className="text-xs text-slate-600">CPR and TB are due {r.graceDays} days after the hire date unless an administrator extends one. Before the due date they do not block approval or shifts.</p>
      ) : null}
    </section>
  );
}
