// The agency's schedule-variance rule (Wave 1, 0050). A visit whose length differs from its scheduled shift by more than
// this many minutes goes to review. The rule is versioned and effective-dated: a change is a NEW version (who, when, why),
// never applies to a visit already evaluated, and the starting value is NOT a verified payer rule.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { formatDateOnly, formatDateTime } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { AuditList } from "./ui/audit-list";
import { CompactAlert } from "./ui/compact-alert";
import { HelpLine } from "./ui/help-line";
import { InfoTip } from "./ui/info-tip";

interface Rule {
  version: number;
  minutes: number;
  source: "system_default" | "agency_setting";
  effectiveFrom: string | null;
  changedByName: string | null;
  changedAt: string | null;
  reason: string | null;
  inEffect: boolean;
}

const MIN = 1;
const MAX = 240;
const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

export function VisitRulesPage() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const canChange = hasPermission("organization.update");
  const [minutes, setMinutes] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [reason, setReason] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: string | null }>({ busy: false, error: null, done: null });
  const key = useRef(newIdempotencyKey());
  const rules = useQuery({
    queryKey: ["aws-visit-rules", activeOrganizationId],
    queryFn: async () => (await api.get<{ rules: Rule[] }>("/v1/visit-rules", { organizationId: activeOrganizationId })).rules,
    enabled: !!activeOrganizationId,
  });

  async function save() {
    const value = Number(minutes);
    if (!Number.isInteger(value) || value < MIN || value > MAX) return setState({ busy: false, error: `Enter a whole number of minutes from ${MIN} to ${MAX}. There is no “off” setting.`, done: null });
    if (reason.trim().length < 3) return setState({ busy: false, error: "Give the reason for this change. It is kept with the rule.", done: null });
    setState({ busy: true, error: null, done: null });
    try {
      await api.post("/v1/visit-rules", { organizationId: activeOrganizationId, minutes: value, ...(effectiveFrom ? { effectiveFrom } : {}), reason: reason.trim() }, { idempotencyKey: key.current });
      key.current = newIdempotencyKey();
      setMinutes("");
      setEffectiveFrom("");
      setReason("");
      await queryClient.invalidateQueries({ queryKey: ["aws-visit-rules"] });
      setState({ busy: false, error: null, done: "Saved as a new version. Visits already reviewed keep the rule they were checked against." });
    } catch (cause) {
      setState({ busy: false, error: message(cause, "The rule was not saved."), done: null });
    }
  }

  const current = rules.data?.find((r) => r.inEffect);
  return (
    <div className="max-w-xl space-y-3">
      <div className="flex flex-wrap items-center gap-x-2">
        <Link to="/settings/branding" className="text-sm text-slate-600 underline">Settings</Link>
        <h1 className="text-xl font-semibold text-slate-950">Visit rules</h1>
        <InfoTip label="About visit rules">
          When a caregiver works more or less than the scheduled shift by more than this many minutes, the visit goes to review before it can be billed. Visits with no scheduled shift always go to review.
        </InfoTip>
      </div>

      {rules.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {rules.isError ? <p role="alert" className="text-sm text-red-700">{message(rules.error, "The rule could not be loaded.")}</p> : null}
      {rules.data && rules.data.length === 0 ? <p className="text-sm text-slate-600">You do not have access to these rules.</p> : null}

      {current ? (
        <Card className="space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <span className="text-sm text-slate-600">In effect now</span>
            <span className="text-lg font-semibold text-slate-950">{current.minutes} minutes</span>
          </div>
          {current.source === "system_default" ? (
            <CompactAlert summary="Starting value, not verified">
              This is the product’s starting value. It has <strong>not been verified</strong> against your payer’s or regional center’s rules. Set your agency’s own value below.
            </CompactAlert>
          ) : (
            <p className="text-xs text-slate-700">Version {current.version}, set by your agency. Confirm that it matches your payer’s rules; Ogevia does not verify it.</p>
          )}
        </Card>
      ) : null}

      {canChange ? (
        <Card>
          <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="space-y-2">
            <h2 className="text-base font-semibold text-slate-950">Change the rule</h2>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
            <label className="block text-sm font-medium text-slate-700">
              Allowed difference (minutes)
              <input inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/[^0-9]/g, ""))} maxLength={3} className="mt-0.5 block w-28 rounded-md border border-slate-200 px-2 py-1.5 text-sm" />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Starts on (optional; today if empty)
              <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className="mt-0.5 block rounded-md border border-slate-200 px-2 py-1.5 text-sm" />
            </label>
            </div>
            <label className="block text-sm font-medium text-slate-700">
              Reason (required, kept with the rule)
              <textarea value={reason} maxLength={500} rows={2} onChange={(e) => setReason(e.target.value)} className="mt-0.5 block w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm" />
            </label>
            <HelpLine details="A change never applies to a past date and never changes a visit that was already checked.">Applies from the start date.</HelpLine>
            {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : null}
            {state.done ? <p role="status" className="text-sm text-emerald-800">{state.done}</p> : null}
            <Button type="submit" disabled={state.busy}>{state.busy ? "Saving…" : "Save as a new version"}</Button>
          </form>
        </Card>
      ) : rules.data && rules.data.length > 0 ? (
        <p className="text-sm text-slate-600">Only the agency Administrator can change this rule.</p>
      ) : null}

      {rules.data && rules.data.length > 0 ? (
        <section aria-labelledby="rule-history">
          <h2 id="rule-history" className="mb-1 text-base font-semibold text-slate-950">History</h2>
          <AuditList label="Rule versions" maxHeightClass="max-h-48" rows={rules.data.map((r) => ({
            id: String(r.version),
            when: r.source === "system_default" ? "Starting value" : formatDateOnly(r.effectiveFrom),
            who: r.source === "system_default" ? null : (r.changedByName ?? "—"),
            summary: `Version ${r.version}: ${r.minutes} minutes${r.inEffect ? " (in effect)" : ""}`,
            detail: <>{r.source === "system_default" ? "Product starting value, not verified" : `Changed ${r.changedAt ? formatDateTime(r.changedAt) : ""}`}{r.reason ? ` · “${r.reason}”` : ""}</>,
          }))} />
        </section>
      ) : null}
    </div>
  );
}
