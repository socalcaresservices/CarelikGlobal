import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";
import { ELIGIBILITY_LABEL, actionError, scoreLabel } from "./format";
import { InfoTip } from "../ui/info-tip";


export interface Candidate {
  caregiverRecordId: string;
  caregiverCode: string;
  name: string;
  eligibility: "eligible" | "partial" | "not_eligible";
  coverage: { covered: number; total: number; uncoveredDates: string[] };
  blockedChecks: { check: string; message: string; occurrences: number }[];
  warnings: { check: string; message: string }[];
  assignedToClient: boolean;
  scheduledMinutesThatWeek: number;
  score: { ruleVersion: string; ruleStatus: string; complete: boolean; label: string | null; total: number | null; components: { name: string; weight: number; points: number | null; status: string; reason: string }[] };
}
export interface Matches { ruleVersion: string; ruleStatus: string; rankedByScore: boolean; note: string | null; candidates: Candidate[] }

const COMPONENT_NAME: Record<string, string> = { availability: "Availability", location: "Location", experience: "Experience" };

function Why({ c }: { c: Candidate }) {
  return (
    <div className="mt-2 space-y-1 border-t border-slate-100 pt-2 text-xs text-slate-700">
      <ul className="space-y-0.5">
        {c.score.components.map((k) => (
          <li key={k.name}>
            <span className="font-medium">{COMPONENT_NAME[k.name] ?? k.name}</span>
            {k.status === "scored" ? ` ${k.points} of ${k.weight}` : k.status === "missing" ? " missing" : " not counted"}: {k.reason}
          </li>
        ))}
      </ul>
      <p>Score rule {c.score.ruleVersion} ({c.score.ruleStatus}). The score only orders caregivers who are already eligible.</p>
    </div>
  );
}

/**
 * Ranked caregivers for a care request. Eligible caregivers are listed first and can be offered the work; anyone
 * who fails a required check is listed separately with the reason and cannot be offered it. A score never makes a
 * blocked caregiver assignable, and "Score incomplete" is shown when a comparable total cannot be given.
 */
export function MatchingPanel({ requestId, onOffer, offering }: { requestId: string; onOffer: (caregiverRecordId: string) => void; offering?: boolean }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["care-matches", activeOrganizationId, requestId],
    queryFn: async () => (await api.get<{ matches: Matches }>(`/v1/care-requests/${encodeURIComponent(requestId)}/matches`, { organizationId: activeOrganizationId })).matches,
    enabled: !!activeOrganizationId && !!requestId,
  });
  if (q.isLoading) return <p className="text-sm text-slate-500" role="status">Loading…</p>;
  if (q.isError || !q.data) return <p role="alert" className="text-sm text-red-700">{actionError(q.error, "Matches could not be loaded.")}</p>;
  const eligible = q.data.candidates.filter((c) => c.eligibility === "eligible");
  const others = q.data.candidates.filter((c) => c.eligibility !== "eligible");
  return (
    <div className="space-y-3">
      {q.data.note ? <p className="text-xs text-slate-600">{q.data.note}</p> : null}
      {eligible.length === 0 ? <p className="text-sm text-slate-600">No caregiver is eligible for this time. Eligibility needs approved availability, current documents and no conflicts.</p> : null}
      <ul className="space-y-2">
        {eligible.map((c) => (
          <li key={c.caregiverRecordId} className="rounded-md border border-slate-200 px-2 py-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-slate-900">{c.name} <span className="font-normal text-slate-500">({c.caregiverCode})</span></p>
                <p className="text-xs text-slate-600">{ELIGIBILITY_LABEL.eligible}{c.assignedToClient ? " · Already assigned to this client" : ""} · {scoreLabel(c.score)}</p>
                {c.warnings.map((w) => <p key={w.check + w.message} className="text-xs text-amber-900">Will be required after readiness checks are activated: {w.message}</p>)}
              </div>
              <div className="flex gap-2">
                <button type="button" className="min-h-[44px] text-sm underline" aria-expanded={open === c.caregiverRecordId} onClick={() => setOpen(open === c.caregiverRecordId ? null : c.caregiverRecordId)}>Why</button>
                <Button type="button" disabled={offering} onClick={() => onOffer(c.caregiverRecordId)}>Send offer</Button>
              </div>
            </div>
            {open === c.caregiverRecordId ? <Why c={c} /> : null}
          </li>
        ))}
      </ul>
      {others.length ? (
        <details className="rounded-md border border-slate-200 px-2 py-1.5">
          <summary className="min-h-[44px] cursor-pointer text-sm font-medium text-slate-900">Not available ({others.length})</summary>
          <ul className="mt-2 space-y-2">
            {others.map((c) => (
              <li key={c.caregiverRecordId} className="text-sm">
                <p className="font-medium text-slate-900">{c.name} <span className="font-normal text-slate-500">({c.caregiverCode})</span> · {ELIGIBILITY_LABEL[c.eligibility]}{c.coverage.total > 1 ? ` · ${c.coverage.covered} of ${c.coverage.total} dates covered` : ""}</p>
                <ul className="text-xs text-slate-700">{c.blockedChecks.map((b) => <li key={b.check}>{b.message}{c.coverage.total > 1 ? ` (${b.occurrences} of ${c.coverage.total} dates)` : ""}</li>)}</ul>
                {c.blockedChecks.length > 0 && c.blockedChecks.every((b) => b.check === "availability") ? (
                  <div className="mt-1 space-y-1">
                    <p className="flex items-center gap-1.5 text-xs text-slate-600">Excluded from Matches, but an administrator may still offer this work.<InfoTip>At assignment the hours must be approved or covered by a recorded availability override; documents, bookings and client requirements are still checked.</InfoTip></p>
                    <Button type="button" variant="secondary" disabled={offering} onClick={() => onOffer(c.caregiverRecordId)}>Offer manually</Button>
                  </div>
                ) : <p className="mt-1 text-xs text-slate-600">Cannot be offered this work until the item above is resolved.</p>}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
