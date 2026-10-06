import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { buildContinuityHtml, continuityFileName, continuityState, outageNumber, useContinuityStatus, type ContinuityPack } from "./continuity-pack";
import { formatDateTime } from "@/lib/service-verification";

/**
 * Continuity pack (0027): the agency's own recent copy of what it needs to keep
 * working while Ogevia is unavailable. The server decides the agency and the
 * permission (continuity.export); this screen builds a single offline HTML file
 * from the server's answer. The file name carries no client or caregiver names.
 */
export function ContinuityStatusCard() {
  const { hasPermission } = useOrganization();
  const status = useContinuityStatus();
  if (!hasPermission("continuity.export") || status.isLoading) return null;
  const s = continuityState(status.data);
  // Home's "Outage readiness" panel: the former continuity banner's text and link, unchanged,
  // now with a heading. Amber (with text, not colour alone) when the pack is stale.
  return (
    <section aria-labelledby="outage-readiness-heading" className={`rounded-og border p-4 ${s.stale ? "border-2 border-amber-500 bg-amber-50" : "border-og-line bg-white"}`}>
      <h3 id="outage-readiness-heading" className="text-sm font-bold text-og-ink">Outage readiness</h3>
      <p className={`mt-1 text-sm ${s.stale ? "font-bold text-amber-900" : "text-og-sub"}`}>{s.stale ? "OUTAGE READINESS: " : ""}{s.text}.</p>
      <Link to="/continuity" className="mt-2 inline-flex min-h-[40px] items-center text-sm font-semibold text-og-link underline">Continuity pack</Link>
    </section>
  );
}

export function ContinuityPage() {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const status = useContinuityStatus();
  const key = useRef(newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!hasPermission("continuity.export")) {
    return <Card className="p-4"><p className="text-sm">Only an Administrator or a manager can download the continuity pack.</p></Card>;
  }
  const s = continuityState(status.data);

  async function download() {
    setBusy(true); setError(null); setDone(null);
    try {
      const r = await api.post<{ pack: ContinuityPack }>("/v1/continuity/pack", { organizationId: activeOrganizationId }, { idempotencyKey: key.current });
      const blob = new Blob([buildContinuityHtml(r.pack)], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = continuityFileName(r.pack); a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      key.current = newIdempotencyKey();
      setDone(`Downloaded: data as of ${formatDateTime(r.pack.data_as_of)}; outage numbers ${outageNumber(r.pack.outage_numbers.first)} to ${outageNumber(r.pack.outage_numbers.last)}.`);
      await qc.invalidateQueries({ queryKey: ["aws-continuity-status"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The download did not complete. Try again; the same outage numbers are kept.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Continuity pack</h1>
      <Card className={`p-4 ${s.stale ? "border-2 border-amber-500 bg-amber-50" : ""}`}>
        <p className={`text-base ${s.stale ? "font-bold text-amber-900" : ""}`}>{status.isError ? "Status could not be loaded." : `${s.text}.`}</p>
        <p className="mt-2 text-sm text-slate-700">
          A single file with the next 14 days of shifts, this month's authorized and remaining hours, active clients, the Care Team,
          and numbered outage visit records. It opens in any browser without Ogevia. It shows the exact time its data was taken.
        </p>
        <Button className="mt-3 min-h-11 w-full sm:w-auto" disabled={busy} onClick={() => void download()}>
          {busy ? "Preparing…" : "Download continuity pack"}
        </Button>
        {done ? <p role="status" className="mt-2 text-sm text-emerald-800">{done}</p> : null}
        {error ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : null}
      </Card>
      <Card className="p-4 text-sm text-slate-700">
        <p className="font-semibold text-slate-900">Your agency must</p>
        <ul className="mt-1 list-disc pl-5">
          <li>keep the file only on agency-approved encrypted storage, and only for authorised staff;</li>
          <li>download a new pack at least daily and delete the old one;</li>
          <li>during an outage, record each visit on an outage visit record with the next unused number;</li>
          <li>after Ogevia returns, enter each record once on <Link to="/outage-visits" className="underline">Outage records</Link>; Ogevia refuses a duplicate number.</li>
        </ul>
      </Card>
    </div>
  );
}
