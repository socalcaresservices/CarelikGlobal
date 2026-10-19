import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@carelik/ui";
import type { AwsApiClient } from "@/lib/aws-api";
import { useOrganization } from "@/providers/organization-provider";
import { formatDateTime } from "@/lib/service-verification";
import { MatchingPanel } from "./readiness/matching-panel";
import { ShortHelp } from "./help-text";
import { SummarySection } from "./ui/summary-section";
import { clientLabel } from "./name-label";


type RequestRow = { requestId: string; clientCode: string; clientName?: string | null; duplicateName?: boolean; serviceCode: string; serviceName: string; startsAt: string; endsAt: string; requestedMinutes: number; status: string; shortNotice: boolean; availableCount: number; awaitingCount: number; assignedCaregiverName: string | null };
type Offer = { offerId: string; caregiverRecordId: string; caregiverName: string; status: string; respondedAt: string | null };
type ClientOption = { clientId: string; clientCode: string; clientName?: string | null; duplicateName?: boolean };
type AlertStaff = { userId: string; displayName: string; selected: boolean };

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

  const requests = useQuery({
    queryKey: ["care-requests", activeOrganizationId],
    queryFn: () => api.get<{ requests: RequestRow[] }>("/v1/care-requests", { organizationId: activeOrganizationId }),
    enabled: !!activeOrganizationId,
    refetchInterval: 15_000,
  });
  const notifications = useQuery({
    queryKey: ["care-notifications", activeOrganizationId],
    queryFn: () => api.get<{ notifications: Array<{ notificationId: string; eventKey: string }> }>("/v1/care-notifications", { organizationId: activeOrganizationId }),
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

  const queue = requests.data?.requests ?? [];
  const alertCount = notifications.data?.notifications.length ?? 0;
  const shortNotice = queue.filter((r) => r.shortNotice).length;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">Care requests</h1>
          {requests.data ? <p className="mt-1 text-sm text-slate-700">{queue.length === 0 ? "No open requests." : `${queue.length} open request${queue.length === 1 ? "" : "s"}${shortNotice > 0 ? `, ${shortNotice} short notice` : ""}.`}</p> : null}
        </div>
        {alertCount > 0 ? <span className="rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-900">{alertCount} new alert{alertCount === 1 ? "" : "s"}</span> : null}
      </div>

      {requests.isError ? <p role="alert" className="text-sm text-red-700">The request queue could not be loaded. Reload the page.</p> : null}
      {queue.length > 0 ? (
        <table className="w-full text-left text-sm" aria-label="Request queue">
          <thead><tr className="text-xs uppercase tracking-wide text-slate-600"><th scope="col" className="pb-1 pr-2 font-semibold">Request</th><th scope="col" className="pb-1 pr-2 font-semibold">Status</th><th scope="col" className="pb-1"><span className="sr-only">Action</span></th></tr></thead>
          <tbody>
            {queue.map((r) => (
              <tr key={r.requestId} className="border-t border-slate-100 align-top">
                <th scope="row" className="py-2 pr-2 text-left font-normal">
                  <span className="block font-semibold text-slate-950">{clientLabel(r)} · {r.serviceName}</span>
                  <span className="block text-slate-700">{when(r.startsAt)} · {duration(r.requestedMinutes)}{r.shortNotice ? <span className="ml-1 font-semibold text-amber-900">short notice</span> : null}</span>
                </th>
                <td className="py-2 pr-2"><span className="block capitalize text-slate-900">{r.status.replaceAll("_", " ")}</span><span className="block text-slate-700">{r.availableCount} available · {r.awaitingCount} waiting</span></td>
                <td className="py-2"><Button size="sm" variant="secondary" className="min-h-[44px] md:min-h-[36px]" onClick={() => setSelectedRequestId(r.requestId)}>Open</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {selectedRequestId ? <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="font-semibold text-slate-950">Matches</h2>
          <ShortHelp className="mt-1 text-xs text-slate-500" details="Checks: approved hours, documents, conflicts, and services where required.">Caregivers are checked first, then ranked. A score never makes a blocked caregiver assignable.</ShortHelp>
          <div className="mt-3"><MatchingPanel requestId={selectedRequestId} onOffer={(id) => sendOffer.mutate(id)} offering={sendOffer.isPending} /></div>
          {offerLink ? <div className="mt-3 rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">Secure fallback link. Caregivers with Ogevia access also see the opportunity in-app.</p><div className="mt-2 flex gap-2"><input readOnly value={offerLink} className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1 text-xs" /><Button size="sm" variant="secondary" onClick={() => void navigator.clipboard.writeText(offerLink)}>Copy</Button></div></div> : null}
        </Card>
        <Card>
          <h2 className="font-semibold text-slate-950">Responses</h2>
          <div className="mt-3 space-y-2">{(offers.data?.offers ?? []).map((o) => <div key={o.offerId} className="flex items-center justify-between rounded-lg border border-slate-100 p-3"><div><p className="text-sm font-medium">{o.caregiverName}</p><p className="text-xs text-slate-500">{o.status.replaceAll("_"," ")}</p></div>{o.status==="available" ? <Button size="sm" loading={assign.isPending} onClick={() => assign.mutate(o.offerId)}>Assign</Button> : null}</div>)}</div>
        </Card>
      </div> : null}

      <SummarySection title="Client request link" summary="Create or revoke a family's link">
        <ShortHelp className="text-sm text-slate-600">Create once per family. They bookmark it and request care without calling.</ShortHelp>
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
