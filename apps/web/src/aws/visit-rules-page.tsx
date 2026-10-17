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
    <div className="max-w-xl space-y-4">
      <div>
        <Link to="/settings/branding" className="text-sm text-slate-600 underline">Settings</Link>
        <h1 className="mt-1 text-xl font-semibold text-slate-950">Visit rules</h1>
        <p className="mt-1 text-sm text-slate-600">
          When a caregiver works more or less than the scheduled shift by more than this many minutes, the visit goes to review before it can be billed.
          Visits with no scheduled shift always go to review.
        </p>
      </div>

      {rules.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {rules.isError ? <p role="alert" className="text-sm text-red-700">{message(rules.error, "The rule could not be loaded.")}</p> : null}
      {rules.data && rules.data.length === 0 ? <p className="text-sm text-slate-600">You do not have access to these rules.</p> : null}

      {current ? (
        <Card className="space-y-1 p-4">
          <p className="text-sm text-slate-600">In effect now</p>
          <p className="text-2xl font-semibold text-slate-950">{current.minutes} minutes</p>
          {current.source === "system_default" ? (
            <p className="text-sm text-amber-900">
              This is the product’s starting value. It has <strong>not been verified</strong> against your payer’s or regional center’s rules. Set your agency’s own value below.
            </p>
          ) : (
            <p className="text-sm text-slate-700">Version {current.version}, set by your agency. Confirm that it matches your payer’s rules; Ogevia does not verify it.</p>
          )}
        </Card>
      ) : null}

      {canChange ? (
        <Card className="p-4">
          <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="space-y-3">
            <h2 className="text-base font-semibold text-slate-950">Change the rule</h2>
            <label className="block text-sm font-medium text-slate-700">
              Allowed difference (minutes)
              <input inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/[^0-9]/g, ""))} maxLength={3} className="mt-1 block w-32 rounded-lg border border-slate-200 px-3 py-2 text-base" />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Starts on (optional; today if empty)
              <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className="mt-1 block rounded-lg border border-slate-200 px-3 py-2 text-base" />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Reason (required, kept with the rule)
              <textarea value={reason} maxLength={500} rows={2} onChange={(e) => setReason(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-200 px-3 py-2 text-base" />
            </label>
            <p className="text-xs text-slate-600">A change never applies to a past date and never changes a visit that was already checked.</p>
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
          <h2 id="rule-history" className="mb-2 text-base font-semibold text-slate-950">History</h2>
          <ul className="space-y-2">
            {rules.data.map((r) => (
              <li key={r.version} className="rounded-xl border border-slate-200 bg-og-card p-3 text-sm">
                <p className="font-semibold text-slate-950">
                  Version {r.version}: {r.minutes} minutes{r.inEffect ? " (in effect)" : ""}
                </p>
                <p className="text-slate-700">
                  {r.source === "system_default"
                    ? "Product starting value, not verified"
                    : `From ${formatDateOnly(r.effectiveFrom)} · ${r.changedByName ?? "—"} · ${r.changedAt ? formatDateTime(r.changedAt) : ""}`}
                </p>
                {r.reason ? <p className="text-slate-700">“{r.reason}”</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
