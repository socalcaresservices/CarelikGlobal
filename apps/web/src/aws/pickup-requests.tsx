import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";

/** 0063: a caregiver's request for an open shift. Nothing is assigned until this person confirms; the server re-checks everything at that moment. */
export interface PickupRequest {
  requestId: string; shiftId: string; requestedAt: string; startsAt: string; endsAt: string; minutes: number; clientCode: string; clientName?: string | null; duplicateName?: boolean; serviceName: string | null;
  caregiverRecordId: string; caregiverCode: string; caregiverName: string | null; blockers: string[];
}

export function PickupRequestsPanel({ onDone: _onDone }: { onDone: (text: string) => void }) {
  void _onDone;
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const canManage = hasPermission("shifts.manage");
  const list = useQuery({
    queryKey: ["aws-coverage-queue", activeOrganizationId],
    queryFn: async () => (await api.get<{ items: Array<{ requestCount: number }> }>("/v1/coverage-queue", { organizationId: activeOrganizationId })).items,
    enabled: !!activeOrganizationId && canManage,
  });
  const waiting = (list.data ?? []).reduce((n, i) => n + i.requestCount, 0);
  if (!canManage || waiting === 0) return null;
  return (
    <section className="space-y-1" data-testid="pickup-requests" aria-labelledby="pickup-heading">
      <h2 id="pickup-heading" className="text-base font-semibold text-slate-950">Caregiver requests for open shifts ({waiting})</h2>
      <p className="text-sm text-slate-800">Requests are approved in the <Link to="/schedule/coverage" className="font-semibold text-og-link underline">Coverage queue</Link>, in the order they came in. Nobody is assigned until you confirm.</p>
    </section>
  );
}
