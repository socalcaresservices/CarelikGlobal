import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { useWindowLabel } from "./open-shifts-model";
import { deliverySummary, REASON_TEXT, type CoverageAlert, type CoverageRequest, type OpenShiftReport, type QueueItem } from "./coverage-model";
import { useAgencyClock as useAgencyClockLite } from "./agency-clock";
import { Hint } from "./hint";
import { linkClass } from "./ui-classes";

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

function Requests({ item, onChanged }: { item: QueueItem; onChanged: (text: string) => void }) {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [skip, setSkip] = useState<{ id: string; reason: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const list = useQuery({
    queryKey: ["aws-coverage-requests", activeOrganizationId, item.shiftId],
    queryFn: async () => (await api.get<{ requests: CoverageRequest[] }>(`/v1/coverage-queue/${encodeURIComponent(item.shiftId)}/requests`, { organizationId: activeOrganizationId })).requests,
    enabled: !!activeOrganizationId,
  });
  async function confirm(r: CoverageRequest, reason: string | null) {
    if (busy) return;
    if (!keys.current.has(r.requestId)) keys.current.set(r.requestId, newIdempotencyKey());
    setBusy(r.requestId); setError(null);
    try {
      await api.post(`/v1/coverage-requests/${encodeURIComponent(r.requestId)}/confirm`, { organizationId: activeOrganizationId, ...(reason ? { skipReason: reason } : {}) }, { idempotencyKey: keys.current.get(r.requestId)! });
      keys.current.delete(r.requestId);
      setSkip(null);
      onChanged(`${r.caregiverName ?? r.caregiverCode} is assigned. The other requests were closed as filled.`);
    } catch (cause) {
      keys.current.delete(r.requestId);
      setError(message(cause, "Not confirmed. Nothing was assigned."));
    } finally {
      setBusy(null);
      await Promise.all(["aws-coverage-requests", "aws-coverage-queue", "aws-shifts"].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
    }
  }
  if (list.isLoading) return <p className="text-sm text-slate-500">Loading requests…</p>;
  if (list.isError) return <p role="alert" className="text-sm text-red-700">Requests could not be loaded.</p>;
  if (!list.data || list.data.length === 0) return <p data-testid="no-requests" className="text-sm text-slate-700">No requests yet. Nobody has asked for this shift, so recruit if it is urgent.</p>;
  const first = list.data.find((r) => r.preselected);
  return (
    <ol className="space-y-1.5" data-testid="request-list">
      {list.data.map((r) => (
        <li key={r.requestId} className={`rounded-lg border p-2 text-sm ${r.preselected ? "border-emerald-400 bg-emerald-50" : "border-slate-200 bg-og-card"}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold text-slate-950">#{r.orderPosition} {r.caregiverName ?? r.caregiverCode} ({r.caregiverCode}){r.preselected ? " · earliest eligible" : ""}</p>
            {skip?.id !== r.requestId ? (
              <Button type="button" className="min-h-11" disabled={busy !== null || !r.eligible} loading={busy === r.requestId}
                onClick={() => (r.preselected || !first ? void confirm(r, null) : setSkip({ id: r.requestId, reason: "" }))}>Confirm assignment</Button>
            ) : null}
          </div>
          {r.blockers.length > 0 ? <p role="note" className="mt-1 text-red-800">Cannot be approved now: {r.blockers.join(" ")}</p> : null}
          {skip?.id === r.requestId ? (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="text-xs font-medium text-slate-600">An earlier eligible request exists. Why choose this caregiver?
                <input value={skip.reason} maxLength={500} onChange={(e) => setSkip({ id: r.requestId, reason: e.target.value })} className="mt-1 block w-72 max-w-full rounded-lg border border-slate-200 px-3 py-2 text-base" />
              </label>
              <Button type="button" className="min-h-11" disabled={busy !== null || skip.reason.trim().length < 3} loading={busy === r.requestId} onClick={() => void confirm(r, skip.reason.trim())}>Confirm with this reason</Button>
              <button type="button" className="inline-flex min-h-11 items-center text-sm underline" onClick={() => setSkip(null)}>Cancel</button>
            </div>
          ) : null}
        </li>
      ))}
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
    </ol>
  );
}

function ReportPanel() {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const rep = useQuery({
    queryKey: ["aws-open-shift-report", activeOrganizationId],
    queryFn: async () => (await api.get<{ report: OpenShiftReport }>("/v1/open-shift-report", { organizationId: activeOrganizationId, from, to })).report,
    enabled: !!activeOrganizationId,
  });
  const r = rep.data;
  if (!r) return rep.isError ? <p role="alert" className="text-sm text-red-700">The report could not be loaded.</p> : null;
  const t = (k: string) => Number(r.texts[k] ?? 0);
  return (
    <section aria-labelledby="report-heading" data-testid="open-shift-report" className="rounded-lg border border-slate-200 bg-og-card p-3 text-sm">
      <h2 id="report-heading" className="text-base font-semibold text-slate-950">Last 30 days</h2>
      <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
        <div><dt className="text-slate-600">Need coverage now</dt><dd className="font-semibold">{r.openings.currentlyNeedCoverage}</dd></div>
        <div><dt className="text-slate-600">On the board</dt><dd className="font-semibold">{r.openings.currentlyPosted}</dd></div>
        <div><dt className="text-slate-600">Filled</dt><dd className="font-semibold">{r.openings.filled}</dd></div>
        <div><dt className="text-slate-600">Escalations</dt><dd className="font-semibold">{r.openings.escalations}</dd></div>
        <div><dt className="text-slate-600">Texts sent</dt><dd className="font-semibold">{t("accepted") + t("delivered")}</dd></div>
        <div><dt className="text-slate-600">Texts failed</dt><dd className="font-semibold">{t("failed") + t("unknown")}</dd></div>
        <div><dt className="text-slate-600">Urgent unfilled</dt><dd className="font-semibold">{r.openings.urgentUnfilledNow}</dd></div>
        <div><dt className="text-slate-600">Monthly texts</dt><dd className="font-semibold" data-testid="quota">{r.quota.used} of {r.quota.limit}</dd></div>
      </dl>
    </section>
  );
}

function AlertsPanel() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const { when } = useAgencyClockLite();
  const [error, setError] = useState<string | null>(null);
  const alerts = useQuery({
    queryKey: ["aws-coverage-alerts", activeOrganizationId],
    queryFn: async () => (await api.get<{ alerts: CoverageAlert[] }>("/v1/coverage-alerts", { organizationId: activeOrganizationId })).alerts,
    enabled: !!activeOrganizationId,
  });
  async function requeue(a: CoverageAlert) {
    setError(null);
    const unknown = a.jobStatus === "unknown";
    if (unknown && !window.confirm("The outcome is unknown. Send again only if the person confirms they did not receive it. Send again?")) return;
    try {
      await api.post(`/v1/notification-jobs/${encodeURIComponent(a.jobId!)}/requeue`, { organizationId: activeOrganizationId, confirmedNotReceived: unknown });
      await queryClient.invalidateQueries({ queryKey: ["aws-coverage-alerts"] });
    } catch (cause) { setError(message(cause, "Not queued.")); }
  }
  if (!alerts.data || alerts.data.length === 0) return null;
  return (
    <section aria-labelledby="alerts-heading" data-testid="coverage-alerts" className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
      <h2 id="alerts-heading" className="text-base font-semibold text-slate-950">Recent call-outs, cancellations and notices that need a look</h2>
      {error ? <p role="alert" className="text-red-700">{error}</p> : null}
      <ul className="space-y-1">
        {alerts.data.map((a, i) => (
          <li key={`${a.kind}-${a.jobId ?? a.shiftId}-${i}`} className="flex flex-wrap items-center justify-between gap-2">
            <span>{a.kind === "call_out" ? "Caregiver called out" : a.kind === "client_cancelled" ? "Client cancelled" : `Text not delivered (${a.jobPurpose?.replace(/_/g, " ")}: ${a.jobStatus}${a.jobReason ? `, ${a.jobReason.replace(/_/g, " ")}` : ""})`}
              {" · "}{a.serviceCity ?? "no city"} · {when(a.startsAt)}</span>
            {a.kind === "notification_problem" && (a.jobStatus === "failed" || a.jobStatus === "unknown") ? <button type="button" className="inline-flex min-h-11 items-center underline" onClick={() => void requeue(a)}>Send again</button> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Office: openings that need a caregiver, their posting state, requests in submission order, delivery summary and why they need attention. */
export function CoveragePage() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const label = useWindowLabel();
  const canManage = hasPermission("shifts.manage");
  const [openId, setOpenId] = useState<string | null>(null);
  const [city, setCity] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queue = useQuery({
    queryKey: ["aws-coverage-queue", activeOrganizationId],
    queryFn: async () => (await api.get<{ items: QueueItem[] }>("/v1/coverage-queue", { organizationId: activeOrganizationId })).items,
    enabled: !!activeOrganizationId && canManage,
  });
  const refresh = () => Promise.all(["aws-coverage-queue", "aws-shifts", "attention-overview"].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
  async function act(item: QueueItem, kind: "post-coverage" | "unpost-coverage" | "service-city") {
    if (busy) return;
    setBusy(item.shiftId); setError(null); setNotice(null);
    try {
      await api.post(`/v1/shifts/${encodeURIComponent(item.shiftId)}/${kind}`, { organizationId: activeOrganizationId, ...(kind === "service-city" ? { city: city?.text.trim(), state: "CA" } : {}) });
      setNotice(kind === "post-coverage" ? "Posted for coverage." : kind === "unpost-coverage" ? "Taken off the board. Waiting requests were closed." : "Service city saved.");
      if (kind === "service-city") setCity(null);
    } catch (cause) {
      setError(message(cause, "That did not work. Nothing changed."));
    } finally { setBusy(null); await refresh(); }
  }
  if (!canManage) return <p className="text-sm text-slate-700">You do not have access to the coverage queue.</p>;
  return (
    <div className="max-w-3xl space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold text-slate-950">Coverage</h1>
        {hasPermission("organization.update") ? <Link to="/settings/open-shifts" className={linkClass}>Open shifts and text settings</Link> : null}
      </div>
      <Hint details="Caregivers who cover the shift's service city see it once it is posted. Requests are listed in the order they came in; nobody is assigned until you confirm." show>
        Posting does not assign anyone.
      </Hint>
      <ReportPanel />
      <AlertsPanel />
      {notice ? <p role="status" className="text-sm text-emerald-800">{notice}</p> : null}
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      {queue.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {queue.isError ? <p role="alert" className="text-sm text-red-700">The coverage queue could not be loaded. Refresh the page.</p> : null}
      {queue.data && queue.data.length === 0 ? <p data-testid="queue-empty" className="text-sm text-slate-600">Every upcoming shift has a caregiver.</p> : null}
      <ul className="space-y-2">
        {(queue.data ?? []).map((i) => (
          <li key={i.shiftId} data-testid="queue-item" className="rounded-lg border border-slate-200 bg-og-card p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold text-slate-950">{i.serviceCity ?? "No service city"} · {label(i.startsAt, i.endsAt)}</p>
                <p className="text-slate-800">Client {i.clientCode} · {i.postingState === "posted" ? "On the board" : i.postingState === "unposted" ? "Taken off the board" : "Not posted"}
                  {i.roundNo && i.roundNo > 1 ? ` · round ${i.roundNo}` : ""}{i.formerCaregiverCode ? ` · ${i.formerCaregiverCode} called out` : ""}
                  {i.urgent ? <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 font-semibold text-red-900">Urgent</span> : null}</p>
                <p className="text-slate-700" data-testid="delivery">{i.requestCount} {i.requestCount === 1 ? "request" : "requests"} · {deliverySummary(i.delivery)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {i.postingState !== "posted" ? <Button type="button" className="min-h-11" disabled={busy !== null} loading={busy === i.shiftId} onClick={() => void act(i, "post-coverage")}>Post for Coverage</Button> : <Button type="button" variant="secondary" className="min-h-11" disabled={busy !== null} onClick={() => void act(i, "unpost-coverage")}>Unpost</Button>}
                {i.postingState === "posted" ? <button type="button" className="inline-flex min-h-11 items-center text-sm underline" onClick={() => setOpenId(openId === i.shiftId ? null : i.shiftId)}>{openId === i.shiftId ? "Hide requests" : "Review requests"}</button> : null}
              </div>
            </div>
            {i.postingState !== "posted" ? <p className="mt-1 text-slate-600">Posting shows this shift to caregivers approved for {i.serviceCity ?? "its service city"} and texts opted-in, eligible caregivers once it is within the alert window.</p> : null}
            {i.escalationReasons.map((r) => <p key={r} role="note" className="mt-1 text-amber-900">{REASON_TEXT[r] ?? r}</p>)}
            {i.escalationReasons.includes("missing_city") ? (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <label className="text-xs font-medium text-slate-600">Service city
                  <input value={city?.id === i.shiftId ? city.text : ""} maxLength={80} onChange={(e) => setCity({ id: i.shiftId, text: e.target.value })} className="mt-1 block w-56 max-w-full rounded-lg border border-slate-200 px-3 py-2 text-base" />
                </label>
                <Button type="button" className="min-h-11" disabled={busy !== null || !(city?.id === i.shiftId && city.text.trim().length >= 2)} onClick={() => void act(i, "service-city")}>Save city</Button>
              </div>
            ) : null}
            {openId === i.shiftId ? <div className="mt-2"><Requests item={i} onChanged={setNotice} /></div> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
