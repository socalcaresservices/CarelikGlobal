import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@carelik/ui";
import { useLocation } from "react-router-dom";
import type { AwsApiClient } from "@/lib/aws-api";
import { formatClockTime, formatDateTime } from "@/lib/service-verification";

type PortalService = { organizationName: string; clientCode: string; serviceId: string; serviceCode: string; serviceName: string; periodEnd: string };
type CareRequest = { requestId: string; status: string; serviceCode: string; serviceName: string; startsAt: string; endsAt: string; shortNotice: boolean; caregiverName: string | null };
type CareOffer = { offerId: string; status: string; serviceCode: string; serviceName: string; startsAt: string; endsAt: string; clientLabel: string };

/**
 * Link tokens travel in the URL FRAGMENT (/care#<token>): browsers never send
 * the fragment to the web server, so CloudFront access logs and any proxy see
 * only "/care". The token goes to the API only as a path segment that the API
 * access logs record as the route template, never the value.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useLinkToken(): string {
  const { hash } = useLocation();
  const value = hash.replace(/^#/, "");
  return /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : "";
}

const when = (value: string) => formatDateTime(value);
const toIso = (value: string) => new Date(value).toISOString();

const CLOSED_REQUEST = ["client_cancelled", "filled", "closed"];

export function PublicCareRequestPage({ api }: { api: AwsApiClient }) {
  const token = useLinkToken();
  const qc = useQueryClient();
  const [serviceId, setServiceId] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [note, setNote] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const valid = /^[0-9a-f]{64}$/i.test(token);

  const portal = useQuery({
    queryKey: ["public-care-portal", token],
    queryFn: () => api.get<{ services: PortalService[] }>("/v1/public/care-portals/" + token),
    enabled: valid,
  });
  // The link's own upcoming requests: anyone reopening the link (another device,
  // another family member, a reload) sees status and can cancel.
  const requests = useQuery({
    queryKey: ["public-care-requests", token],
    queryFn: () => api.get<{ requests: CareRequest[] }>("/v1/public/care-portals/" + token + "/requests"),
    enabled: valid && portal.isSuccess,
    refetchInterval: 15_000,
  });
  const refreshList = () => void qc.invalidateQueries({ queryKey: ["public-care-requests", token] });
  const create = useMutation({
    mutationFn: () => api.post<{ request: { requestId: string } }>("/v1/public/care-portals/" + token + "/requests", {
      serviceId, startsAt: toIso(startsAt), endsAt: toIso(endsAt), note, requestKey: crypto.randomUUID(),
    }),
    onSuccess: () => {
      setSubmitted(true);
      setStartsAt("");
      setEndsAt("");
      setNote("");
      refreshList();
    },
  });
  const cancel = useMutation({
    mutationFn: (requestId: string) => api.post("/v1/public/care-portals/" + token + "/requests/" + requestId + "/cancel", { reason: "Cancelled through care portal" }),
    onSettled: refreshList,
  });

  const services = portal.data?.services ?? [];
  const orgName = services[0]?.organizationName ?? "Care request";
  if (portal.isLoading) return <PublicShell><p>Loading your care request page…</p></PublicShell>;
  if (portal.isError || services.length === 0) return <PublicShell><p>This care-request link is invalid or no longer active.</p></PublicShell>;
  const list = requests.data?.requests ?? [];

  return (
    <PublicShell title={orgName}>
      <Card>
        <h2 className="text-lg font-semibold text-slate-950">Your requests</h2>
        {submitted ? <p role="status" className="mt-2 text-sm font-medium text-emerald-700">Request received. The agency will select and confirm the caregiver.</p> : null}
        {requests.isLoading ? <p className="mt-2 text-sm text-slate-600">Checking your requests…</p> : null}
        {requests.isError ? <p role="alert" className="mt-2 text-sm text-red-700">Could not load your requests. This page will try again.</p> : null}
        {requests.isSuccess && list.length === 0 ? <p className="mt-2 text-sm text-slate-600">No upcoming requests from this link yet.</p> : null}
        <ul className="mt-3 space-y-3">
          {list.map((r) => (
            <li key={r.requestId} data-request-id={r.requestId} className="rounded-lg border border-slate-200 p-3 text-sm text-slate-700">
              <p><strong>{r.serviceCode}</strong> · {when(r.startsAt)}–{formatClockTime(r.endsAt)}</p>
              <p className="mt-1">Status: <strong>{r.status.replaceAll("_", " ")}</strong>{r.shortNotice ? <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">short notice</span> : null}</p>
              {r.caregiverName ? <p className="mt-1">Assigned caregiver: <strong>{r.caregiverName}</strong></p> : null}
              {!CLOSED_REQUEST.includes(r.status) ? (
                <div className="mt-2">
                  <Button variant="secondary" loading={cancel.isPending && cancel.variables === r.requestId} onClick={() => cancel.mutate(r.requestId)}>Cancel request</Button>
                </div>
              ) : null}
              {cancel.variables === r.requestId ? <ActionError error={cancel.error} fallback="Could not cancel the request. Please try again." /> : null}
            </li>
          ))}
        </ul>
        {list.length > 0 ? <p className="mt-3 text-xs text-slate-500">This page updates automatically. You can close it and reopen the same link later.</p> : null}
      </Card>
      <div className="h-4" />
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
          <ActionError error={create.error} fallback="Could not submit request." />
          <Button disabled={!serviceId || !startsAt || !endsAt} loading={create.isPending} onClick={() => { setSubmitted(false); create.mutate(); }}>Request care</Button>
        </div>
      </Card>
    </PublicShell>
  );
}

export function PublicCareOfferPage({ api }: { api: AwsApiClient }) {
  const token = useLinkToken();
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
    // Refresh on failure too: a 409 usually means the shift was filled or closed meanwhile.
    onSettled: () => void qc.invalidateQueries({ queryKey: ["public-care-offer", token] }),
  });
  const cancel = useMutation({
    mutationFn: () => api.post("/v1/public/care-offers/" + token + "/cancel-assignment", { reason }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["public-care-offer", token] }),
  });
  if (offer.isLoading) return <PublicShell><p>Loading opportunity…</p></PublicShell>;
  if (offer.isError || !offer.data?.offer) return <PublicShell><p>This opportunity link is invalid or no longer active.</p></PublicShell>;
  const item = offer.data.offer;
  return (
    <PublicShell title="Care opportunity">
      <Card>
        <h2 className="text-lg font-semibold text-slate-950">{item.serviceCode} · {item.clientLabel}</h2>
        <p className="mt-2 text-sm text-slate-700">{when(item.startsAt)}–{formatClockTime(item.endsAt)}</p>
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
        <ActionError error={respond.error} fallback="Your answer was not sent. Please try again." />
        <ActionError error={cancel.error} fallback="Your cancellation was not sent. Please try again or call the agency." />
      </Card>
    </PublicShell>
  );
}

/** Shows why a link action failed (the API's safe message), so a failure is never silent. */
function ActionError({ error, fallback }: { error: unknown; fallback: string }) {
  if (!error) return null;
  return <p role="alert" className="mt-3 text-sm text-red-700">{error instanceof Error && error.message ? error.message : fallback}</p>;
}

function PublicShell({ title = "Care request", children }: { title?: string; children: ReactNode }) {
  return <div className="min-h-screen bg-slate-50 px-4 py-8"><main className="mx-auto max-w-lg"><div className="mb-4"><h1 className="text-xl font-semibold text-slate-950">{title}</h1><p className="text-xs uppercase tracking-wide text-slate-400">Powered by Ogevia</p></div>{children}</main></div>;
}
