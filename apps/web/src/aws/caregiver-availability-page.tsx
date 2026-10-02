import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@carelik/ui";
import type { AwsApiClient } from "@/lib/aws-api";
import { useOrganization } from "@/providers/organization-provider";

type WindowRow = { windowId: string; weekday: number | null; specificDate: string | null; startLocal: string; endLocal: string };
type Opportunity = { offerId: string; status: string; serviceCode: string; serviceName: string; startsAt: string; endsAt: string; clientLabel: string };
const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const when = (value: string) => new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

export function CaregiverAvailabilityPage({ api }: { api: AwsApiClient }) {
  const { activeOrganizationId } = useOrganization();
  const qc = useQueryClient();
  const [days, setDays] = useState<Set<number>>(new Set());
  const [start, setStart] = useState("08:00");
  const [end, setEnd] = useState("20:00");

  const availability = useQuery({
    queryKey: ["my-availability", activeOrganizationId],
    queryFn: () => api.get<{ windows: WindowRow[] }>("/v1/availability/me", { organizationId: activeOrganizationId }),
    enabled: !!activeOrganizationId,
  });
  const opportunities = useQuery({
    queryKey: ["my-care-opportunities", activeOrganizationId],
    queryFn: () => api.get<{ opportunities: Opportunity[] }>("/v1/care-opportunities", { organizationId: activeOrganizationId }),
    enabled: !!activeOrganizationId,
    refetchInterval: 15_000,
  });
  useEffect(() => {
    const recurring = (availability.data?.windows ?? []).filter((w) => w.weekday !== null);
    if (!recurring.length) return;
    setDays(new Set(recurring.map((w) => w.weekday!)));
    setStart(recurring[0]!.startLocal.slice(0,5));
    setEnd(recurring[0]!.endLocal.slice(0,5));
  }, [availability.data]);

  const save = useMutation({
    mutationFn: () => api.post("/v1/availability/me", {
      organizationId: activeOrganizationId,
      windows: [...days].map((weekday) => ({ weekday, specific_date: null, start_local: start, end_local: end })),
      unavailableDates: [],
    }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["my-availability", activeOrganizationId] }),
  });
  const respond = useMutation({
    mutationFn: ({ offerId, available }: { offerId: string; available: boolean }) => api.post("/v1/care-opportunities/" + offerId + "/respond", { organizationId: activeOrganizationId, available }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["my-care-opportunities", activeOrganizationId] }),
  });

  return <section className="space-y-6">
    <div><h1 className="text-2xl font-semibold text-slate-950">Availability & opportunities</h1><p className="mt-1 text-sm text-slate-600">Keep your normal availability current. An availability response is not an assignment until the agency confirms it.</p></div>
    <Card>
      <h2 className="font-semibold text-slate-950">My regular availability</h2>
      <div className="mt-3 flex flex-wrap gap-2">{DAYS.map((label,weekday)=><label key={label} className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"><input type="checkbox" checked={days.has(weekday)} onChange={(e)=>setDays((current)=>{const next=new Set(current);if(e.target.checked)next.add(weekday);else next.delete(weekday);return next;})}/>{label}</label>)}</div>
      <div className="mt-3 flex flex-wrap items-end gap-3"><label className="text-sm">From<input type="time" value={start} onChange={(e)=>setStart(e.target.value)} className="mt-1 block rounded-lg border border-slate-200 px-3 py-2"/></label><label className="text-sm">To<input type="time" value={end} onChange={(e)=>setEnd(e.target.value)} className="mt-1 block rounded-lg border border-slate-200 px-3 py-2"/></label><Button disabled={!days.size || start>=end} loading={save.isPending} onClick={()=>save.mutate()}>Save availability</Button></div>
    </Card>
    <Card>
      <h2 className="font-semibold text-slate-950">Care opportunities</h2>
      <div className="mt-3 space-y-3">{(opportunities.data?.opportunities ?? []).map((o)=><div key={o.offerId} className="rounded-lg border border-slate-100 p-3"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-medium text-slate-900">{o.serviceCode} · {o.clientLabel}</p><p className="text-sm text-slate-600">{when(o.startsAt)}–{new Date(o.endsAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</p><p className="text-xs text-slate-500">{o.status.replaceAll("_"," ")}</p></div>{o.status==="sent"?<div className="flex gap-2"><Button size="sm" loading={respond.isPending} onClick={()=>respond.mutate({offerId:o.offerId,available:true})}>Available</Button><Button size="sm" variant="secondary" loading={respond.isPending} onClick={()=>respond.mutate({offerId:o.offerId,available:false})}>Not available</Button></div>:null}</div></div>)}
      {!opportunities.isLoading && (opportunities.data?.opportunities ?? []).length===0?<p className="text-sm text-slate-500">No open opportunities.</p>:null}</div>
    </Card>
  </section>;
}
