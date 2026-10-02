import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import type { AwsApiClient } from "@/lib/aws-api";

interface PublicService { serviceId: string; serviceCode: string; serviceName: string }
interface PublicRequest {
  requestId: string;
  serviceCode: string;
  serviceName: string;
  requestedStart: string;
  requestedEnd: string;
  status: "new" | "awaiting_responses" | "assigned" | "cancelled" | "closed";
  caregiverName: string | null;
}
interface PublicContext {
  organizationName: string;
  clientCode: string;
  services: PublicService[];
  requests: PublicRequest[];
}

function localInput(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function when(start: string, end: string) {
  const s = new Date(start), e = new Date(end);
  return `${s.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} · ${s.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}–${e.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export function PublicCareRequestPage({ api }: { api: AwsApiClient }) {
  const { token = "" } = useParams();
  const queryClient = useQueryClient();
  const startDefault = new Date(Date.now() + 24 * 60 * 60 * 1000);
  startDefault.setMinutes(0, 0, 0);
  const endDefault = new Date(startDefault.getTime() + 4 * 60 * 60 * 1000);
  const [serviceId, setServiceId] = useState("");
  const [startsAt, setStartsAt] = useState(localInput(startDefault));
  const [endsAt, setEndsAt] = useState(localInput(endDefault));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const contextQuery = useQuery({
    queryKey: ["public-care-request", token],
    queryFn: async () => (await api.publicGet<{ context: PublicContext }>(`/public/request/${token}`)).context,
    enabled: !!token,
    retry: false,
  });
  const context = contextQuery.data;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!serviceId) return;
    setBusy(true);
    try {
      await api.publicPost(`/public/request/${token}`, {
        serviceId,
        requestedStart: new Date(startsAt).toISOString(),
        requestedEnd: new Date(endsAt).toISOString(),
        note,
      }, { idempotencyKey: crypto.randomUUID() });
      setDone(true);
      setNote("");
      await queryClient.invalidateQueries({ queryKey: ["public-care-request", token] });
    } finally { setBusy(false); }
  }

  async function cancel(requestId: string) {
    if (!window.confirm("Cancel this care request/assignment?")) return;
    await api.publicPost(`/public/request/${token}/cancel`, { requestId, reason: "Cancelled by client/family" });
    await queryClient.invalidateQueries({ queryKey: ["public-care-request", token] });
  }

  if (contextQuery.isLoading) return <main className="mx-auto max-w-xl px-4 py-10"><p className="text-sm text-slate-500">Opening your care request page…</p></main>;
  if (contextQuery.isError || !context) return <main className="mx-auto max-w-xl px-4 py-10"><Card><h1 className="font-semibold text-slate-950">This link is not available</h1><p className="mt-1 text-sm text-slate-600">Ask your care agency for a new request link.</p></Card></main>;

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8">
      <section className="mx-auto max-w-xl space-y-5">
        <div>
          <p className="text-sm font-semibold text-slate-500">{context.organizationName}</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-950">Request care</h1>
          <p className="mt-1 text-sm text-slate-600">Client {context.clientCode} · Submit a request here; you do not need to call the office.</p>
        </div>

        {done ? <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"><strong>Request received.</strong> This page will show when a caregiver is assigned.</div> : null}

        <Card>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label htmlFor="public-service" className="block text-xs font-medium text-slate-600">Service</label>
              <select id="public-service" required value={serviceId} onChange={(e) => setServiceId(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm">
                <option value="">Select service</option>
                {context.services.map((service) => <option key={service.serviceId} value={service.serviceId}>{service.serviceCode} · {service.serviceName}</option>)}
              </select>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="public-start" className="block text-xs font-medium text-slate-600">Start</label>
                <input id="public-start" type="datetime-local" required value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              </div>
              <div>
                <label htmlFor="public-end" className="block text-xs font-medium text-slate-600">End</label>
                <input id="public-end" type="datetime-local" required value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              </div>
            </div>
            <div>
              <label htmlFor="public-note" className="block text-xs font-medium text-slate-600">Note (optional)</label>
              <textarea id="public-note" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 min-h-20 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="Anything the scheduler should know about this request." />
            </div>
            <Button type="submit" loading={busy}>Request care</Button>
          </form>
        </Card>

        <Card>
          <h2 className="font-semibold text-slate-950">My requests</h2>
          <div className="mt-3 divide-y divide-slate-100">
            {context.requests.length === 0 ? <p className="py-3 text-sm text-slate-500">No recent requests.</p> : context.requests.map((request) => (
              <div key={request.requestId} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{request.serviceCode} · {request.serviceName}</p>
                    <p className="text-sm text-slate-600">{when(request.requestedStart, request.requestedEnd)}</p>
                    {request.status === "assigned" && request.caregiverName ? <p className="mt-1 text-sm font-medium text-emerald-700">Confirmed · {request.caregiverName}</p> : <p className="mt-1 text-xs font-medium capitalize text-slate-500">{request.status.replace("_", " ")}</p>}
                  </div>
                  {!["cancelled","closed"].includes(request.status) ? <Button type="button" size="sm" variant="secondary" onClick={() => void cancel(request.requestId)}>Cancel</Button> : null}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <p className="text-center text-[11px] text-slate-400">Powered by Ogevia</p>
      </section>
    </main>
  );
}
