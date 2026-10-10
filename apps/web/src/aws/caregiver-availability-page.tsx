import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@carelik/ui";
import type { AwsApiClient } from "@/lib/aws-api";
import { useOrganization } from "@/providers/organization-provider";
import { formatClockTime, formatDateTime } from "@/lib/service-verification";
import { MyAvailability } from "./readiness/availability-section";

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

  return <section className="max-w-3xl space-y-6">
    <div>
      <h1 className="text-2xl font-semibold text-slate-950">Availability</h1>
      <p className="mt-1 text-sm text-slate-600">Your approved hours are what your agency uses to offer you work. To change them, send a request: your current hours stay in place until an administrator approves it. An availability response is not an assignment.</p>
    </div>
    <MyAvailability />
    <Card>
      <h2 className="font-semibold text-slate-950">Care opportunities</h2>
      <div className="mt-3 space-y-3">{(opportunities.data?.opportunities ?? []).map((o)=><div key={o.offerId} className="rounded-lg border border-slate-100 p-3"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-medium text-slate-900">{o.serviceName} · {o.clientLabel}</p><p className="text-sm text-slate-600">{when(o.startsAt)}–{formatClockTime(o.endsAt)}</p><p className="text-xs capitalize text-slate-500">{o.status.replaceAll("_"," ")}</p></div>{o.status==="sent"?<div className="flex gap-2"><Button size="sm" className="min-h-[40px]" loading={respond.isPending} onClick={()=>respond.mutate({offerId:o.offerId,available:true})}>Available</Button><Button size="sm" variant="secondary" className="min-h-[40px]" loading={respond.isPending} onClick={()=>respond.mutate({offerId:o.offerId,available:false})}>Not available</Button></div>:null}</div></div>)}
      {!opportunities.isLoading && (opportunities.data?.opportunities ?? []).length===0?<p className="text-sm text-slate-500">No open opportunities.</p>:null}</div>
    </Card>
  </section>;
}
