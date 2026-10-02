import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import type { AwsApiClient } from "@/lib/aws-api";

interface OpportunityContext {
  organizationName: string;
  serviceCode: string;
  serviceName: string;
  requestedStart: string;
  requestedEnd: string;
  offerStatus: "pending" | "available" | "unavailable" | "assigned" | "not_selected" | "expired";
  requestStatus: "new" | "awaiting_responses" | "assigned" | "cancelled" | "closed";
  expiresAt: string;
}

function when(start: string, end: string) {
  const s = new Date(start), e = new Date(end);
  return `${s.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })} · ${s.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}–${e.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export function PublicOpportunityPage({ api }: { api: AwsApiClient }) {
  const { token = "" } = useParams();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const contextQuery = useQuery({
    queryKey: ["public-opportunity", token],
    queryFn: async () => (await api.publicGet<{ context: OpportunityContext }>(`/public/opportunity/${token}`)).context,
    enabled: !!token,
    retry: false,
  });
  const context = contextQuery.data;

  async function respond(available: boolean) {
    setBusy(true);
    try {
      await api.publicPost(`/public/opportunity/${token}/respond`, { available });
      await queryClient.invalidateQueries({ queryKey: ["public-opportunity", token] });
    } finally { setBusy(false); }
  }

  if (contextQuery.isLoading) return <main className="mx-auto max-w-lg px-4 py-10"><p className="text-sm text-slate-500">Opening opportunity…</p></main>;
  if (contextQuery.isError || !context) return <main className="mx-auto max-w-lg px-4 py-10"><Card><h1 className="font-semibold">This opportunity link is not available.</h1></Card></main>;

  const closed = context.offerStatus === "assigned" || context.offerStatus === "not_selected" || context.offerStatus === "expired" || context.requestStatus === "cancelled";

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10">
      <section className="mx-auto max-w-lg space-y-5">
        <div>
          <p className="text-sm font-semibold text-slate-500">{context.organizationName}</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-950">Care opportunity</h1>
          <p className="mt-1 text-sm text-slate-600">Respond here; you do not need to call or text the office.</p>
        </div>
        <Card>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Service</p>
          <h2 className="mt-1 text-lg font-semibold text-slate-950">{context.serviceCode} · {context.serviceName}</h2>
          <p className="mt-2 text-sm text-slate-700">{when(context.requestedStart, context.requestedEnd)}</p>
          <p className="mt-3 text-xs text-slate-500">Choosing Available only tells the agency you can work this time. It is not an assignment until the agency confirms you.</p>

          {closed ? (
            <div className="mt-4 rounded-lg bg-slate-100 p-3 text-sm font-medium capitalize text-slate-700">{context.offerStatus.replace("_", " ")}</div>
          ) : (
            <div className="mt-4 flex gap-2">
              <Button type="button" loading={busy} onClick={() => void respond(true)}>Available</Button>
              <Button type="button" variant="secondary" disabled={busy} onClick={() => void respond(false)}>Not available</Button>
            </div>
          )}
          {!closed && context.offerStatus !== "pending" ? <p className="mt-3 text-sm font-medium capitalize text-emerald-700">Response saved: {context.offerStatus.replace("_", " ")}</p> : null}
        </Card>
        <p className="text-center text-[11px] text-slate-400">Powered by Ogevia</p>
      </section>
    </main>
  );
}
