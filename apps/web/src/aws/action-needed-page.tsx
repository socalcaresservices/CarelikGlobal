import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { formatClockTime, formatNumericDate } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { CATEGORY_LABEL, issueDestination, KIND_LABEL, QUEUE_LABEL, SEVERITY_TONE, type ActionIssue, type IssueList } from "./action-issues";
import { TONE } from "./attention";
import { Disclosure } from "./ui/disclosure";
import { ShortHelp } from "./help-text";
import { PageHeader } from "./ui/page-header";
import type { NotificationSettings } from "./notifications";
import { StatusChip } from "./ui/status-chip";

const PAGE = 25;
interface Filters { queue: string; category: string; severity: string; client: string; caregiver: string; service: string }
const NONE: Filters = { queue: "", category: "", severity: "", client: "", caregiver: "", service: "" };
interface History { state: { status: string; firstSeenAt: string; resolvedAt: string | null; reopenCount: number } | null; events: Array<{ event: string; severity: string | null; occurredAt: string; observedByName: string | null }> }
interface Settings { confirmationOverdueHours: number; reviewOverdueHours: number; documentReviewOverdueHours: number; defaults: { confirmationOverdueHours: number; reviewOverdueHours: number; documentReviewOverdueHours: number }; history: Array<{ changedAt: string; changedByName: string | null; reason: string }> }

const linkClass = "inline-flex min-h-[44px] items-center font-semibold text-og-link underline md:min-h-[32px]";

/** One compact row: severity, what and what to do, when it is due, one action link; History is a quiet second control. The queue is the group heading, not repeated here. */
function IssueCard({ issue }: { issue: ActionIssue }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const [open, setOpen] = useState(false);
  const dest = issueDestination(issue);
  const tone = SEVERITY_TONE[issue.severity];
  const history = useQuery({
    queryKey: ["action-issue-history", issue.issueKey], enabled: open && !!activeOrganizationId,
    queryFn: async () => (await api.get<{ history: History }>("/v1/action-issues/history", { organizationId: activeOrganizationId, issueKey: issue.issueKey })).history,
  });
  const who = [issue.clientCode, issue.serviceCode, issue.caregiverCode].filter(Boolean).join(" · ");
  return (
    <li data-testid="issue-card" data-issue-key={issue.issueKey} className={`border-l-4 px-3 py-2 ${tone === "red" ? "border-l-red-700" : tone === "amber" ? "border-l-amber-600" : "border-l-slate-400"}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0 md:grid md:grid-cols-[6.5rem_minmax(0,1fr)_11rem_auto]">
        <span><StatusChip tone={tone}>{TONE[tone].word}</StatusChip></span>
        <div className="min-w-0 flex-1 basis-[10rem]">
          <p className="text-sm font-semibold text-og-ink">{KIND_LABEL[issue.kind] ?? issue.kind}{who ? ` · ${who}` : ""}</p>
          <p className="text-sm text-og-sub">{issue.recommendedAction}</p>
        </div>
        <p className="basis-full text-xs text-og-sub md:basis-auto" data-testid="issue-deadline">
          {issue.deadline ? `${issue.severity === "critical" ? "Was due" : "Due"} ${formatNumericDate(issue.deadline)} ${formatClockTime(issue.deadline)}` : "No deadline"}
          {issue.reopenCount ? ` · reopened ${issue.reopenCount} time${issue.reopenCount === 1 ? "" : "s"}` : ""}
        </p>
        <div className="flex items-center gap-x-4 md:justify-end">
          <Link className={linkClass} to={dest.to}>{dest.label}</Link>
          <button type="button" className="inline-flex min-h-[44px] items-center text-sm text-og-sub underline md:min-h-[32px]" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "Hide history" : "History"}</button>
        </div>
      </div>
      {open ? (
        <div className="mt-1 rounded-lg bg-og-bg p-2 text-xs text-og-sub" data-testid="issue-history">
          {history.isLoading ? "Loading…" : history.isError ? "The history could not be loaded. Close it and open it again." : (
            <ul className="space-y-0.5">
              {(history.data?.events ?? []).map((e, n) => <li key={n}>{formatNumericDate(e.occurredAt)} {formatClockTime(e.occurredAt)} · {e.event.replace(/_/g, " ")}{e.severity ? ` (${e.severity})` : ""}{e.observedByName ? ` · seen by ${e.observedByName}` : ""}</li>)}
              <li>Times are when the change was first seen by the system, not necessarily when it happened.</li>
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}

function DeadlineSettings() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const canEdit = hasPermission("organization.update");
  const q = useQuery({
    queryKey: ["attention-settings", activeOrganizationId], enabled: !!activeOrganizationId,
    queryFn: async () => (await api.get<{ settings: Settings }>("/v1/attention-settings", { organizationId: activeOrganizationId })).settings,
  });
  const [vals, setVals] = useState<{ c: string; r: string; d: string; reason: string }>({ c: "", r: "", d: "", reason: "" });
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  const key = useRef(newIdempotencyKey());
  const s = q.data;
  if (!s) return null;
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  async function save() {
    if (state.busy) return;
    if (vals.reason.trim().length < 10) return setState({ busy: false, error: "Write why you are changing the deadlines (at least 10 characters).", done: false });
    setState({ busy: true, error: null, done: false });
    try {
      await api.post("/v1/attention-settings", { organizationId: activeOrganizationId, confirmationOverdueHours: num(vals.c), reviewOverdueHours: num(vals.r), documentReviewOverdueHours: num(vals.d), reason: vals.reason.trim() }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setVals({ c: "", r: "", d: "", reason: "" });
      setState({ busy: false, error: null, done: true });
      await Promise.all(["attention-settings", "action-issues", "attention-overview"].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
    } catch (cause) {
      setState({ busy: false, error: cause instanceof Error ? cause.message : "Not saved. Nothing changed.", done: false });
    }
  }
  const field = (label: string, name: "c" | "r" | "d", current: number, max: number) => (
    <label className="block text-sm font-medium text-og-ink">
      {label} (now {current} h; at most {max} h)
      <input inputMode="numeric" value={vals[name]} onChange={(e) => setVals({ ...vals, [name]: e.target.value })} placeholder={`Leave empty for ${max}`} className="mt-1 block w-full rounded-lg border border-og-line bg-og-card px-3 py-2 text-base" />
    </label>
  );
  return (
    <Disclosure summary="Follow-up deadlines" >
      <div className="space-y-2" data-testid="deadline-settings">
        <ShortHelp className="text-sm text-og-sub" details="These only decide when an item moves to the urgent view. A deadline never approves, signs or bills anything. A stricter payer or regulatory deadline is not set up here.">A deadline can be shorter than the default, never longer.</ShortHelp>
        {canEdit ? (
          <>
            {field("Client confirmation", "c", s.confirmationOverdueHours, s.defaults.confirmationOverdueHours)}
            {field("Administrator review", "r", s.reviewOverdueHours, s.defaults.reviewOverdueHours)}
            {field("Document review", "d", s.documentReviewOverdueHours, s.defaults.documentReviewOverdueHours)}
            <label className="block text-sm font-medium text-og-ink">Why are you changing them? (kept on record)
              <textarea rows={2} maxLength={1000} value={vals.reason} onChange={(e) => setVals({ ...vals, reason: e.target.value })} className="mt-1 block w-full rounded-lg border border-og-line bg-og-card px-3 py-2 text-base" />
            </label>
            <Button type="button" className="min-h-11" loading={state.busy} disabled={state.busy} onClick={() => void save()}>Save the deadlines</Button>
            {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
            {state.done ? <p role="status" className="text-sm text-emerald-800">Saved. The lists below use the new deadlines.</p> : null}
          </>
        ) : <p className="text-sm text-og-sub">Client confirmation {s.confirmationOverdueHours} h · administrator review {s.reviewOverdueHours} h · document review {s.documentReviewOverdueHours} h. Only the owner can change them.</p>}
        {s.history.length ? <ul className="text-xs text-og-sub">{s.history.map((h, n) => <li key={n}>{formatNumericDate(h.changedAt)} · {h.changedByName ?? "Someone"}: {h.reason}</li>)}</ul> : null}
      </div>
    </Disclosure>
  );
}

function NotificationSettingsCard() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const canEdit = hasPermission("organization.update");
  const q = useQuery({
    queryKey: ["notification-settings", activeOrganizationId], enabled: !!activeOrganizationId,
    queryFn: async () => (await api.get<{ settings: NotificationSettings }>("/v1/notification-settings", { organizationId: activeOrganizationId })).settings,
  });
  const [reason, setReason] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  const s = q.data;
  if (!s) return null;
  async function save(next: boolean) {
    if (state.busy) return;
    if (reason.trim().length < 3) return setState({ busy: false, error: "Write why you are changing it.", done: false });
    setState({ busy: true, error: null, done: false });
    try {
      await api.post("/v1/notification-settings", { organizationId: activeOrganizationId, urgentInApp: next, reason: reason.trim() }, { idempotencyKey: newIdempotencyKey() });
      setReason("");
      setState({ busy: false, error: null, done: true });
      await queryClient.invalidateQueries({ queryKey: ["notification-settings"] });
    } catch (cause) {
      setState({ busy: false, error: cause instanceof Error ? cause.message : "Not saved. Nothing changed.", done: false });
    }
  }
  return (
    <Disclosure summary="Notifications">
      <div className="space-y-2" data-testid="notification-settings">
        <ShortHelp className="text-sm text-og-sub" details="In-app only. Critical items always notify the staff who can see them. Routine items stay listed here and never notify. No email, text or push message is sent.">Urgent items: {s.urgentInApp ? "notify" : "do not notify"}.</ShortHelp>
        {canEdit ? (
          <>
            <label className="block text-sm font-medium text-og-ink">Why are you changing it? (kept on record)
              <input value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} className="mt-1 block w-full rounded-lg border border-og-line bg-og-card px-3 py-2 text-base" />
            </label>
            <Button type="button" className="min-h-11" loading={state.busy} disabled={state.busy} onClick={() => void save(!s.urgentInApp)}>{s.urgentInApp ? "Stop Urgent notifications" : "Turn Urgent notifications on"}</Button>
            {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
            {state.done ? <p role="status" className="text-sm text-emerald-800">Saved.</p> : null}
          </>
        ) : <p className="text-sm text-og-sub">Only the owner can change this.</p>}
      </div>
    </Disclosure>
  );
}

/**
 * Action Needed (Board 4): one server-defined list with the counts that equal it, Critical then Urgent then Routine, filters, paging, a recommended next action with the
 * context in the link, and each issue's history. Pending confirmation, Ready for Approval and the other routine queues are labelled by queue and are not in the Action Needed total.
 */
export function ActionNeededPage() {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const [f, setF] = useState<Filters>(NONE);
  const [pages, setPages] = useState(1);
  const params = { organizationId: activeOrganizationId, queue: f.queue || undefined, category: f.category || undefined, severity: f.severity || undefined, clientId: f.client || undefined, caregiverRecordId: f.caregiver || undefined, serviceId: f.service || undefined, limit: String(PAGE * pages), offset: "0" };
  const q = useQuery({ queryKey: ["action-issues", params], enabled: !!activeOrganizationId, refetchInterval: 5 * 60_000, queryFn: async () => api.get<IssueList>("/v1/action-issues", params as Record<string, string | undefined>) });
  const all = useQuery({ queryKey: ["action-issues", "options", activeOrganizationId], enabled: !!activeOrganizationId, queryFn: async () => api.get<IssueList>("/v1/action-issues", { organizationId: activeOrganizationId, limit: "200" }) });
  const options = useMemo(() => {
    const pick = (id: (i: ActionIssue) => string | null, label: (i: ActionIssue) => string | null) => {
      const m = new Map<string, string>();
      for (const i of all.data?.issues ?? []) { const k = id(i); const l = label(i); if (k && l) m.set(k, l); }
      return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    };
    return { clients: pick((i) => i.clientId, (i) => i.clientCode), caregivers: pick((i) => i.caregiverRecordId, (i) => i.caregiverCode), services: pick((i) => i.serviceId, (i) => i.serviceCode) };
  }, [all.data]);
  const set = (k: keyof Filters, v: string) => { setF({ ...f, [k]: v }); setPages(1); };
  const sel = (label: string, k: keyof Filters, opts: Array<[string, string]>) => (
    <label className="text-xs font-medium text-og-sub">{label}
      <select value={f[k]} onChange={(e) => set(k, e.target.value)} className="mt-1 block min-h-11 w-full rounded-lg border border-og-line bg-og-card px-2 py-1 text-sm text-og-ink md:min-h-9">
        <option value="">All</option>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
  const data = q.data;
  const filtered = Object.values(f).some((v) => !!v);
  // One group per queue, in the order the server first lists them (most urgent first). Each heading carries its count once.
  const groups = (() => {
    const m = new Map<string, ActionIssue[]>();
    for (const i of data?.issues ?? []) m.set(i.queue, [...(m.get(i.queue) ?? []), i]);
    return [...m.entries()].map(([queue, issues]) => ({ queue, issues, count: !filtered ? (data?.counts.byQueue[queue] ?? issues.length) : issues.length, routine: issues.every((i) => i.severity === "routine") }));
  })();
  return (
    <div className="space-y-3">
      <PageHeader title="Action needed" lead="Most urgent first. Each item links to its next step." />
      {q.isLoading ? <p className="text-sm text-og-sub">Loading…</p> : null}
      {q.isError ? <p role="alert" className="text-sm text-red-700">The list could not be loaded. Check your connection, then <button type="button" className="font-semibold underline" onClick={() => void q.refetch()}>Retry</button>.</p> : null}
      {data ? <p className="text-sm font-semibold text-og-ink" data-testid="issue-counts">{data.counts.actionNeeded} need action</p> : null}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-6" data-testid="issue-filters">
        {sel("Queue", "queue", Object.entries(QUEUE_LABEL))}
        {sel("Category", "category", Object.entries(CATEGORY_LABEL))}
        {sel("Severity", "severity", [["critical", "Critical"], ["urgent", "Urgent"], ["routine", "Routine"]])}
        {sel("Client", "client", options.clients)}
        {sel("Caregiver", "caregiver", options.caregivers)}
        {sel("Service", "service", options.services)}
      </div>
      {data && data.issues.length === 0 ? <p role="status" className="rounded-og border border-og-line bg-og-card p-3 text-sm text-og-sub">{!filtered ? "Nothing needs action right now." : "Nothing matches these filters. Clear a filter to see more."}</p> : null}
      {data && data.issues.length > 0 ? (
        <>
          {groups.map((g) => (
            <section key={g.queue} aria-label={QUEUE_LABEL[g.queue] ?? g.queue} className="space-y-1">
              <h2 className="text-sm font-bold text-og-ink">{QUEUE_LABEL[g.queue] ?? g.queue} <span className="font-og-mono tabular-nums">{g.count}</span>{g.routine ? <span className="font-normal text-og-sub"> · routine, not in the total</span> : null}</h2>
              <ul className="divide-y divide-og-line rounded-og border border-og-line bg-og-card">{g.issues.map((i) => <IssueCard key={i.issueKey} issue={i} />)}</ul>
            </section>
          ))}
          {data.matching > data.issues.length ? <Button type="button" variant="secondary" className="min-h-11" onClick={() => setPages(pages + 1)}>Show more ({data.matching - data.issues.length} left)</Button> : null}
        </>
      ) : null}
      <DeadlineSettings />
      <NotificationSettingsCard />
      <Disclosure summary="How this list is built">
        <p>Every item has one stable identity, so the same problem is the same issue on Home, Scheduling and here. Two problems on the same visit stay two issues.</p>
        <p className="mt-1">Critical: care is blocked now, or an uncovered shift has started. Urgent: inside the follow-up window or past a deadline.</p>
        <p className="mt-1">Over the monthly authorization is Urgent, never Critical by itself: all worked time is kept and paid, and the time over the limit is not billed. It clears when the hours are back within the authorization.</p>
        <p className="mt-1">Routine: waiting inside its deadline. Routine items are separate queues and are never added to the action total.</p>
        <p className="mt-1">Nothing here assigns anyone, approves a visit or sends a bill. You decide on the next screen.</p>
      </Disclosure>
    </div>
  );
}
