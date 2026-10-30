import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { formatDateOnly, formatDateTime } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";
import { WORK_STATUS_BADGE, WORK_STATUS_LABEL } from "../care-team-admin";
import { useCaregiverReadiness, type ReadinessItem } from "./readiness-data";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const inputClass = "mt-0.5 block w-full rounded-lg border border-slate-200 px-2.5 py-2 text-sm";
const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-900 hover:bg-slate-50 disabled:opacity-50 md:min-h-[32px]";

function useRefreshReadiness() {
  const qc = useQueryClient();
  return async () => {
    for (const k of ["caregiver-readiness", "aws-caregivers", "aws-accounts", "caregiver-compliance", "compliance-holds", "document-readiness"]) await qc.invalidateQueries({ queryKey: [k] });
  };
}

const ICON: Record<ReadinessItem["state"], { glyph: string; cls: string; sr: string }> = {
  met: { glyph: "✓", cls: "text-emerald-700", sr: "Done" },
  unmet: { glyph: "✗", cls: "text-red-700", sr: "Not done" },
  pending: { glyph: "!", cls: "text-amber-700", sr: "Due soon" },
  overdue: { glyph: "!", cls: "text-red-700", sr: "Overdue" },
  problem: { glyph: "!", cls: "text-red-700", sr: "Needs attention" },
};

/** What a row says on its second line. Dates come from the server as YYYY-MM-DD and are never passed through a time zone. */
function line(i: ReadinessItem): string {
  const by = i.actorName ? ` by ${i.actorName}` : "";
  if (i.requirement === "background" && i.state === "met") return `Verified${i.metOn ? ` ${formatDateOnly(i.metOn)}` : ""}${by}`;
  if (i.state === "met") return `${i.detail ?? "Done"}${i.metOn ? ` ${formatDateOnly(i.metOn)}` : ""}`;
  if (i.requirement === "signin") return i.detail ?? "Not signed in";
  if (i.state === "overdue") return `${i.detail ?? "Missing"} · overdue since ${i.dueDate ? formatDateOnly(i.dueDate) : "the due date"}`;
  if (i.dueDate && (i.state === "pending" || i.state === "problem")) return `${i.detail ?? "Missing"} · due ${formatDateOnly(i.dueDate)}`;
  return i.detail ?? "Not done";
}

type Panel = null | "verify" | "training" | "contact" | "extend";

function Row({ item, caregiverRecordId, canManage, canCompliance, hasContact, children }: {
  item: ReadinessItem; caregiverRecordId: string; canManage: boolean; canCompliance: boolean; hasContact: boolean; children?: ReactNode;
}) {
  const api = useAwsApi();
  const refresh = useRefreshReadiness();
  const { activeOrganizationId } = useOrganization();
  const [panel, setPanel] = useState<Panel>(null);
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
      await api.post(`${base}/signin-link`, { organizationId: activeOrganizationId });
    }, "Email saved and sign-in link sent.", "The sign-in link was not sent.");
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
  if ((item.requirement === "cpr" || item.requirement === "tb") && item.state !== "met") {
    actions.push(<Link key="u" to="/documents" className={btn}>Upload</Link>);
    if (canCompliance) actions.push(<button key="x" type="button" className={btn} aria-expanded={panel === "extend"} onClick={() => toggle("extend")}>Extend</button>);
  }
  void hasContact;

  return (
    <li className="px-3 py-2" data-requirement={item.requirement}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <span aria-hidden="true" className={`mt-0.5 w-4 shrink-0 text-center font-bold ${ICON[item.state].cls}`}>{ICON[item.state].glyph}</span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-950">{item.label}<span className="sr-only"> — {ICON[item.state].sr}</span></p>
            <p className="text-sm text-slate-700">{line(item)}</p>
            {item.requirement === "signin" && item.extra.lastSentAt ? <p className="text-xs text-slate-600">Last sent {formatDateTime(item.extra.lastSentAt)}</p> : null}
            {item.state === "overdue" && item.blocksShifts ? <p className="text-xs font-semibold text-red-800">Blocks new shift assignments</p> : null}
            {item.state === "overdue" && !item.blocksShifts ? <p className="text-xs text-slate-600">Flagged only; the agency has not switched enforcement on</p> : null}
          </div>
        </div>
        {actions.length > 0 ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
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
          <Button type="submit" disabled={state.busy}>{state.busy ? "Sending…" : "Save and send sign-in link"}</Button>
          <p className="text-xs text-slate-600 sm:col-span-2">The caregiver gets an email with a temporary password and sets their own at first sign-in. The message contains no client or health information.</p>
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
    </li>
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
  return (
    <section aria-label="Readiness" data-testid="readiness-checklist" className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-sm font-semibold ${WORK_STATUS_BADGE[r.status]}`}>{WORK_STATUS_LABEL[r.status]}</span>
        {!isApproved && !inactive ? <span className="text-sm font-semibold text-slate-900">{r.met} of {r.total} done</span> : null}
        <span className="text-sm text-slate-700">
          {r.hireDate ? `Hired ${formatDateOnly(r.hireDate)}` : "Hire date not recorded"}
          {r.cprTbDueDate ? ` · CPR/TB due ${formatDateOnly(r.cprTbDueDate)}` : ""}
        </span>
      </div>
      <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-og-card" aria-label="Requirements">
        {r.items.map((i) => <Row key={i.requirement} item={i} caregiverRecordId={caregiverRecordId} canManage={canManage} canCompliance={canCompliance} hasContact={hasContact} />)}
        <li className="px-3 py-2" data-requirement="approve">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <span aria-hidden="true" className={`mt-0.5 w-4 shrink-0 text-center font-bold ${isApproved ? "text-emerald-700" : "text-slate-500"}`}>{isApproved ? "✓" : "○"}</span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-950">Approve for work</p>
                <p className="text-sm text-slate-700" id="approve-reason">
                  {isApproved
                    ? r.approvalSource === "legacy_status" ? "Approved before this checklist existed" : `Approved ${r.approvedAt ? formatDateTime(r.approvedAt) : ""}${r.approvedByName ? ` by ${r.approvedByName}` : ""}`
                    : inactive ? (waiting ?? "Inactive. Approve to reactivate.") : waiting ?? "Every required item is done"}
                </p>
              </div>
            </div>
            {canManage && !isApproved ? (
              <button type="button" className={btn} disabled={!r.canApprove || approve.busy} aria-describedby="approve-reason" onClick={() => void doApprove()}>
                {approve.busy ? "Approving…" : inactive ? "Reactivate" : "Approve"}
              </button>
            ) : null}
          </div>
          {approve.error ? <p role="alert" className="mt-1 text-sm text-red-700">{approve.error}</p> : null}
        </li>
      </ul>
      {r.items.some((i) => (i.state === "pending" || i.state === "overdue") && i.kind === "flexible") ? (
        <p className="text-xs text-slate-600">CPR and TB are due {r.graceDays} days after the hire date unless an administrator extends one. Before the due date they do not block approval or shifts.</p>
      ) : null}
    </section>
  );
}
