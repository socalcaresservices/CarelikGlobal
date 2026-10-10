import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Card } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { formatDateOnly } from "@/lib/service-verification";
import { useAwsApi } from "../aws-workspace";
import { actionError, documentStatusLabel } from "./format";

interface Requirement { requirement: "cpr" | "tb"; status: string; validUntil: string | null }

/**
 * Required-document status for one caregiver (CPR and TB). A record counts only when an administrator has verified
 * it and it is still valid under the agency's rule; an upload alone is "Needs review". Separate from approved services.
 */
export function CaregiverDocuments({ caregiverRecordId }: { caregiverRecordId?: string }) {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const q = useQuery({
    queryKey: ["document-readiness", activeOrganizationId, caregiverRecordId ?? "me"],
    queryFn: async () => (await api.get<{ readiness: { requirements: Requirement[] } }>("/v1/document-readiness", { organizationId: activeOrganizationId, caregiverRecordId })).readiness.requirements,
    enabled: !!activeOrganizationId,
  });
  return (
    <Card className="p-4">
      <h2 className="text-base font-semibold text-slate-950">Documents</h2>
      {q.isLoading ? <p className="mt-2 text-sm text-slate-500">Loading…</p> : null}
      {q.isError ? <p role="alert" className="mt-2 text-sm text-red-700">{actionError(q.error, "Document status could not be loaded.")}</p> : null}
      <ul className="mt-2 space-y-2">
        {(q.data ?? []).map((r) => {
          const s = documentStatusLabel(r.status, r.requirement);
          return (
            <li key={r.requirement} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-slate-200 p-3 text-sm">
              <div>
                <p className="font-medium text-slate-900">{r.requirement.toUpperCase()}</p>
                {s.detail ? <p className="text-slate-700">{s.detail}</p> : null}
                {r.validUntil && s.ok ? <p className="text-slate-700">Valid through {formatDateOnly(r.validUntil)}</p> : null}
              </div>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${s.ok ? "bg-emerald-100 text-emerald-950" : s.label === "Setup incomplete" ? "bg-slate-100 text-slate-900" : "bg-amber-100 text-amber-950"}`}>{s.label}</span>
            </li>
          );
        })}
      </ul>
      {hasPermission("documents.read") || hasPermission("documents.manage_own") ? (
        <p className="mt-3 text-sm"><Link to="/documents" className="underline">Open documents</Link></p>
      ) : null}
    </Card>
  );
}
