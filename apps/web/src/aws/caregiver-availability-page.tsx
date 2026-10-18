import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@carelik/ui";
import type { AwsApiClient } from "@/lib/aws-api";
import { useOrganization } from "@/providers/organization-provider";
import { formatClockTime, formatDateTime } from "@/lib/service-verification";
import { MyAvailability } from "./readiness/availability-section";
import { ShortHelp } from "./help-text";


type Opportunity = { offerId: string; status: string; serviceCode: string; serviceName: string; startsAt: string; endsAt: string; clientLabel: string };
const when = (value: string) => formatDateTime(value);

export function CaregiverAvailabilityPage({ api }: { api: AwsApiClient }) {
  const { activeOrganizationId } = useOrganization();
  const qc = useQueryClient();
  const opportunities = useQuery({
    queryKey: ["my-care-opportunities", activeOrganizationId],
    queryFn: () => api.get<{ opportunities: Opportunity[] }>("/v1/care-opportunities", { organizationId: activeOrganizationId }),
    enabled: !!activeOrganizationId,
    refetchInterval: 15_000,
  });
  const respond = useMutation({
    mutationFn: ({ offerId, available }: { offerId: string; available: boolean }) => api.post("/v1/care-opportunities/" + offerId + "/respond", { organizationId: activeOrganizationId, available }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["my-care-opportunities", activeOrganizationId] }),
  });

  const offers = opportunities.data?.opportunities ?? [];
  return <section className="max-w-3xl space-y-4">
    <div>
      <h1 className="text-xl font-semibold text-slate-950">Availability</h1>
      <ShortHelp className="mt-1 text-sm text-slate-600" details="To change your hours, send a request; your current hours stay until an administrator approves it. A response to an opportunity is not an assignment.">Your approved hours decide what work you are offered.</ShortHelp>
    </div>
    <MyAvailability />
    <section aria-labelledby="care-opps-heading" className="space-y-2">
      <h2 id="care-opps-heading" className="text-base font-semibold text-slate-950">Care opportunities</h2>
      {!opportunities.isLoading && offers.length === 0 ? <p className="text-sm text-slate-500">No open opportunities.</p> : null}
      <ul className="space-y-1.5">
        {offers.map((o) => (
          <li key={o.offerId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-og-card p-2">
            <div className="min-w-0">
              <p className="font-medium text-slate-900">{o.serviceName} · {o.clientLabel}</p>
              <p className="text-sm text-slate-600">{when(o.startsAt)}–{formatClockTime(o.endsAt)}{o.status === "sent" ? "" : <span className="capitalize"> · {o.status.replaceAll("_", " ")}</span>}</p>
            </div>
            {o.status === "sent" ? (
              <div className="flex items-center gap-3">
                <Button className="min-h-11" loading={respond.isPending} onClick={() => respond.mutate({ offerId: o.offerId, available: true })}>Available</Button>
                <button type="button" className="inline-flex min-h-11 items-center px-1 text-sm font-medium text-og-link underline underline-offset-2 disabled:opacity-50" disabled={respond.isPending} onClick={() => respond.mutate({ offerId: o.offerId, available: false })}>Not available</button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  </section>;
}
