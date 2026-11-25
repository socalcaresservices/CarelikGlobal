// Notification centre (0113, behind the `notifications` release switch). One place for the signed-in person's own notifications (cover-shift offers today; the model
// takes more categories), their preferences, and, for the office, the cover-shift settings and what was sent. Where the switch is off the routes do not exist: the list
// does not load (`available` false), the sidebar link stays out of sight and this page says it is not available yet. Nothing here assigns a shift.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { formatClockTime, formatNumericDate } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { CENTER_REFRESH_MS, type CenterItem, type CenterList, type CenterState, type CoverSettings, type HistoryRow, type Prefs } from "./notification-center-data";
import { MySmsPanel, OfficeSmsPanel } from "./sms-settings";
import { useAgencyClock } from "./agency-clock";
import { isActionable, STATUS_LABEL, STATUS_TONE } from "./cover-shift-status";
import { PageHeader } from "./ui/page-header";
import { SortTh } from "./ui/sort-th";
import { useSortedRows } from "./ui/table-sort";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
const STATE_LABEL: Record<CenterState, string> = { inbox: "Inbox", unread: "Unread", archived: "Archived", all: "All" };
const inputClass = "mt-1 block w-full rounded-lg border border-og-line bg-og-card px-3 py-2 text-base";

export function NotificationCenterPage() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [state, setState] = useState<CenterState>("inbox");
  const [category, setCategory] = useState<"" | "cover_shift" | "cover_office">("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = useQuery({
    queryKey: ["notification-center", activeOrganizationId, state, category],
    queryFn: async () => (await api.get<{ notifications: CenterList }>("/v1/notification-center", { organizationId: activeOrganizationId, state, ...(category ? { category } : {}), limit: "50" })).notifications,
    enabled: !!activeOrganizationId,
    retry: false,
    refetchInterval: CENTER_REFRESH_MS,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["notification-center"] });
  async function mark(action: "read" | "read_all" | "archive" | "unarchive", ids: string[] = []) {
    setBusy(true); setError(null);
    try { await api.post("/v1/notification-center/mark", { organizationId: activeOrganizationId, action, ids }, { idempotencyKey: newIdempotencyKey() }); await refresh(); }
    catch (cause) { setError(message(cause, "Could not save. Nothing changed; try again.")); }
    finally { setBusy(false); }
  }
  const unavailable = list.isError && (list.error as { code?: string } | null)?.code === "not_available";
  if (unavailable) return <div className="space-y-2"><PageHeader title="Notifications" /><p className="text-sm text-og-sub" data-testid="center-unavailable">Notifications are not available in this environment yet.</p></div>;
  const data = list.data;
  return (
    <div className="space-y-3">
      <PageHeader title="Notifications" lead="Offers to cover a shift and other messages for you. Nothing here assigns a shift: you ask for it in Schedule and the office confirms." />
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">Show
          <select className={inputClass} value={state} onChange={(e) => setState(e.target.value as CenterState)} data-testid="center-state">
            {(Object.keys(STATE_LABEL) as CenterState[]).map((s) => <option key={s} value={s}>{STATE_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="text-sm">Type
          <select className={inputClass} value={category} onChange={(e) => setCategory(e.target.value as "" | "cover_shift" | "cover_office")} data-testid="center-category">
            <option value="">All types</option><option value="cover_shift">Cover a shift</option><option value="cover_office">Office alerts</option>
          </select>
        </label>
        <p className="text-sm font-semibold" role="status" data-testid="center-unread">{data ? `${data.unread} unread` : ""}</p>
        {data && data.unread > 0 ? <Button variant="secondary" disabled={busy} onClick={() => void mark("read_all")}>Mark all read</Button> : null}
      </div>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      {list.isLoading ? <p className="text-sm text-og-sub">Loading…</p> : null}
      {list.isError && !unavailable ? <p role="alert" className="text-sm text-red-700">Notifications could not be loaded. <button type="button" className="font-semibold underline" onClick={() => void list.refetch()}>Retry</button></p> : null}
      {data && data.items.length === 0 ? <p className="text-sm text-og-sub" data-testid="center-empty">{state === "archived" ? "Nothing archived." : "Nothing here."}</p> : null}
      <ul className="divide-y divide-og-line rounded-lg border border-og-line bg-og-card" aria-label="Notifications">
        {data?.items.map((n) => <NotificationCard key={n.id} n={n} busy={busy} canManage={hasPermission("shifts.manage")} onMark={(action) => void mark(action, [n.id])} />)}
      </ul>
      <Preferences />
      <MySmsPanel />
      {hasPermission("shifts.manage") || hasPermission("organization.update") ? <><OfficeSection /><OfficeSmsPanel /></> : null}
    </div>
  );
}

/** One alert. An open-shift alert shows the service city, the date and time and the service type once, what state the shift is in now, and one main action; the rest is in the menu. */
function NotificationCard({ n, busy, canManage, onMark }: { n: CenterItem; busy: boolean; canManage: boolean; onMark: (action: "read" | "archive" | "unarchive") => void }) {
  const { when, time } = useAgencyClock();
  const sh = n.category === "cover_shift" ? n.shift ?? null : null;
  const unread = n.state === "unread";
  const to = n.shiftId && !canManage && n.category === "cover_shift" ? `/my-shifts?shift=${encodeURIComponent(n.shiftId)}` : n.link;
  const dim = sh && !isActionable(sh.status);
  const btn = "inline-flex min-h-11 items-center rounded-lg px-3 text-sm";
  return (
    <li className="px-3 py-2" data-testid="center-item" data-state={n.state} data-shift-status={sh?.status}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={`text-base ${unread ? "font-semibold text-og-ink" : "text-og-sub"}`}>
            {unread ? <span aria-hidden="true" data-testid="unread-dot">● </span> : null}
            {sh ? `Open shift${sh.city ? ` in ${sh.city}` : ""}` : n.title}
            <span className="sr-only">{unread ? " (unread)" : ""}</span>
          </p>
          {sh ? (
            <p className={`text-base ${dim ? "text-og-sub" : "text-og-ink"}`} data-testid="center-when">{when(sh.startsAt)}–{time(sh.endsAt)}{sh.serviceName ? ` · ${sh.serviceName}` : ""}</p>
          ) : <p className="text-sm text-og-ink">{n.body}</p>}
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-og-sub">
            {sh ? <span data-testid="center-status" className={`rounded-full px-2 py-0.5 font-semibold ${STATUS_TONE[sh.status]}`}>{STATUS_LABEL[sh.status]}</span> : null}
            <span>{formatNumericDate(n.createdAt)} {formatClockTime(n.createdAt)}{n.state === "archived" ? " · Archived" : ""}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {to ? <Link className={`${btn} ${dim ? "border border-og-line text-og-ink" : "bg-og-accent font-semibold text-og-on-accent"} no-underline`} to={to}>{n.category === "cover_shift" ? "View shift" : "Open"}</Link> : null}
          <CardMenu state={n.state} busy={busy} onMark={onMark} />
        </div>
      </div>
    </li>
  );
}

/** Mark read and Archive live here, so the card has one obvious action. */
function CardMenu({ state, busy, onMark }: { state: CenterItem["state"]; busy: boolean; onMark: (action: "read" | "archive" | "unarchive") => void }) {
  const [open, setOpen] = useState(false);
  const item = "flex min-h-11 w-full items-center px-3 text-left text-sm hover:bg-og-page disabled:opacity-60";
  const act = (a: "read" | "archive" | "unarchive") => { setOpen(false); onMark(a); };
  return (
    <div className="relative" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
      <button type="button" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-og-line text-lg" aria-haspopup="menu" aria-expanded={open} aria-label="More actions" onClick={() => setOpen((v) => !v)}>⋯</button>
      {open ? (
        <div role="menu" className="absolute right-0 z-10 mt-1 w-40 overflow-hidden rounded-lg border border-og-line bg-og-card shadow-lg">
          {state === "unread" ? <button role="menuitem" type="button" className={item} disabled={busy} onClick={() => act("read")}>Mark read</button> : null}
          {state === "archived" ? <button role="menuitem" type="button" className={item} disabled={busy} onClick={() => act("unarchive")}>Restore</button>
            : <button role="menuitem" type="button" className={item} disabled={busy} onClick={() => act("archive")}>Archive</button>}
        </div>
      ) : null}
    </div>
  );
}

function Preferences() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [note, setNote] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["notification-preferences", activeOrganizationId], queryFn: async () => (await api.get<{ preferences: Prefs }>("/v1/notification-preferences", { organizationId: activeOrganizationId })).preferences, enabled: !!activeOrganizationId, retry: false });
  if (q.isLoading) return null;
  if (q.isError || !q.data) return <p role="alert" className="text-sm text-red-700">Your notification preferences could not be loaded.</p>;
  const p = q.data;
  async function save(next: { inApp: boolean; email: boolean }, category: "cover_shift" | "cover_office" = "cover_shift") {
    setNote(null);
    try { await api.post("/v1/notification-preferences", { organizationId: activeOrganizationId, category, ...next }, { idempotencyKey: newIdempotencyKey() }); await queryClient.invalidateQueries({ queryKey: ["notification-preferences"] }); await queryClient.invalidateQueries({ queryKey: ["notification-center"] }); setNote("Saved."); }
    catch (cause) { setNote(message(cause, "Could not save. Nothing changed.")); }
  }
  return (
    <Card>
      <h2 className="text-base font-semibold text-og-ink">Your preferences: offers to cover a shift</h2>
      <div className="mt-2 space-y-1">
        <label className="flex min-h-[44px] items-center gap-2 text-sm md:min-h-[32px]"><input type="checkbox" checked={p.coverShift.inApp} onChange={(e) => void save({ ...p.coverShift, inApp: e.target.checked })} data-testid="pref-inapp" /> Show in Notifications</label>
        <label className="flex min-h-[44px] items-center gap-2 text-sm md:min-h-[32px]"><input type="checkbox" checked={p.coverShift.email} disabled={!p.emailAvailable} onChange={(e) => void save({ ...p.coverShift, email: e.target.checked })} data-testid="pref-email" /> Email me</label>
        {!p.emailAvailable ? <p className="text-xs text-og-sub">Email is not turned on for your agency.</p> : null}
        {!p.coverShift.inApp && !p.coverShift.email ? <p className="text-xs text-amber-900">With both off you will not be told about open shifts. You can still see them in Schedule.</p> : null}
      </div>
      {p.canSeeOffice && p.coverOffice ? (
        <div className="mt-3 space-y-1" data-testid="office-prefs">
          <h3 className="text-sm font-semibold text-og-ink">Office alerts: call-outs and shifts still unfilled</h3>
          <label className="flex min-h-[44px] items-center gap-2 text-sm md:min-h-[32px]"><input type="checkbox" checked={p.coverOffice.inApp} onChange={(e) => void save({ ...p.coverOffice!, inApp: e.target.checked }, "cover_office")} data-testid="office-pref-inapp" /> Show in Notifications</label>
          <label className="flex min-h-[44px] items-center gap-2 text-sm md:min-h-[32px]"><input type="checkbox" checked={p.coverOffice.email} disabled={!p.emailAvailable} onChange={(e) => void save({ ...p.coverOffice!, email: e.target.checked }, "cover_office")} data-testid="office-pref-email" /> Email me too</label>
        </div>
      ) : null}
      {note ? <p role="status" className="mt-1 text-sm text-og-sub">{note}</p> : null}
    </Card>
  );
}

/** A sample of the subject the template makes (the real one uses the shift's service city, date and time). */
const previewSubject = (t: string) => t.replace("{city}", "Winchester").replace("{date}", "Fri, Nov 27").replace("{time}", "1:30–5:00 PM").replace("{service}", "Personal care");

const STATUS_WORD: Record<string, string> = { queued: "Waiting to send", sending: "Sending", retry: "Will retry", sent: "Sent", failed: "Failed", skipped: "Not sent" };

function OfficeSection() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const isOwner = hasPermission("organization.update");
  const settings = useQuery({ queryKey: ["cover-settings", activeOrganizationId], queryFn: async () => (await api.get<{ settings: CoverSettings }>("/v1/cover-notification-settings", { organizationId: activeOrganizationId })).settings, enabled: !!activeOrganizationId, retry: false });
  const history = useQuery({ queryKey: ["cover-history", activeOrganizationId], queryFn: async () => (await api.get<{ history: HistoryRow[] }>("/v1/cover-notification-history", { organizationId: activeOrganizationId })).history, enabled: !!activeOrganizationId && hasPermission("shifts.manage"), retry: false });
  const audiences = useQuery({ queryKey: ["cover-office-audiences", activeOrganizationId], queryFn: async () => (await api.get<{ offices: Array<{ officeId: string; officeName: string; audienceOverride: "office" | "agency" | "none" | null }> }>("/v1/cover-office-audiences", { organizationId: activeOrganizationId })).offices, enabled: !!activeOrganizationId, retry: false });
  const [draft, setDraft] = useState<CoverSettings | null>(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const { rows, sort } = useSortedRows(history.data ?? [], {
    when: { get: (r) => r.createdAt, kind: "date" }, caregiver: { get: (r) => r.caregiverCode }, inApp: { get: (r) => (r.inApp ? (r.readAt ? "Read" : "Unread") : "Hidden") },
    email: { get: (r) => (r.emailStatus ? STATUS_WORD[r.emailStatus] ?? r.emailStatus : "Off") }, attempts: { get: (r) => r.emailAttempts, kind: "number" },
  });
  if (settings.isError || !settings.data) return settings.isLoading ? null : <p role="alert" className="text-sm text-red-700">Cover-shift settings could not be loaded.</p>;
  const s = draft ?? settings.data;
  async function save() {
    setNote(null);
    if (reason.trim().length < 3) { setNote({ ok: false, text: "A reason is required." }); return; }
    try {
      await api.post("/v1/cover-notification-settings", { organizationId: activeOrganizationId, ...s, reason: reason.trim() }, { idempotencyKey: newIdempotencyKey() });
      setDraft(null); setReason(""); await queryClient.invalidateQueries({ queryKey: ["cover-settings"] }); await queryClient.invalidateQueries({ queryKey: ["notification-preferences"] });
      setNote({ ok: true, text: "Saved." });
    } catch (cause) { setNote({ ok: false, text: message(cause, "Could not save. Nothing changed.") }); }
  }
  async function setOverride(officeId: string, audience: "office" | "agency" | "none" | null) {
    setNote(null);
    try {
      await api.post(`/v1/offices/${officeId}/cover-audience`, { organizationId: activeOrganizationId, audience, reason: "Changed in Notifications settings" }, { idempotencyKey: newIdempotencyKey() });
      await queryClient.invalidateQueries({ queryKey: ["cover-office-audiences"] });
      setNote({ ok: true, text: "Saved." });
    } catch (cause) { setNote({ ok: false, text: message(cause, "Could not save. Nothing changed.") }); }
  }
  const num = (v: string, min: number, max: number, fallback: number) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : fallback; };
  return (
    <Card>
      <h2 className="text-base font-semibold text-og-ink">Office: cover-shift notifications</h2>
      <p className="mt-1 text-sm text-og-sub">When a shift needs cover, eligible caregivers assigned to that client and service are told. Messages never include the client's name or code. {s.enabled ? "On." : "Off: nobody is notified."}</p>
      {isOwner ? (
        <div className="mt-2 space-y-1">
          <label className="flex min-h-[44px] items-center gap-2 text-sm md:min-h-[32px]"><input type="checkbox" checked={s.enabled} onChange={(e) => setDraft({ ...s, enabled: e.target.checked })} data-testid="set-enabled" /> Notify caregivers about shifts that need cover</label>
          <label className="flex min-h-[44px] items-center gap-2 text-sm md:min-h-[32px]"><input type="checkbox" checked={s.emailEnabled} onChange={(e) => setDraft({ ...s, emailEnabled: e.target.checked })} data-testid="set-email" /> Also send email</label>
          <label className="flex min-h-[44px] items-center gap-2 text-sm md:min-h-[32px]"><input type="checkbox" checked={s.autoNotify} onChange={(e) => setDraft({ ...s, autoNotify: e.target.checked })} data-testid="set-auto" /> Notify automatically (otherwise use the button on a shift)</label>
          <div className="flex flex-wrap gap-3">
            <label className="text-sm">Automatic window (hours before the shift)<input className={inputClass} inputMode="numeric" value={s.windowHours} onChange={(e) => setDraft({ ...s, windowHours: num(e.target.value, 1, 336, s.windowHours) })} /></label>
            <label className="text-sm">Most caregivers per shift<input className={inputClass} inputMode="numeric" value={s.maxRecipients} onChange={(e) => setDraft({ ...s, maxRecipients: num(e.target.value, 1, 200, s.maxRecipients) })} /></label>
          </div>
          <label className="block text-sm">Who is told
            <select className={inputClass} value={s.audience} onChange={(e) => setDraft({ ...s, audience: e.target.value as "office" | "agency" })} data-testid="set-audience">
              <option value="office">Caregivers of the coordinating office</option><option value="agency">Every eligible caregiver of the agency</option>
            </select>
          </label>
          <label className="block text-sm">Subject line
            <input className={inputClass} value={s.subjectTemplate} onChange={(e) => setDraft({ ...s, subjectTemplate: e.target.value })} data-testid="set-subject" />
            <span className="text-xs text-og-sub">Must include {"{city}"} (the service city). Also available: {"{date}"}, {"{time}"}, {"{service}"}. Preview: {previewSubject(s.subjectTemplate)}</span>
          </label>
          {audiences.data && audiences.data.length > 0 ? (
            <fieldset className="space-y-1" data-testid="office-audiences">
              <legend className="text-sm font-semibold text-og-ink">Per office (overrides the setting above)</legend>
              {audiences.data.map((o) => (
                <label key={o.officeId} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="w-44">{o.officeName}</span>
                  <select className="rounded-lg border border-og-line bg-og-card px-2 py-1" aria-label={`Audience for ${o.officeName}`} value={o.audienceOverride ?? ""}
                    onChange={(e) => void setOverride(o.officeId, e.target.value === "" ? null : (e.target.value as "office" | "agency" | "none"))}>
                    <option value="">Use the setting</option><option value="office">Its own caregivers</option><option value="agency">Whole agency</option><option value="none">Nobody (no alerts)</option>
                  </select>
                </label>
              ))}
            </fieldset>
          ) : null}
          {draft ? (
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-sm">Reason for the change<input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="set-reason" /></label>
              <Button onClick={() => void save()}>Save settings</Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {note ? <p role={note.ok ? "status" : "alert"} className={`mt-1 text-sm ${note.ok ? "text-og-sub" : "text-red-700"}`}>{note.text}</p> : null}
      {hasPermission("shifts.manage") ? (
        <div className="mt-3">
          <h3 className="text-sm font-semibold text-og-ink">What was sent</h3>
          {history.isLoading ? <p className="text-sm text-og-sub">Loading…</p> : null}
          {history.isError ? <p role="alert" className="text-sm text-red-700">The history could not be loaded.</p> : null}
          {history.data && history.data.length === 0 ? <p className="text-sm text-og-sub" data-testid="history-empty">Nothing has been sent yet.</p> : null}
          {rows.length > 0 ? (
            <div className="overflow-x-auto"><table className="w-full text-left text-sm" aria-label="Cover-shift notification history">
              <thead><tr className="text-xs uppercase tracking-wide text-og-sub">
                <SortTh sort={sort} column="when" kind="date" className="py-1 pr-3">When</SortTh><SortTh sort={sort} column="caregiver" className="py-1 pr-3">Caregiver</SortTh>
                <SortTh sort={sort} column="inApp" className="py-1 pr-3">In the app</SortTh><SortTh sort={sort} column="email" className="py-1 pr-3">Email</SortTh><SortTh sort={sort} column="attempts" kind="number" className="py-1">Attempts</SortTh>
              </tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.notificationId} className="border-t border-og-line">
                  <td className="py-1 pr-3 whitespace-nowrap">{formatNumericDate(r.createdAt)} {formatClockTime(r.createdAt)}</td><td className="py-1 pr-3">{r.caregiverCode ?? "—"}</td>
                  <td className="py-1 pr-3">{r.inApp ? (r.readAt ? "Read" : "Unread") : "Hidden by preference"}</td>
                  <td className="py-1 pr-3">{r.emailStatus ? STATUS_WORD[r.emailStatus] ?? r.emailStatus : "Off"}{r.emailError ? <span className="block text-xs text-og-sub">{r.emailError.replace(/_/g, " ")}</span> : null}</td>
                  <td className="py-1">{r.emailAttempts ?? "—"}</td>
                </tr>))}</tbody>
            </table></div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
