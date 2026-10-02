import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@carelik/ui";
import type { AwsApiClient } from "@/lib/aws-api";
import { useOrganization } from "@/providers/organization-provider";

interface CareRequestRow {
  requestId: string;
  clientId: string;
  clientCode: string;
  serviceId: string;
  serviceCode: string;
  serviceName: string;
  requestedStart: string;
  requestedEnd: string;
  status: "new" | "awaiting_responses" | "assigned" | "cancelled" | "closed";
  source: "client_link" | "staff" | "caregiver_callout";
  requestNote: string | null;
  assignedCaregiverRecordId: string | null;
  assignedCaregiverName: string | null;
  assignedShiftId: string | null;
  pendingOfferCount: number;
  availableOfferCount: number;
  unavailableOfferCount: number;
  createdAt: string;
}
interface ClientRow { clientId: string; clientCode: string }
interface CandidateRow {
  caregiverRecordId: string;
  caregiverName: string;
  caregiverCode: string;
  priorityScore: number;
  priorityReason: string;
}
interface OfferRow {
  offerId: string;
  caregiverRecordId: string;
  caregiverName: string;
  status: "pending" | "available" | "unavailable" | "assigned" | "not_selected" | "expired";
  respondedAt: string | null;
  expiresAt: string;
}
interface CreatedOffer { caregiverRecordId: string; offerId: string; token: string }

const statusLabel: Record<CareRequestRow["status"], string> = {
  new: "Needs caregiver",
  awaiting_responses: "Waiting for responses",
  assigned: "Assigned",
  cancelled: "Cancelled",
  closed: "Closed",
};

function when(start: string, end: string) {
  const s = new Date(start);
  const e = new Date(end);
  return `${s.toLocaleDateString([], { month: "short", day: "numeric" })} · ${s.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}–${e.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export function CareRequestsPage({ api }: { api: AwsApiClient }) {
  const { activeOrganizationId } = useOrganization();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set());
  const [linkClientId, setLinkClientId] = useState("");
  const [clientLink, setClientLink] = useState<string | null>(null);
  const [createdOfferLinks, setCreatedOfferLinks] = useState<Array<CreatedOffer & { url: string }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const requestsQuery = useQuery({
    queryKey: ["care-requests", activeOrganizationId],
    queryFn: async () => (await api.get<{ requests: CareRequestRow[] }>("/v1/care-requests", { organizationId: activeOrganizationId! })).requests,
    enabled: !!activeOrganizationId,
    refetchInterval: 15_000,
  });
  const clientsQuery = useQuery({
    queryKey: ["care-request-clients", activeOrganizationId],
    queryFn: async () => (await api.get<{ clients: ClientRow[] }>("/v1/care-requests/clients", { organizationId: activeOrganizationId! })).clients,
    enabled: !!activeOrganizationId,
  });
  const candidatesQuery = useQuery({
    queryKey: ["care-request-candidates", selectedId],
    queryFn: async () => (await api.get<{ candidates: CandidateRow[] }>(`/v1/care-requests/${selectedId}/candidates`)).candidates,
    enabled: !!selectedId,
  });
  const offersQuery = useQuery({
    queryKey: ["care-request-offers", selectedId],
    queryFn: async () => (await api.get<{ offers: OfferRow[] }>(`/v1/care-requests/${selectedId}/offers`)).offers,
    enabled: !!selectedId,
    refetchInterval: selectedId ? 10_000 : false,
  });

  const selectedRequest = useMemo(
    () => (requestsQuery.data ?? []).find((row) => row.requestId === selectedId) ?? null,
    [requestsQuery.data, selectedId],
  );
  const offerByCaregiver = useMemo(
    () => new Map((offersQuery.data ?? []).map((row) => [row.caregiverRecordId, row])),
    [offersQuery.data],
  );

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["care-requests", activeOrganizationId] }),
      queryClient.invalidateQueries({ queryKey: ["care-request-offers", selectedId] }),
      queryClient.invalidateQueries({ queryKey: ["care-request-candidates", selectedId] }),
    ]);
  }

  async function createClientLink() {
    if (!activeOrganizationId || !linkClientId) return;
    setBusy("link"); setMessage(null);
    try {
      const result = await api.post<{ token: string }>(`/v1/clients/${linkClientId}/request-link`, { organizationId: activeOrganizationId });
      setClientLink(`${window.location.origin}/request/${result.token}`);
    } finally { setBusy(null); }
  }

  async function sendAvailabilityRequests() {
    if (!selectedId || selectedCandidates.size === 0) return;
    setBusy("offers"); setMessage(null);
    try {
      const result = await api.post<{ offers: CreatedOffer[] }>(`/v1/care-requests/${selectedId}/offers`, {
        caregiverRecordIds: Array.from(selectedCandidates),
      });
      setCreatedOfferLinks(result.offers.map((offer) => ({ ...offer, url: `${window.location.origin}/opportunity/${offer.token}` })));
      setSelectedCandidates(new Set());
      setMessage("Availability requests created. They are visible in each caregiver's Ogevia app; the secure links below can also be sent directly.");
      await refresh();
    } finally { setBusy(null); }
  }

  async function assign(caregiverRecordId: string) {
    if (!selectedId) return;
    setBusy(`assign:${caregiverRecordId}`); setMessage(null);
    try {
      await api.post(`/v1/care-requests/${selectedId}/assign`, { caregiverRecordId });
      setMessage("Caregiver assigned. The client request now shows the confirmed caregiver.");
      await refresh();
    } finally { setBusy(null); }
  }

  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    setMessage("Link copied.");
  }

  const openRequests = (requestsQuery.data ?? []).filter((row) => row.status === "new" || row.status === "awaiting_responses");
  const completedRequests = (requestsQuery.data ?? []).filter((row) => !openRequests.includes(row));

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Scheduling</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950">Care requests</h1>
        <p className="mt-1 text-sm text-slate-600">
          Clients request care from their link. Ogevia finds schedule-clear caregivers, collects availability, and keeps assignment under agency control.
        </p>
      </div>

      {message ? <div role="status" className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">{message}</div> : null}

      <Card>
        <h2 className="font-semibold text-slate-950">Client request link</h2>
        <p className="mt-1 text-sm text-slate-500">Create one private link for a client/family to request or cancel care without calling the office.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <select aria-label="Client for request link" value={linkClientId} onChange={(e) => setLinkClientId(e.target.value)} className="min-w-56 rounded-lg border border-slate-200 px-3 py-2 text-sm">
            <option value="">Select client</option>
            {(clientsQuery.data ?? []).map((client) => <option key={client.clientId} value={client.clientId}>{client.clientCode}</option>)}
          </select>
          <Button type="button" loading={busy === "link"} disabled={!linkClientId} onClick={() => void createClientLink()}>Create / replace link</Button>
        </div>
        {clientLink ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 p-3">
            <code className="min-w-0 flex-1 break-all text-xs text-slate-700">{clientLink}</code>
            <Button type="button" size="sm" variant="secondary" onClick={() => void copy(clientLink)}>Copy link</Button>
          </div>
        ) : null}
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1.05fr_.95fr]">
        <Card>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-slate-950">Needs attention</h2>
              <p className="text-xs text-slate-500">New client requests and requests waiting on caregivers.</p>
            </div>
            <span className="rounded-full bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white">{openRequests.length}</span>
          </div>
          <div className="mt-3 divide-y divide-slate-100">
            {openRequests.length === 0 ? <p className="py-6 text-sm text-slate-500">No open care requests.</p> : openRequests.map((row) => (
              <button key={row.requestId} type="button" onClick={() => { setSelectedId(row.requestId); setCreatedOfferLinks([]); }}
                className="block w-full py-3 text-left hover:bg-slate-50">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-slate-900">{row.clientCode} · {row.serviceCode}</p>
                    <p className="mt-0.5 text-sm text-slate-600">{when(row.requestedStart, row.requestedEnd)}</p>
                  </div>
                  <span className="rounded-full bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">{statusLabel[row.status]}</span>
                </div>
                <p className="mt-1 text-xs text-slate-500">{row.availableOfferCount} available · {row.pendingOfferCount} waiting · {row.unavailableOfferCount} unavailable</p>
              </button>
            ))}
          </div>
        </Card>

        <Card>
          <h2 className="font-semibold text-slate-950">{selectedRequest ? `${selectedRequest.clientCode} · ${selectedRequest.serviceCode}` : "Select a request"}</h2>
          {!selectedRequest ? <p className="mt-2 text-sm text-slate-500">Choose a request to find and contact caregivers.</p> : (
            <div className="mt-3 space-y-4">
              <div className="rounded-lg bg-slate-50 p-3 text-sm">
                <p className="font-medium text-slate-800">{when(selectedRequest.requestedStart, selectedRequest.requestedEnd)}</p>
                {selectedRequest.requestNote ? <p className="mt-1 text-slate-600">{selectedRequest.requestNote}</p> : null}
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900">Best schedule-clear caregivers</h3>
                  <span className="text-xs text-slate-500">Agency assigns after acceptance</span>
                </div>
                <div className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
                  {(candidatesQuery.data ?? []).map((candidate) => {
                    const offer = offerByCaregiver.get(candidate.caregiverRecordId);
                    const checked = selectedCandidates.has(candidate.caregiverRecordId);
                    return (
                      <div key={candidate.caregiverRecordId} className="flex items-center gap-3 p-3">
                        <input type="checkbox" aria-label={`Select ${candidate.caregiverName}`} checked={checked}
                          disabled={!!offer && offer.status !== "expired"}
                          onChange={() => setSelectedCandidates((current) => {
                            const next = new Set(current);
                            if (next.has(candidate.caregiverRecordId)) next.delete(candidate.caregiverRecordId); else next.add(candidate.caregiverRecordId);
                            return next;
                          })} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-slate-900">{candidate.caregiverName}</p>
                          <p className="text-xs text-slate-500">{candidate.priorityScore}% · {candidate.priorityReason}</p>
                        </div>
                        {offer ? (
                          <div className="text-right">
                            <p className="text-xs font-semibold capitalize text-slate-700">{offer.status.replace("_", " ")}</p>
                            {offer.status === "available" ? (
                              <Button type="button" size="sm" loading={busy === `assign:${candidate.caregiverRecordId}`} onClick={() => void assign(candidate.caregiverRecordId)}>Assign</Button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <Button type="button" className="mt-3" loading={busy === "offers"} disabled={selectedCandidates.size === 0} onClick={() => void sendAvailabilityRequests()}>
                  Request availability ({selectedCandidates.size})
                </Button>
              </div>

              {createdOfferLinks.length > 0 ? (
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">Secure caregiver links</h3>
                  <p className="mt-1 text-xs text-slate-500">Caregivers can answer in the app. Use these links when you also want to send a direct message.</p>
                  <div className="mt-2 space-y-2">
                    {createdOfferLinks.map((offer) => {
                      const candidate = (candidatesQuery.data ?? []).find((row) => row.caregiverRecordId === offer.caregiverRecordId);
                      return <div key={offer.offerId} className="flex items-center gap-2 rounded-lg bg-slate-50 p-2">
                        <span className="min-w-0 flex-1 truncate text-xs text-slate-700">{candidate?.caregiverName ?? "Caregiver"} · {offer.url}</span>
                        <Button type="button" size="sm" variant="secondary" onClick={() => void copy(offer.url)}>Copy</Button>
                      </div>;
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </Card>
      </div>

      {completedRequests.length > 0 ? (
        <Card>
          <h2 className="font-semibold text-slate-950">Recent resolved requests</h2>
          <div className="mt-3 divide-y divide-slate-100">
            {completedRequests.slice(0, 20).map((row) => (
              <div key={row.requestId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="text-slate-700">{row.clientCode} · {row.serviceCode} · {when(row.requestedStart, row.requestedEnd)}</span>
                <span className="font-medium text-slate-600">{row.status === "assigned" ? `Assigned to ${row.assignedCaregiverName ?? "caregiver"}` : statusLabel[row.status]}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </section>
  );
}
