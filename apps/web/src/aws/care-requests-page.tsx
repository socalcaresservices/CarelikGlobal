import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@carelik/ui";
import type { AwsApiClient } from "@/lib/aws-api";
import { useOrganization } from "@/providers/organization-provider";

type RequestRow = { requestId: string; clientCode: string; serviceCode: string; serviceName: string; startsAt: string; endsAt: string; requestedMinutes: number; status: string; shortNotice: boolean; availableCount: number; awaitingCount: number; assignedCaregiverName: string | null };
type Candidate = { caregiverRecordId: string; caregiverName: string; currentClientMatch: boolean; availabilitySource: string };
type Offer = { offerId: string; caregiverRecordId: string; caregiverName: string; status: string; respondedAt: string | null };
type ClientOption = { clientId: string; clientCode: string };
type AlertStaff = { userId: string; displayName: string; selected: boolean };

const when = (value: string) => new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
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
  const candidates = useQuery({
    queryKey: ["care-candidates", activeOrganizationId, selectedRequestId],
    queryFn: () => api.get<{ caregivers: Candidate[] }>("/v1/care-requests/" + selectedRequestId + "/candidates", { organizationId: activeOrganizationId }),
    enabled: !!activeOrganizationId && !!selectedRequestId,
  });
  const offers = useQuery({
    queryKey: ["care-offers", activeOrganizationId, selectedRequestId],
    queryFn: () => api.get<{ offers: Offer[] }>("/v1/care-requests/" + selectedRequestId + "/offers", { organizationId: activeOrganizationId }),
    enabled: !!activeOrganizationId && !!selectedRequestId,
    refetchInterval: selectedRequestId ? 10_000 : false,
  });

  const createPortal = useMutation({
    mutationFn: () => api.post<{ portal: { portalId: string; token: string } }>("/v1/care-portals", { organizationId: activeOrganizationId, clientId }),
    onSuccess: ({ portal }) => setPortalLink(window.location.origin + "/care/" + portal.token),
  });
  const sendOffer = useMutation({
    mutationFn: (caregiverRecordId: string) => api.post<{ offer: { offerId: string; token: string } }>("/v1/care-requests/" + selectedRequestId + "/offers", { organizationId: activeOrganizationId, caregiverRecordId }),
    onSuccess: ({ offer }) => {
      setOfferLink(window.location.origin + "/care-offer/" + offer.token);
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

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold text-slate-950">Care requests</h1><p className="mt-1 text-sm text-slate-600">Client requests, caregiver availability, assignment, and replacement coverage in one queue.</p></div>{(notifications.data?.notifications.length ?? 0) > 0 ? <span className="rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-800">{notifications.data!.notifications.length} new alert{notifications.data!.notifications.length === 1 ? "" : "s"}</span> : null}</div>

      <Card>
        <h2 className="font-semibold text-slate-950">Client request link</h2>
        <p className="mt-1 text-sm text-slate-600">Create once for a client/family. They can bookmark it and request care without calling.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} className="min-w-56 rounded-lg border border-slate-200 px-3 py-2 text-sm">
            <option value="">Select client</option>{(clients.data?.clients ?? []).map((c) => <option key={c.clientId} value={c.clientId}>{c.clientCode}</option>)}
          </select>
          <Button disabled={!clientId} loading={createPortal.isPending} onClick={() => createPortal.mutate()}>Create request link</Button>
        </div>
        {portalLink ? <div className="mt-3 flex items-center gap-2"><input readOnly value={portalLink} className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm" /><Button variant="secondary" onClick={() => void navigator.clipboard.writeText(portalLink)}>Copy</Button></div> : null}
      </Card>

      <Card>
        <h2 className="font-semibold text-slate-950">Who gets new-request alerts</h2>
        <div className="mt-3 flex flex-wrap gap-3">{staffRows.map((s) => <label key={s.userId} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selectedAlertUsers.has(s.userId)} onChange={(e) => setSelectedAlertUsers((current) => { const next=new Set(current); if(e.target.checked) next.add(s.userId); else next.delete(s.userId); return next; })} />{s.displayName}</label>)}</div>
        <Button className="mt-3" variant="secondary" loading={saveAlerts.isPending} onClick={() => saveAlerts.mutate()}>Save alert recipients</Button>
      </Card>

      <Card>
        <h2 className="font-semibold text-slate-950">Request queue</h2>
        <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs text-slate-500"><tr><th className="pb-2">Client</th><th>Service</th><th>When</th><th>Hours</th><th>Status</th><th>Responses</th><th></th></tr></thead><tbody>
          {(requests.data?.requests ?? []).map((r) => <tr key={r.requestId} className="border-t border-slate-100"><td className="py-3">{r.clientCode}</td><td>{r.serviceCode}</td><td>{when(r.startsAt)}{r.shortNotice ? <span className="ml-1 text-amber-700">short notice</span> : null}</td><td>{duration(r.requestedMinutes)}</td><td>{r.status.replaceAll("_"," ")}</td><td>{r.availableCount} available · {r.awaitingCount} waiting</td><td><Button size="sm" variant="secondary" onClick={() => setSelectedRequestId(r.requestId)}>Open</Button></td></tr>)}
        </tbody></table></div>
      </Card>

      {selectedRequestId ? <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="font-semibold text-slate-950">Available caregivers</h2>
          <p className="mt-1 text-xs text-slate-500">Only caregivers whose saved availability covers the request and who have no schedule conflict are shown. Existing client/service matches appear first.</p>
          <div className="mt-3 space-y-2">{(candidates.data?.caregivers ?? []).map((c) => <div key={c.caregiverRecordId} className="flex items-center justify-between rounded-lg border border-slate-100 p-3"><div><p className="text-sm font-medium">{c.caregiverName}</p><p className="text-xs text-slate-500">{c.currentClientMatch ? "Current client/service match · " : ""}{c.availabilitySource}</p></div><Button size="sm" loading={sendOffer.isPending} onClick={() => sendOffer.mutate(c.caregiverRecordId)}>Ask availability</Button></div>)}
          {!candidates.isLoading && (candidates.data?.caregivers ?? []).length === 0 ? <p className="text-sm text-slate-500">No caregivers have confirmed availability for this time.</p> : null}</div>
          {offerLink ? <div className="mt-3 rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">Secure fallback link. Caregivers with Ogevia access also see the opportunity in-app.</p><div className="mt-2 flex gap-2"><input readOnly value={offerLink} className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1 text-xs" /><Button size="sm" variant="secondary" onClick={() => void navigator.clipboard.writeText(offerLink)}>Copy</Button></div></div> : null}
        </Card>
        <Card>
          <h2 className="font-semibold text-slate-950">Responses</h2>
          <div className="mt-3 space-y-2">{(offers.data?.offers ?? []).map((o) => <div key={o.offerId} className="flex items-center justify-between rounded-lg border border-slate-100 p-3"><div><p className="text-sm font-medium">{o.caregiverName}</p><p className="text-xs text-slate-500">{o.status.replaceAll("_"," ")}</p></div>{o.status==="available" ? <Button size="sm" loading={assign.isPending} onClick={() => assign.mutate(o.offerId)}>Assign</Button> : null}</div>)}</div>
        </Card>
      </div> : null}
    </section>
  );
}
