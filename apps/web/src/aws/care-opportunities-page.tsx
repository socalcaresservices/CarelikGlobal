import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@carelik/ui";
import type { AwsApiClient } from "@/lib/aws-api";
import { useOrganization } from "@/providers/organization-provider";

interface Opportunity {
  offerId: string;
  requestId: string;
  serviceCode: string;
  serviceName: string;
  requestedStart: string;
  requestedEnd: string;
  offerStatus: "pending" | "available" | "unavailable" | "assigned" | "not_selected" | "expired";
  requestStatus: "new" | "awaiting_responses" | "assigned" | "cancelled" | "closed";
  expiresAt: string;
}

function when(start: string, end: string) {
  const s = new Date(start);
  const e = new Date(end);
  return `${s.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} · ${s.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}–${e.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export function CareOpportunitiesPage({ api }: { api: AwsApiClient }) {
  const { activeOrganizationId } = useOrganization();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const opportunitiesQuery = useQuery({
    queryKey: ["my-care-opportunities", activeOrganizationId],
    queryFn: async () => (await api.get<{ opportunities: Opportunity[] }>("/v1/care-opportunities", { organizationId: activeOrganizationId! })).opportunities,
    enabled: !!activeOrganizationId,
    refetchInterval: 15_000,
  });

  async function respond(offerId: string, available: boolean) {
    setBusy(offerId);
    try {
      await api.post(`/v1/care-opportunities/${offerId}/respond`, { available });
      await queryClient.invalidateQueries({ queryKey: ["my-care-opportunities", activeOrganizationId] });
    } finally {
      setBusy(null);
    }
  }

  const pending = (opportunitiesQuery.data ?? []).filter((row) => row.offerStatus === "pending");
  const history = (opportunitiesQuery.data ?? []).filter((row) => row.offerStatus !== "pending");

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">My schedule</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950">Care opportunities</h1>
        <p className="mt-1 text-sm text-slate-600">Tell the agency whether you are available. Saying Available does not assign the shift; the agency confirms assignments.</p>
      </div>

      {pending.length === 0 ? (
        <Card><p className="text-sm text-slate-500">No availability requests are waiting for you.</p></Card>
      ) : pending.map((row) => (
        <Card key={row.offerId}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Care opportunity</p>
              <h2 className="mt-1 font-semibold text-slate-950">{row.serviceCode} · {row.serviceName}</h2>
              <p className="mt-1 text-sm text-slate-700">{when(row.requestedStart, row.requestedEnd)}</p>
            </div>
            <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">Response needed</span>
          </div>
          <div className="mt-4 flex gap-2">
            <Button type="button" loading={busy === row.offerId} onClick={() => void respond(row.offerId, true)}>Available</Button>
            <Button type="button" variant="secondary" disabled={busy === row.offerId} onClick={() => void respond(row.offerId, false)}>Not available</Button>
          </div>
        </Card>
      ))}

      {history.length > 0 ? (
        <Card>
          <h2 className="font-semibold text-slate-950">Recent responses</h2>
          <div className="mt-3 divide-y divide-slate-100">
            {history.slice(0, 20).map((row) => (
              <div key={row.offerId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="text-slate-700">{row.serviceCode} · {when(row.requestedStart, row.requestedEnd)}</span>
                <span className="font-medium capitalize text-slate-600">{row.offerStatus.replace("_", " ")}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </section>
  );
}
