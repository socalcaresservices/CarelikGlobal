import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Card } from "@carelik/ui";
import type { AwsApiClient } from "@/lib/aws-api";
import { formatDateTime } from "@/lib/service-verification";
import {
  CHECK_LABEL, COMPONENT_LABEL, ELIGIBILITY, RANKING_NOTE, componentNote, distanceLabel, minutesLabel, percent, scoreLabel,
  type MatchCandidate, type MatchResult,
} from "./readiness-format";

export interface MatchInput {
  clientId: string;
  serviceId: string;
  occurrences: Array<{ startsAt: string; endsAt: string }>;
  excludeShiftId?: string | null;
}

const asMessage = (cause: unknown) => (cause instanceof Error ? cause.message : "Matches could not be loaded.");

/** Ranked caregiver list for one request or schedule. Every value is computed on the server (match-v1). */
export function MatchPanel({
  api, organizationId, input, actionLabel, onAction, actionBusy,
}: {
  api: AwsApiClient;
  organizationId: string;
  input: MatchInput;
  actionLabel: string;
  onAction: (c: MatchCandidate) => void;
  actionBusy?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const key = JSON.stringify(input);
  const matches = useQuery({
    queryKey: ["matches", organizationId, key],
    queryFn: async () =>
      (await api.post<{ matches: MatchResult }>("/v1/matches", { organizationId, ...input })).matches,
    enabled: !!organizationId && input.occurrences.length > 0,
    // POST that reads: never silently reuse an old ranking after availability or documents changed.
    staleTime: 0,
  });

  if (matches.isLoading) return <p className="text-sm text-slate-500" role="status">Checking caregivers…</p>;
  if (matches.isError) {
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
        {asMessage(matches.error)} <button type="button" className="underline" onClick={() => void matches.refetch()}>Try again</button>
      </div>
    );
  }
  const result = matches.data;
  if (!result || result.candidates.length === 0) {
    return <p className="text-sm text-slate-500">No caregivers with Ready or Active status yet. Add caregivers in Care Team.</p>;
  }
  const detail = result.candidates.find((c) => c.caregiverRecordId === open) ?? null;
  return (
    <div className="min-w-0 space-y-3">
      {result.settings.serviceChecks === "off" ? (
        <p role="note" className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">Service approval checks are off for this agency. Approval is shown as unchecked, not as passed.</p>
      ) : null}
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <caption className="sr-only">Caregiver matches, best first</caption>
          <thead className="text-xs text-slate-500">
            <tr><th scope="col" className="pb-2">Caregiver</th><th scope="col">Status</th><th scope="col">Score</th><th scope="col">Availability</th><th scope="col">Approx. distance</th><th scope="col">Experience</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
          </thead>
          <tbody>
            {result.candidates.map((c) => {
              const avail = c.components.find((x) => x.key === "availability");
              const exp = c.components.find((x) => x.key === "experience");
              const e = ELIGIBILITY[c.eligibility];
              return (
                <tr key={c.caregiverRecordId} className="border-t border-slate-100 align-top">
                  <td className="py-2"><p className="font-medium text-slate-900">{c.caregiverName}</p><p className="text-xs text-slate-500">{c.caregiverCode}</p></td>
                  <td><span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${e.className}`}>{e.label}</span>
                    {c.reasons.length ? <p className="mt-1 max-w-[16rem] text-xs text-slate-600">{c.reasons.map((r) => r.label).join(" · ")}</p> : null}</td>
                  <td className={c.scoreStatus === "complete" ? "font-semibold text-slate-900" : "text-slate-600"}>{scoreLabel(c)}</td>
                  <td>{avail ? percent(avail.value) : "—"}{c.cover.occurrences > 1 ? <p className="text-xs text-slate-500">{c.cover.ready} of {c.cover.occurrences} dates</p> : null}</td>
                  <td>{distanceLabel(c.approxDistanceMiles)}</td>
                  <td>{exp?.status === "known" ? `${c.verifiedMatches} verified` : exp?.status === "unknown" ? "Not reviewed" : "—"}</td>
                  <td className="whitespace-nowrap py-2">
                    <Button size="sm" variant="secondary" className="min-h-[40px]" aria-expanded={open === c.caregiverRecordId} onClick={() => setOpen(open === c.caregiverRecordId ? null : c.caregiverRecordId)}>Why</Button>{" "}
                    <Button size="sm" className="min-h-[40px]" disabled={c.eligibility === "not_eligible" || actionBusy} onClick={() => onAction(c)}>{actionLabel}</Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">{RANKING_NOTE} Distance is straight-line between ZIP codes, not driving time.</p>
      {detail ? <WhyPanel c={detail} version={result.version} radius={result.settings.referenceRadiusMiles} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function WhyPanel({ c, version, radius, onClose }: { c: MatchCandidate; version: string; radius: number; onClose: () => void }) {
  const e = ELIGIBILITY[c.eligibility];
  return (
    <Card className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-slate-950">Why this match — {c.caregiverName}</h3>
          <p className="text-xs text-slate-500">{version} · {e.label} · Score {scoreLabel(c)}{c.scoreStatus === "incomplete" ? " (an input is unknown, so no number is shown)" : ""}</p>
        </div>
        <Button size="sm" variant="secondary" className="min-h-[40px]" onClick={onClose}>Close</Button>
      </div>

      <h4 className="mt-4 text-sm font-semibold text-slate-900">Score parts</h4>
      <table className="mt-1 w-full text-left text-sm">
        <thead className="text-xs text-slate-500"><tr><th scope="col">Part</th><th scope="col">Weight</th><th scope="col">Result</th><th scope="col">Points</th></tr></thead>
        <tbody>
          {c.components.map((x) => (
            <tr key={x.key} className="border-t border-slate-100 align-top">
              <td className="py-1.5">{COMPONENT_LABEL[x.key]}</td>
              <td>{x.status === "not_applicable" ? "—" : percent(x.weight)}</td>
              <td>
                {x.status === "known" ? percent(x.value) : <span className="text-slate-600">{componentNote(x)}</span>}
                {x.key === "availability" ? <p className="text-xs text-slate-500">{minutesLabel(Number((x.detail as { coveredMinutes?: number }).coveredMinutes ?? 0))} of {minutesLabel(Number((x.detail as { requestedMinutes?: number }).requestedMinutes ?? 0))} covered</p> : null}
                {x.key === "location" && x.status === "known" ? <p className="text-xs text-slate-500">{distanceLabel(c.approxDistanceMiles)} against a {radius} mi reference radius</p> : null}
                {x.key === "experience" && x.status === "known" ? <p className="text-xs text-slate-500">{c.verifiedMatches} of {String((x.detail as { requestedTags?: number }).requestedTags ?? 0)} requested tags verified</p> : null}
              </td>
              <td>{x.points === null ? "—" : x.points.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {c.checks && c.checks.length ? (
        <>
          <h4 className="mt-4 text-sm font-semibold text-slate-900">Checks</h4>
          <ul className="mt-1 grid gap-1 sm:grid-cols-2">
            {c.checks.map((k) => (
              <li key={k.key} className="flex items-baseline justify-between gap-2 rounded border border-slate-100 px-2 py-1 text-sm">
                <span>{CHECK_LABEL[k.key] ?? k.key}</span>
                <span className={k.status === "pass" ? "text-teal-800" : k.status === "fail" ? "font-semibold text-red-700" : "text-slate-600"}>{k.label ?? k.status}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {c.matchedTags.length ? (
        <p className="mt-3 text-sm text-slate-700"><span className="font-medium">Verified experience that matched:</span> {c.matchedTags.map((t) => t.name).join(", ")}</p>
      ) : null}

      {c.cover.notCovered.length ? (
        <>
          <h4 className="mt-4 text-sm font-semibold text-slate-900">Dates not covered ({c.cover.notCovered.length} of {c.cover.occurrences})</h4>
          <ul className="mt-1 space-y-1 text-sm">
            {c.cover.notCovered.slice(0, 20).map((n) => (
              <li key={n.startsAt}>{formatDateTime(n.startsAt)} — <span className="text-slate-600">{n.reasons.map((r) => r.label).join(", ") || n.status}</span></li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="mt-3 text-xs text-slate-500">An override can cover availability only. It cannot replace a missing document, service approval, status, client requirement or a schedule conflict.</p>
    </Card>
  );
}
