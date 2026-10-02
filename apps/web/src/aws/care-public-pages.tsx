import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@carelik/ui";
import { useParams } from "react-router-dom";
import type { AwsApiClient } from "@/lib/aws-api";

type PortalService = { organizationName: string; clientCode: string; serviceId: string; serviceCode: string; serviceName: string; periodEnd: string };
type CareRequest = { requestId: string; status: string; serviceCode: string; serviceName: string; startsAt: string; endsAt: string; caregiverName: string | null };
type CareOffer = { offerId: string; status: string; serviceCode: string; serviceName: string; startsAt: string; endsAt: string; clientLabel: string };

const when = (value: string) => new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const toIso = (value: string) => new Date(value).toISOString();

export function PublicCareRequestPage({ api }: { api: AwsApiClient }) {
  const { token = "" } = useParams();
  const qc = useQueryClient();
  const [serviceId, setServiceId] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [note, setNote] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);

  const portal = useQuery({
    queryKey: ["public-care-portal", token],
    queryFn: () => api.get<{ services: PortalService[] }>("/v1/public/care-portals/" + token),
    enabled: /^[0-9a-f]{64}$/i.test(token),
  });
  const request = useQuery({
    queryKey: ["public-care-request", token, requestId],
    queryFn: () => api.get<{ request: CareRequest }>("/v1/public/care-portals/" + token + "/requests/" + requestId),
    enabled: !!requestId,
    refetchInterval: 15_000,
  });
  const create = useMutation({
    mutationFn: () => api.post<{ request: { requestId: string } }>("/v1/public/care-portals/" + token + "/requests", {
      serviceId, startsAt: toIso(startsAt), endsAt: toIso(endsAt), note, requestKey: crypto.randomUUID(),
    }),
    onSuccess: (data) => setRequestId(data.request.requestId),
  });
  const cancel = useMutation({
    mutationFn: () => api.post("/v1/public/care-portals/" + token + "/requests/" + requestId + "/cancel", { reason: "Cancelled through care portal" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["public-care-request", token, requestId] }),
  });

  const services = portal.data?.services ?? [];
  const orgName = services[0]?.organizationName ?? "Care request";
  if (portal.isLoading) return <PublicShell><p>Loading your care request page…</p></PublicShell>;
  if (portal.isError || services.length === 0) return <PublicShell><p>This care-request link is invalid or no longer active.</p></PublicShell>;

  return (
    <PublicShell title={orgName}>
      {requestId ? (
        <Card>
          <h2 className="text-lg font-semibold text-slate-950">Request received</h2>
          {request.data?.request ? (
            <div className="mt-3 space-y-2 text-sm text-slate-700">
              <p><strong>{request.data.request.serviceCode}</strong> · {when(request.data.request.startsAt)}–{new Date(request.data.request.endsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
              <p>Status: <strong>{request.data.request.status.replaceAll("_", " ")}</strong></p>
              {request.data.request.caregiverName ? <p>Assigned caregiver: <strong>{request.data.request.caregiverName}</strong></p> : <p>You can close this page. It updates automatically when the agency assigns a caregiver.</p>}
              {!["client_cancelled", "closed"].includes(request.data.request.status) ? (
                <Button variant="secondary" loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel request</Button>
              ) : null}
            </div>
          ) : <p className="mt-2 text-sm text-slate-600">Checking status…</p>}
        </Card>
      ) : (
        <Card>
          <h2 className="text-lg font-semibold text-slate-950">Request care</h2>
          <p className="mt-1 text-sm text-slate-600">Submit the date and time you need care. The agency will select and confirm the caregiver.</p>
          <div className="mt-4 grid gap-3">
            <label className="text-sm">Service
              <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2">
                <option value="">Select service</option>
                {services.map((s) => <option key={s.serviceId} value={s.serviceId}>{s.serviceCode} — {s.serviceName}</option>)}
              </select>
            </label>
            <label className="text-sm">Start<input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" /></label>
            <label className="text-sm">End<input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" /></label>
            <label className="text-sm">Note (optional)<textarea value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2" rows={3} /></label>
            <p className="text-xs text-slate-500">Minimum request: 3 hours. Requests made less than 72 hours ahead are marked short notice.</p>
            {create.isError ? <p className="text-sm text-red-700">{create.error instanceof Error ? create.error.message : "Could not submit request."}</p> : null}
            <Button disabled={!serviceId || !startsAt || !endsAt} loading={create.isPending} onClick={() => create.mutate()}>Request care</Button>
          </div>
        </Card>
      )}
    </PublicShell>
  );
}

export function PublicCareOfferPage({ api }: { api: AwsApiClient }) {
  const { token = "" } = useParams();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const offer = useQuery({
    queryKey: ["public-care-offer", token],
    queryFn: () => api.get<{ offer: CareOffer }>("/v1/public/care-offers/" + token),
    enabled: /^[0-9a-f]{64}$/i.test(token),
    refetchInterval: 15_000,
  });
  const respond = useMutation({
    mutationFn: (available: boolean) => api.post("/v1/public/care-offers/" + token + "/respond", { available }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["public-care-offer", token] }),
  });
  const cancel = useMutation({
    mutationFn: () => api.post("/v1/public/care-offers/" + token + "/cancel-assignment", { reason }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["public-care-offer", token] }),
  });
  if (offer.isLoading) return <PublicShell><p>Loading opportunity…</p></PublicShell>;
  if (offer.isError || !offer.data?.offer) return <PublicShell><p>This opportunity link is invalid or no longer active.</p></PublicShell>;
  const item = offer.data.offer;
  return (
    <PublicShell title="Care opportunity">
      <Card>
        <h2 className="text-lg font-semibold text-slate-950">{item.serviceCode} · {item.clientLabel}</h2>
        <p className="mt-2 text-sm text-slate-700">{when(item.startsAt)}–{new Date(item.endsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
        <p className="mt-1 text-sm">Status: <strong>{item.status.replaceAll("_", " ")}</strong></p>
        {item.status === "sent" ? (
          <div className="mt-4 flex gap-2">
            <Button loading={respond.isPending} onClick={() => respond.mutate(true)}>I’m available</Button>
            <Button variant="secondary" loading={respond.isPending} onClick={() => respond.mutate(false)}>Not available</Button>
          </div>
        ) : null}
        {item.status === "available" ? <p className="mt-4 text-sm text-slate-600">Availability sent. The agency will notify you if you are assigned.</p> : null}
        {item.status === "assigned" ? (
          <div className="mt-4 space-y-2">
            <p className="text-sm font-medium text-emerald-700">You are assigned to this shift.</p>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason if you can no longer work" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
            <Button variant="secondary" disabled={!reason.trim()} loading={cancel.isPending} onClick={() => cancel.mutate()}>I can no longer work this shift</Button>
          </div>
        ) : null}
        {item.status === "filled" ? <p className="mt-4 text-sm text-slate-600">This opportunity has been filled.</p> : null}
      </Card>
    </PublicShell>
  );
}

function PublicShell({ title = "Care request", children }: { title?: string; children: ReactNode }) {
  return <div className="min-h-screen bg-slate-50 px-4 py-8"><main className="mx-auto max-w-lg"><div className="mb-4"><h1 className="text-xl font-semibold text-slate-950">{title}</h1><p className="text-xs uppercase tracking-wide text-slate-400">Powered by Ogevia</p></div>{children}</main></div>;
}
