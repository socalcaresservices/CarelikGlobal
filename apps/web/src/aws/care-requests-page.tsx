import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@carelik/ui";
import type { AwsApiClient } from "@/lib/aws-api";
import { useOrganization } from "@/providers/organization-provider";
import { formatDateTime } from "@/lib/service-verification";
import { MatchPanel } from "./match-panel";
import type { MatchCandidate } from "./readiness-format";

type RequestRow = { requestId: string; clientCode: string; serviceId: string; serviceCode: string; serviceName: string; startsAt: string; endsAt: string; requestedMinutes: number; status: string; shortNotice: boolean; availableCount: number; awaitingCount: number; assignedCaregiverName: string | null };
type Offer = { offerId: string; caregiverRecordId: string; caregiverName: string; status: string; respondedAt: string | null };
type ClientOption = { clientId: string; clientCode: string };
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
  const [assigning, setAssigning] = useState<string | null>(null);
  const [rationale, setRationale] = useState("");
  const [overrideReason, setOverrideReason] = useState("");

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


  const selected = (requests.data?.requests ?? []).find((r) => r.requestId === selectedRequestId) ?? null;
  const selectedClientId = selected ? (clients.data?.clients ?? []).find((c) => c.clientCode === selected.clientCode)?.clientId ?? null : null;

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
    mutationFn: ({ offerId, rationale, overrideReason }: { offerId: string; rationale: string; overrideReason: string }) =>
      api.post("/v1/care-requests/" + selectedRequestId + "/assign", {
        organizationId: activeOrganizationId, offerId,
        selection: { rationale: rationale.trim() || null, overrideReason: overrideReason.trim() || null },
      }),
    onSuccess: () => {
      setAssigning(null);
      void qc.invalidateQueries({ queryKey: ["care-offers", activeOrganizationId, selectedRequestId] });
      void qc.invalidateQueries({ queryKey: ["care-requests", activeOrganizationId] });
      void qc.invalidateQueries({ queryKey: ["matches"] });
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
          <Button variant="secondary" disabled={!clientId} loading={revokePortals.isPending} onClick={() => revokePortals.mutate()}>Revoke this client's links</Button>
        </div>
        {revokePortals.isSuccess ? <p role="status" className="mt-3 text-sm text-slate-700">{revokePortals.data.revoked} link(s) revoked. Old links no longer work; create a new link if needed.</p> : null}
        {revokePortals.isError ? <p role="alert" className="mt-3 text-sm text-red-700">{revokePortals.error instanceof Error ? revokePortals.error.message : "Could not revoke links."}</p> : null}
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
          {(requests.data?.requests ?? []).map((r) => <tr key={r.requestId} className="border-t border-slate-100"><td className="py-3">{r.clientCode}</td><td title={r.serviceCode}>{r.serviceName}</td><td>{when(r.startsAt)}{r.shortNotice ? <span className="ml-1 text-amber-700">short notice</span> : null}</td><td>{duration(r.requestedMinutes)}</td><td className="capitalize">{r.status.replaceAll("_"," ")}</td><td>{r.availableCount} available · {r.awaitingCount} waiting</td><td><Button size="sm" variant="secondary" className="min-h-[40px]" onClick={() => setSelectedRequestId(r.requestId)}>Open</Button></td></tr>)}
        </tbody></table></div>
      </Card>

      {selectedRequestId ? <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <Card className="min-w-0 lg:col-span-2">
          <h2 className="font-semibold text-slate-950">Matches</h2>
          <p className="mt-1 text-xs text-slate-500">Ranked on the server from approved availability, documents, service approval, location and verified experience. Ask availability first; assigning is a separate step.</p>
          <div className="mt-3">
            {selected && selectedClientId ? (
              <MatchPanel
                api={api}
                organizationId={activeOrganizationId ?? ""}
                input={{ clientId: selectedClientId, serviceId: selected.serviceId, occurrences: [{ startsAt: selected.startsAt, endsAt: selected.endsAt }] }}
                actionLabel="Ask availability"
                actionBusy={sendOffer.isPending}
                onAction={(c: MatchCandidate) => sendOffer.mutate(c.caregiverRecordId)}
              />
            ) : <p className="text-sm text-slate-500" role="status">Loading the client…</p>}
          </div>
          {sendOffer.isError ? <p role="alert" className="mt-2 text-sm text-red-700">{sendOffer.error instanceof Error ? sendOffer.error.message : "The request was not sent."}</p> : null}
          {offerLink ? <div className="mt-3 rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">Secure fallback link. Caregivers with Ogevia access also see the opportunity in-app.</p><div className="mt-2 flex gap-2"><input readOnly value={offerLink} aria-label="Secure offer link" className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1 text-xs" /><Button size="sm" variant="secondary" onClick={() => void navigator.clipboard.writeText(offerLink)}>Copy</Button></div></div> : null}
        </Card>
        <Card className="min-w-0 lg:col-span-2">
          <h2 className="font-semibold text-slate-950">Responses</h2>
          <div className="mt-3 space-y-2">{(offers.data?.offers ?? []).map((o) => <div key={o.offerId} className="rounded-lg border border-slate-100 p-3">
            <div className="flex items-center justify-between"><div><p className="text-sm font-medium">{o.caregiverName}</p><p className="text-xs text-slate-500">{o.status.replaceAll("_"," ")}</p></div>{o.status==="available" ? <Button size="sm" className="min-h-[40px]" onClick={() => { setAssigning(assigning === o.offerId ? null : o.offerId); setRationale(""); setOverrideReason(""); assign.reset(); }}>{assigning === o.offerId ? "Cancel" : "Assign"}</Button> : null}</div>
            {assigning === o.offerId ? <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-3">
              <label className="block text-sm font-medium text-slate-700">Why this caregiver (optional)<input value={rationale} maxLength={500} onChange={(e) => setRationale(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /></label>
              <label className="block text-sm font-medium text-slate-700">Override reason (only if the server says availability needs one)<input value={overrideReason} maxLength={500} onChange={(e) => setOverrideReason(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" /></label>
              {assign.isError ? <p role="alert" className="text-sm text-red-700">{assign.error instanceof Error ? assign.error.message : "The assignment was not saved."}</p> : null}
              <Button loading={assign.isPending} onClick={() => assign.mutate({ offerId: o.offerId, rationale, overrideReason })}>Confirm assignment</Button>
            </div> : null}
          </div>)}
          {!offers.isLoading && (offers.data?.offers ?? []).length === 0 ? <p className="text-sm text-slate-500">No responses yet.</p> : null}</div>
        </Card>
      </div> : null}
    </section>
  );
}
