import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@carelik/ui";
import type { AwsApiClient } from "@/lib/aws-api";
import { useOrganization } from "@/providers/organization-provider";
import { formatDateTime } from "@/lib/service-verification";
import { MatchingPanel } from "./readiness/matching-panel";
import { Hint } from "./hint";
import { SummarySection } from "./ui/summary-section";
import { clientLabel } from "./name-label";
import { ApiRequestError } from "@/lib/aws-api";
import { SortButton, SortTh } from "./ui/sort-th";
import { useSortedRows } from "./ui/table-sort";
import { InfoTip } from "./ui/info-tip";


type RequestRow = { requestId: string; clientCode: string; clientName?: string | null; duplicateName?: boolean; serviceCode: string; serviceName: string; startsAt: string; endsAt: string; requestedMinutes: number; status: string; shortNotice: boolean; availableCount: number; awaitingCount: number; assignedCaregiverName: string | null };
type Offer = { offerId: string; caregiverRecordId: string; caregiverName: string; status: string; respondedAt: string | null };
type ClientOption = { clientId: string; clientCode: string; clientName?: string | null; duplicateName?: boolean };
type AlertStaff = { userId: string; displayName: string; selected: boolean };

type CareAlert = { notificationId: string; careRequestId?: string; eventKey: string; createdAt?: string };
type View = "unresolved" | "all" | "closed";

/** A request in one of these states needs no more action from the office: it is shown only under Closed (or All). */
const RESOLVED_STATUSES = new Set(["assigned", "filled", "closed", "client_cancelled"]);
const isResolved = (status: string) => RESOLVED_STATUSES.has(status);
const ALERT_LABEL: Record<string, string> = {
  care_request_created: "New request", client_cancelled: "Client cancelled", client_cancelled_short_notice: "Client cancelled (short notice)",
  caregiver_available: "Caregiver is available", caregiver_unavailable: "Caregiver declined", assignment_confirmed: "Assignment confirmed", coverage_needed: "Coverage needed",
};
const alertLabel = (key: string) => ALERT_LABEL[key] ?? key.replaceAll("_", " ");
const when = (value: string) => formatDateTime(value);
const duration = (minutes: number) => minutes % 60 ? Math.floor(minutes / 60) + " hr " + (minutes % 60) + " min" : (minutes / 60) + " hr";

export function CareRequestsPage({ api }: { api: AwsApiClient }) {
  const { activeOrganizationId } = useOrganization();
  const qc = useQueryClient();
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [portalLink, setPortalLink] = useState("");
  const [offerLink, setOfferLink] = useState("");
  const [selectedAlertUsers, setSelectedAlertUsers] = useState<Set<string>>(new Set());
  const [alertsInitialized, setAlertsInitialized] = useState(false);
  const [view, setView] = useState<View>("unresolved");
  const [alertsOpen, setAlertsOpen] = useState(false);

  const requests = useQuery({
    queryKey: ["care-requests", activeOrganizationId],
    queryFn: () => api.get<{ requests: RequestRow[] }>("/v1/care-requests", { organizationId: activeOrganizationId }),
    enabled: !!activeOrganizationId,
    refetchInterval: 15_000,
  });
  const notifications = useQuery({
    queryKey: ["care-notifications", activeOrganizationId],
    queryFn: () => api.get<{ notifications: CareAlert[] }>("/v1/care-notifications", { organizationId: activeOrganizationId }),
    enabled: !!activeOrganizationId,
    refetchInterval: 15_000,
  });
  const clients = useQuery({
    queryKey: ["care-portal-clients", activeOrganizationId],
    queryFn: () => api.get<{ clients: ClientOption[] }>("/v1/care-portals/clients", { organizationId: activeOrganizationId }),
    enabled: !!activeOrganizationId,
  });
  const staff = useQuery({
    queryKey: ["care-alert-staff", activeOrganizationId],
    queryFn: () => api.get<{ staff: AlertStaff[] }>("/v1/care-alert-staff", { organizationId: activeOrganizationId }),
    enabled: !!activeOrganizationId,
  });
  const offers = useQuery({
    queryKey: ["care-offers", activeOrganizationId, selectedRequestId],
    queryFn: () => api.get<{ offers: Offer[] }>("/v1/care-requests/" + selectedRequestId + "/offers", { organizationId: activeOrganizationId }),
    enabled: !!activeOrganizationId && !!selectedRequestId,
    refetchInterval: selectedRequestId ? 10_000 : false,
  });

  const createPortal = useMutation({
    mutationFn: () => api.post<{ portal: { portalId: string; token: string } }>("/v1/care-portals", { organizationId: activeOrganizationId, clientId }),
    onSuccess: ({ portal }) => setPortalLink(window.location.origin + "/care#" + portal.token),
  });
  const revokePortals = useMutation({
    mutationFn: () => api.post<{ revoked: number }>("/v1/care-portals/revoke", { organizationId: activeOrganizationId, clientId }),
    onSuccess: () => setPortalLink(""),
  });
  const sendOffer = useMutation({
    mutationFn: (caregiverRecordId: string) => api.post<{ offer: { offerId: string; token: string } }>("/v1/care-requests/" + selectedRequestId + "/offers", { organizationId: activeOrganizationId, caregiverRecordId }),
    onSuccess: ({ offer }) => {
      setOfferLink(window.location.origin + "/care-offer#" + offer.token);
      void qc.invalidateQueries({ queryKey: ["care-offers", activeOrganizationId, selectedRequestId] });
      void qc.invalidateQueries({ queryKey: ["care-requests", activeOrganizationId] });
    },
  });
  const assign = useMutation({
    mutationFn: (offerId: string) => api.post("/v1/care-requests/" + selectedRequestId + "/assign", { organizationId: activeOrganizationId, offerId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["care-offers", activeOrganizationId, selectedRequestId] });
      void qc.invalidateQueries({ queryKey: ["care-requests", activeOrganizationId] });
    },
  });
  // 0109 (behind the requestCleanup switch): the caller's own alerts are marked read, all at once or one when it is opened.
  const markRead = useMutation({
    mutationFn: (ids: string[] | null) => api.post<{ marked: number }>("/v1/care-notifications/read", { organizationId: activeOrganizationId, ids }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["care-notifications", activeOrganizationId] }),
  });
  const saveAlerts = useMutation({
    mutationFn: () => api.post("/v1/care-alert-staff", { organizationId: activeOrganizationId, userIds: [...selectedAlertUsers] }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["care-alert-staff", activeOrganizationId] }),
  });

  const staffRows = staff.data?.staff ?? [];
  useEffect(() => {
    if (staff.data && !alertsInitialized) {
      setSelectedAlertUsers(new Set(staff.data.staff.filter((s) => s.selected).map((s) => s.userId)));
      setAlertsInitialized(true);
    }
  }, [staff.data, alertsInitialized]);

  const all = requests.data?.requests ?? [];
  const open = all.filter((r) => !isResolved(r.status));
  const closed = all.filter((r) => isResolved(r.status));
  const viewRows = view === "unresolved" ? open : view === "closed" ? closed : all;
  const { rows: queue, sort } = useSortedRows(viewRows, {
    client: { get: (r) => clientLabel(r) },
    when: { get: (r) => r.startsAt, kind: "date" },
    status: { get: (r) => r.status },
  });
  const alerts = notifications.data?.notifications ?? [];
  const alertCount = alerts.length;
  const shortNotice = open.filter((r) => r.shortNotice).length;
  const selected = all.find((r) => r.requestId === selectedRequestId) ?? null;
  const byId = new Map(all.map((r) => [r.requestId, r]));
  const openRequest = (id: string) => { setSelectedRequestId(id); if (!open.some((r) => r.requestId === id)) setView("all"); };
  const markReadError = markRead.isError
    ? markRead.error instanceof ApiRequestError && markRead.error.status === 404 && markRead.error.code !== "not_found" ? "Clearing alerts is not available in this environment yet." : "The alerts were not cleared. Try again."
    : null;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-950">Care requests</h1>
          {requests.data ? <p className="mt-1 text-sm text-slate-700">{open.length === 0 ? "No requests need action." : `${open.length} request${open.length === 1 ? "" : "s"} need${open.length === 1 ? "s" : ""} action${shortNotice > 0 ? `, ${shortNotice} short notice` : ""}.`}</p> : null}
        </div>
        {alertCount > 0 ? <button type="button" aria-expanded={alertsOpen} aria-controls="care-alerts" onClick={() => setAlertsOpen((v) => !v)} className="min-h-[44px] rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-900 underline-offset-2 hover:underline md:min-h-[32px]">{alertCount} new alert{alertCount === 1 ? "" : "s"}</button> : null}
      </div>

      {alertsOpen && alertCount > 0 ? (
        <div id="care-alerts" className="rounded-og border border-amber-200 bg-amber-50 p-3" aria-label="New alerts">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-950">New alerts</h2>
            <Button size="sm" variant="secondary" loading={markRead.isPending} onClick={() => markRead.mutate(null)}>Mark all read</Button>
          </div>
          <ul className="mt-2 divide-y divide-amber-200 text-sm">
            {alerts.map((a) => {
              const r = a.careRequestId ? byId.get(a.careRequestId) : undefined;
              return (
                <li key={a.notificationId} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span><span className="font-semibold">{alertLabel(a.eventKey)}</span>{r ? ` · ${clientLabel(r)} · ${r.serviceName} · ${when(r.startsAt)}` : ""}{a.createdAt ? <span className="text-slate-600"> · {when(a.createdAt)}</span> : null}</span>
                  <span className="flex gap-2">
                    {r ? <Button size="sm" variant="secondary" onClick={() => { openRequest(r.requestId); markRead.mutate([a.notificationId]); }}>Open request</Button> : null}
                    <Button size="sm" variant="secondary" onClick={() => markRead.mutate([a.notificationId])}>Mark read</Button>
                  </span>
                </li>
              );
            })}
          </ul>
          {markReadError ? <p role="alert" className="mt-2 text-sm text-red-700">{markReadError}</p> : null}
        </div>
      ) : null}

      {requests.data && all.length > 0 ? (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Show requests">
          {([["unresolved", "Needs action", open.length], ["closed", "Closed", closed.length], ["all", "All", all.length]] as const).map(([key, label, n]) => (
            <button key={key} type="button" aria-pressed={view === key} onClick={() => setView(key)} className={`min-h-[44px] rounded-lg px-3 text-sm font-medium md:min-h-[32px] ${view === key ? "bg-og-accent text-og-on-accent" : "border border-og-line text-og-ink hover:bg-og-page"}`}>{label} {n}</button>
          ))}
        </div>
      ) : null}

      {requests.isError ? <p role="alert" className="text-sm text-red-700">The request queue could not be loaded. Reload the page.</p> : null}
      {requests.data && all.length > 0 && queue.length === 0 ? <p className="text-sm text-slate-700">{view === "unresolved" ? `Nothing needs action.${closed.length > 0 ? ` ${closed.length} closed request${closed.length === 1 ? " is" : "s are"} under Closed.` : ""}` : "No requests here."}</p> : null}
      {queue.length > 0 ? (
        <table className="w-full text-left text-sm" aria-label="Request queue">
          <thead><tr className="text-xs uppercase tracking-wide text-slate-600"><th scope="col" className="pb-1 pr-2 font-semibold" aria-sort={sort.key === "client" || sort.key === "when" ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}><span className="flex flex-wrap gap-x-3"><SortButton sort={sort} column="client">Request</SortButton><SortButton sort={sort} column="when" kind="date">Date</SortButton></span></th><SortTh sort={sort} column="status" className="pb-1 pr-2">Status</SortTh><th scope="col" className="pb-1"><span className="sr-only">Action</span></th></tr></thead>
          <tbody>
            {queue.map((r) => (
              <tr key={r.requestId} className="border-t border-slate-100 align-top">
                <th scope="row" className="py-1.5 pr-2 text-left font-normal">
                  <span className="block font-semibold text-slate-950">{clientLabel(r)} · {r.serviceName}</span>
                  <span className="block text-slate-700">{when(r.startsAt)} · {duration(r.requestedMinutes)}{r.shortNotice ? <span className="ml-1 font-semibold text-amber-900">short notice</span> : null}</span>
                </th>
                <td className="py-1.5 pr-2"><span className="block capitalize text-slate-900">{r.status.replaceAll("_", " ")}</span><span className="block text-slate-700">{r.availableCount} available · {r.awaitingCount} waiting</span></td>
                <td className="py-2"><Button size="sm" variant="secondary" className="min-h-[44px] md:min-h-[36px]" aria-expanded={selectedRequestId === r.requestId} onClick={() => setSelectedRequestId(selectedRequestId === r.requestId ? null : r.requestId)}>{selectedRequestId === r.requestId ? "Close" : "Open"}</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {selected && isResolved(selected.status) ? (
        <Card>
          <h2 className="font-semibold text-slate-950">{clientLabel(selected)} · {selected.serviceName}</h2>
          <p className="mt-1 text-sm text-slate-700">This request is <span className="font-semibold">{selected.status.replaceAll("_", " ")}</span>{selected.assignedCaregiverName ? ` (${selected.assignedCaregiverName})` : ""}. Nothing to match or assign.</p>
          {(offers.data?.offers ?? []).length > 0 ? <ul className="mt-2 space-y-1 text-sm text-slate-700">{(offers.data?.offers ?? []).map((o) => <li key={o.offerId}>{o.caregiverName}: {o.status.replaceAll("_", " ")}</li>)}</ul> : null}
        </Card>
      ) : null}
      {selected && !isResolved(selected.status) ? <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <h2 className="font-semibold text-slate-950">Matches</h2>
          <Hint inline details="Checks: approved hours, documents, conflicts, and services where required.">Caregivers are checked first, then ranked. A score never makes a blocked caregiver assignable.</Hint>
          <div className="mt-3"><MatchingPanel requestId={selected.requestId} onOffer={(id) => sendOffer.mutate(id)} offering={sendOffer.isPending} /></div>
          {offerLink ? <div className="mt-3 rounded-lg bg-slate-50 p-3"><InfoTip inline label="Help">Secure fallback link. Caregivers with Ogevia access also see the opportunity in-app.</InfoTip><div className="mt-2 flex gap-2"><input readOnly value={offerLink} className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1 text-xs" /><Button size="sm" variant="secondary" onClick={() => void navigator.clipboard.writeText(offerLink)}>Copy</Button></div></div> : null}
        </Card>
        <Card>
          <h2 className="font-semibold text-slate-950">Responses</h2>
          <div className="mt-3 space-y-2">{(offers.data?.offers ?? []).map((o) => <div key={o.offerId} className="flex items-center justify-between rounded-lg border border-slate-100 p-3"><div><p className="text-sm font-medium">{o.caregiverName}</p><p className="text-xs text-slate-500">{o.status.replaceAll("_"," ")}</p></div>{o.status==="available" ? <Button size="sm" loading={assign.isPending} onClick={() => assign.mutate(o.offerId)}>Assign</Button> : null}</div>)}</div>
        </Card>
      </div> : null}

      <SummarySection title="Client request link" summary="Create or revoke a family's link">
        <Hint inline>Create once per family. They bookmark it and request care without calling.</Hint>
        <div className="mt-3 flex flex-wrap gap-2">
          <select aria-label="Client" value={clientId} onChange={(e) => setClientId(e.target.value)} className="min-w-56 rounded-lg border border-slate-200 px-3 py-2 text-base">
            <option value="">Select client</option>{(clients.data?.clients ?? []).map((c) => <option key={c.clientId} value={c.clientId}>{clientLabel(c)}</option>)}
          </select>
          <Button disabled={!clientId} loading={createPortal.isPending} onClick={() => createPortal.mutate()}>Create request link</Button>
          <Button variant="secondary" disabled={!clientId} loading={revokePortals.isPending} onClick={() => revokePortals.mutate()}>Revoke this client's links</Button>
        </div>
        {revokePortals.isSuccess ? <p role="status" className="mt-3 text-sm text-slate-700">{revokePortals.data.revoked} link(s) revoked. Old links no longer work; create a new link if needed.</p> : null}
        {revokePortals.isError ? <p role="alert" className="mt-3 text-sm text-red-700">{revokePortals.error instanceof Error ? revokePortals.error.message : "Links were not revoked. Try again."}</p> : null}
        {portalLink ? <div className="mt-3 flex items-center gap-2"><input readOnly aria-label="Request link" value={portalLink} className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm" /><Button variant="secondary" onClick={() => void navigator.clipboard.writeText(portalLink)}>Copy</Button></div> : null}
      </SummarySection>

      <SummarySection title="New-request alerts" summary={staff.data ? `${selectedAlertUsers.size} of ${staffRows.length} staff selected` : undefined}>
        <div className="flex flex-wrap gap-x-4">{staffRows.map((s) => <label key={s.userId} className="flex min-h-[44px] items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={selectedAlertUsers.has(s.userId)} onChange={(e) => setSelectedAlertUsers((current) => { const next=new Set(current); if(e.target.checked) next.add(s.userId); else next.delete(s.userId); return next; })} />{s.displayName}</label>)}</div>
        <Button className="mt-3" variant="secondary" loading={saveAlerts.isPending} onClick={() => saveAlerts.mutate()}>Save alert recipients</Button>
      </SummarySection>
    </section>
  );
}
