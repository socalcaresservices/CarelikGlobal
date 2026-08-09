import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, FormSection, StatusBadge } from "@carelik/ui";
import { FEATURE_LABELS, formatCents } from "@carelik/shared";
import { supabase } from "@/lib/supabase";
import { isStripeConfigured } from "@/env";

// Raw row shape from list_all_plan_versions() (setof plan_definitions,
// snake_case straight off the table).
interface PlanVersionRow {
  id: string;
  plan_key: string;
  version: number;
  name: string;
  description: string | null;
  monthly_price_cents: number;
  annual_price_cents: number;
  max_active_clients: number | null;
  max_active_caregivers: number | null;
  max_administrators: number | null;
  max_completed_visits: number | null;
  report_retention_days: number | null;
  bulk_export_limit: number | null;
  support_level: "standard" | "priority" | "dedicated";
  sms_allowance: number;
  features: string[];
  is_trial: boolean;
  trial_duration_days: number | null;
  is_public: boolean;
  is_active: boolean;
  is_current: boolean;
  is_introductory: boolean;
  effective_at: string;
}

const ALL_FEATURE_KEYS = Object.keys(FEATURE_LABELS);

type FormState = {
  planKey: string;
  name: string;
  description: string;
  monthlyPrice: string;
  annualPrice: string;
  maxActiveClients: string;
  maxActiveCaregivers: string;
  maxAdministrators: string;
  maxCompletedVisits: string;
  reportRetentionDays: string;
  bulkExportLimit: string;
  supportLevel: "standard" | "priority" | "dedicated";
  smsAllowance: string;
  features: string[];
  isTrial: boolean;
  trialDurationDays: string;
  isPublic: boolean;
  isIntroductory: boolean;
  reason: string;
};

function emptyForm(planKey = ""): FormState {
  return {
    planKey,
    name: "",
    description: "",
    monthlyPrice: "",
    annualPrice: "",
    maxActiveClients: "",
    maxActiveCaregivers: "",
    maxAdministrators: "",
    maxCompletedVisits: "",
    reportRetentionDays: "",
    bulkExportLimit: "",
    supportLevel: "standard",
    smsAllowance: "0",
    features: [...ALL_FEATURE_KEYS.filter((key) => !key.includes("support") && key !== "bulk_export" && key !== "sms_notifications")],
    isTrial: false,
    trialDurationDays: "",
    isPublic: true,
    isIntroductory: false,
    reason: ""
  };
}

function toForm(row: PlanVersionRow): FormState {
  return {
    planKey: row.plan_key,
    name: row.name,
    description: row.description ?? "",
    monthlyPrice: (row.monthly_price_cents / 100).toString(),
    annualPrice: (row.annual_price_cents / 100).toString(),
    maxActiveClients: row.max_active_clients?.toString() ?? "",
    maxActiveCaregivers: row.max_active_caregivers?.toString() ?? "",
    maxAdministrators: row.max_administrators?.toString() ?? "",
    maxCompletedVisits: row.max_completed_visits?.toString() ?? "",
    reportRetentionDays: row.report_retention_days?.toString() ?? "",
    bulkExportLimit: row.bulk_export_limit?.toString() ?? "",
    supportLevel: row.support_level,
    smsAllowance: row.sms_allowance.toString(),
    features: row.features ?? [],
    isTrial: row.is_trial,
    trialDurationDays: row.trial_duration_days?.toString() ?? "",
    isPublic: row.is_public,
    isIntroductory: row.is_introductory,
    reason: ""
  };
}

function toIntOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

export function PlatformPlanManager() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [retireReason, setRetireReason] = useState<Record<string, string>>({});
  const [retiringKey, setRetiringKey] = useState<string | null>(null);
  const [retireError, setRetireError] = useState<string | null>(null);

  const plansQuery = useQuery({
    queryKey: ["platform-plan-versions"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_all_plan_versions");
      if (error) throw error;
      return (data ?? []) as PlanVersionRow[];
    }
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["platform-plan-versions"] });
  }

  const rows = plansQuery.data ?? [];
  const currentByKey = rows.filter((row) => row.is_current);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    setFormError(null);

    const planKey = editing.planKey.trim();
    if (!planKey) {
      setFormError("A plan key is required (e.g. start, grow, pro, scale).");
      return;
    }
    if (!editing.reason.trim()) {
      setFormError("A reason is required to save plan changes.");
      return;
    }
    const monthlyCents = Math.round(Number(editing.monthlyPrice || "0") * 100);
    const annualCents = Math.round(Number(editing.annualPrice || "0") * 100);
    if (!Number.isFinite(monthlyCents) || !Number.isFinite(annualCents) || monthlyCents < 0 || annualCents < 0) {
      setFormError("Prices must be non-negative numbers.");
      return;
    }

    setSaving(true);
    try {
      const { error } = await supabase.rpc("upsert_plan_definition", {
        target_plan_key: planKey,
        new_name: editing.name.trim(),
        new_description: editing.description.trim() || null,
        new_monthly_price_cents: monthlyCents,
        new_annual_price_cents: annualCents,
        new_max_active_clients: toIntOrNull(editing.maxActiveClients),
        new_max_active_caregivers: toIntOrNull(editing.maxActiveCaregivers),
        new_max_administrators: toIntOrNull(editing.maxAdministrators),
        new_max_completed_visits: toIntOrNull(editing.maxCompletedVisits),
        new_report_retention_days: toIntOrNull(editing.reportRetentionDays),
        new_bulk_export_limit: toIntOrNull(editing.bulkExportLimit),
        new_support_level: editing.supportLevel,
        new_sms_allowance: toIntOrNull(editing.smsAllowance) ?? 0,
        new_features: editing.features,
        new_is_trial: editing.isTrial,
        new_trial_duration_days: toIntOrNull(editing.trialDurationDays),
        new_is_public: editing.isPublic,
        new_is_introductory: editing.isIntroductory,
        change_reason: editing.reason.trim()
      });
      if (error) throw error;
      setEditing(null);
      refresh();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not save this plan.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRetire(planKey: string) {
    const reason = (retireReason[planKey] ?? "").trim();
    if (!reason) {
      setRetireError("A reason is required to retire a plan.");
      return;
    }
    setRetireError(null);
    setRetiringKey(planKey);
    try {
      const { error } = await supabase.rpc("retire_plan_definition", { target_plan_key: planKey, change_reason: reason });
      if (error) throw error;
      setRetireReason((prev) => ({ ...prev, [planKey]: "" }));
      refresh();
    } catch (cause) {
      setRetireError(cause instanceof Error ? cause.message : "Could not retire this plan.");
    } finally {
      setRetiringKey(null);
    }
  }

  function toggleFeature(feature: string) {
    if (!editing) return;
    setEditing({
      ...editing,
      features: editing.features.includes(feature)
        ? editing.features.filter((entry) => entry !== feature)
        : [...editing.features, feature]
    });
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-950">Plans</h3>
          <p className="mt-1 text-xs text-slate-500">
            Editing a plan creates a new version - existing subscribers stay on the version they were on until
            deliberately migrated.
          </p>
        </div>
        <Button type="button" size="sm" onClick={() => setEditing(emptyForm())}>
          New plan
        </Button>
      </div>

      {!isStripeConfigured ? (
        <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
          <span className="font-medium">Stripe configuration required.</span> Plans, limits, trials, and overrides
          below are fully functional, but no subscriber can pay through Stripe Checkout yet - set{" "}
          <code className="rounded bg-amber-100 px-1 py-0.5 text-xs">VITE_STRIPE_PUBLISHABLE_KEY</code>,{" "}
          <code className="rounded bg-amber-100 px-1 py-0.5 text-xs">STRIPE_SECRET_KEY</code>, and{" "}
          <code className="rounded bg-amber-100 px-1 py-0.5 text-xs">STRIPE_WEBHOOK_SECRET</code> (see .env.example)
          to enable it.
        </div>
      ) : null}

      {plansQuery.isLoading ? (
        <p className="mt-3 text-sm text-slate-500">Loading plans…</p>
      ) : plansQuery.isError ? (
        <p className="mt-3 text-sm text-red-700">Could not load plans.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <th className="pb-2 font-medium">Plan</th>
                <th className="pb-2 font-medium">Version</th>
                <th className="pb-2 font-medium">Price</th>
                <th className="pb-2 font-medium">Clients / Staff / Admins</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {currentByKey.map((row) => (
                <tr key={row.id} className="border-b border-slate-100 last:border-0 align-top">
                  <td className="py-2.5 pr-3">
                    <p className="font-medium text-slate-900">{row.name}</p>
                    <p className="text-xs text-slate-500">{row.plan_key}</p>
                  </td>
                  <td className="py-2.5 pr-3 text-slate-600">v{row.version}</td>
                  <td className="py-2.5 pr-3 text-slate-600">
                    {formatCents(row.monthly_price_cents)}/mo · {formatCents(row.annual_price_cents)}/yr
                  </td>
                  <td className="py-2.5 pr-3 text-slate-600">
                    {row.max_active_clients ?? "∞"} / {row.max_active_caregivers ?? "∞"} / {row.max_administrators ?? "∞"}
                  </td>
                  <td className="py-2.5 pr-3">
                    <div className="flex flex-wrap gap-1">
                      <StatusBadge label={row.is_active ? "Active" : "Retired"} tone={row.is_active ? "success" : "neutral"} />
                      <StatusBadge label={row.is_public ? "Public" : "Hidden"} tone={row.is_public ? "info" : "neutral"} />
                      {row.is_introductory ? <StatusBadge label="Intro price" tone="warning" /> : null}
                    </div>
                  </td>
                  <td className="py-2.5 text-right">
                    <div className="flex flex-col items-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => setEditing(toForm(row))}
                        className="text-xs font-medium text-slate-700 underline-offset-2 hover:underline"
                      >
                        Edit (new version)
                      </button>
                      {row.is_active ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            aria-label={`Retire reason for ${row.name}`}
                            placeholder="Retire reason"
                            value={retireReason[row.plan_key] ?? ""}
                            onChange={(event) =>
                              setRetireReason((prev) => ({ ...prev, [row.plan_key]: event.target.value }))
                            }
                            className="w-32 rounded-lg border border-slate-200 px-2 py-1 text-xs"
                          />
                          <button
                            type="button"
                            disabled={retiringKey === row.plan_key}
                            onClick={() => handleRetire(row.plan_key)}
                            className="text-xs font-medium text-red-700 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Retire
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {retireError ? <p className="mt-2 text-sm text-red-700">{retireError}</p> : null}

      {editing ? (
        <form onSubmit={handleSave} className="mt-6 space-y-5 border-t border-slate-200 pt-5">
          <FormSection title="Identity" columns={2}>
            <div>
              <label htmlFor="plan-key" className="block text-xs font-medium text-slate-600">
                Plan key
              </label>
              <input
                id="plan-key"
                required
                value={editing.planKey}
                onChange={(event) => setEditing({ ...editing, planKey: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="plan-name" className="block text-xs font-medium text-slate-600">
                Name
              </label>
              <input
                id="plan-name"
                required
                value={editing.name}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="plan-description" className="block text-xs font-medium text-slate-600">
                Description
              </label>
              <input
                id="plan-description"
                value={editing.description}
                onChange={(event) => setEditing({ ...editing, description: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
          </FormSection>

          <FormSection title="Pricing" columns={2}>
            <div>
              <label htmlFor="plan-monthly" className="block text-xs font-medium text-slate-600">
                Monthly price ($)
              </label>
              <input
                id="plan-monthly"
                type="number"
                min={0}
                step={0.01}
                required
                value={editing.monthlyPrice}
                onChange={(event) => setEditing({ ...editing, monthlyPrice: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="plan-annual" className="block text-xs font-medium text-slate-600">
                Annual price ($)
              </label>
              <input
                id="plan-annual"
                type="number"
                min={0}
                step={0.01}
                required
                value={editing.annualPrice}
                onChange={(event) => setEditing({ ...editing, annualPrice: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
          </FormSection>

          <FormSection title="Limits (blank = unlimited)" columns={2}>
            <div>
              <label htmlFor="plan-clients" className="block text-xs font-medium text-slate-600">
                Active client limit
              </label>
              <input
                id="plan-clients"
                type="number"
                min={0}
                value={editing.maxActiveClients}
                onChange={(event) => setEditing({ ...editing, maxActiveClients: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="plan-caregivers" className="block text-xs font-medium text-slate-600">
                Caregiver/staff limit
              </label>
              <input
                id="plan-caregivers"
                type="number"
                min={0}
                value={editing.maxActiveCaregivers}
                onChange={(event) => setEditing({ ...editing, maxActiveCaregivers: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="plan-admins" className="block text-xs font-medium text-slate-600">
                Administrator limit
              </label>
              <input
                id="plan-admins"
                type="number"
                min={0}
                value={editing.maxAdministrators}
                onChange={(event) => setEditing({ ...editing, maxAdministrators: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="plan-visits" className="block text-xs font-medium text-slate-600">
                Completed-visit limit
              </label>
              <input
                id="plan-visits"
                type="number"
                min={0}
                value={editing.maxCompletedVisits}
                onChange={(event) => setEditing({ ...editing, maxCompletedVisits: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="plan-retention" className="block text-xs font-medium text-slate-600">
                Report retention (days)
              </label>
              <input
                id="plan-retention"
                type="number"
                min={0}
                value={editing.reportRetentionDays}
                onChange={(event) => setEditing({ ...editing, reportRetentionDays: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="plan-export" className="block text-xs font-medium text-slate-600">
                Bulk-export row limit
              </label>
              <input
                id="plan-export"
                type="number"
                min={0}
                value={editing.bulkExportLimit}
                onChange={(event) => setEditing({ ...editing, bulkExportLimit: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
          </FormSection>

          <FormSection title="Support and SMS" columns={2}>
            <div>
              <label htmlFor="plan-support" className="block text-xs font-medium text-slate-600">
                Support level
              </label>
              <select
                id="plan-support"
                value={editing.supportLevel}
                onChange={(event) =>
                  setEditing({ ...editing, supportLevel: event.target.value as FormState["supportLevel"] })
                }
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              >
                <option value="standard">Standard</option>
                <option value="priority">Priority</option>
                <option value="dedicated">Dedicated</option>
              </select>
            </div>
            <div>
              <label htmlFor="plan-sms" className="block text-xs font-medium text-slate-600">
                SMS allowance (add-on entitlement)
              </label>
              <input
                id="plan-sms"
                type="number"
                min={0}
                value={editing.smsAllowance}
                onChange={(event) => setEditing({ ...editing, smsAllowance: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
          </FormSection>

          <FormSection title="Features" columns={1}>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {ALL_FEATURE_KEYS.map((feature) => (
                <label key={feature} className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={editing.features.includes(feature)}
                    onChange={() => toggleFeature(feature)}
                    className="h-4 w-4"
                  />
                  {FEATURE_LABELS[feature]}
                </label>
              ))}
            </div>
          </FormSection>

          <FormSection title="Trial and visibility" columns={2}>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={editing.isTrial}
                onChange={(event) => setEditing({ ...editing, isTrial: event.target.checked })}
                className="h-4 w-4"
              />
              This is the trial plan
            </label>
            {editing.isTrial ? (
              <div>
                <label htmlFor="plan-trial-days" className="block text-xs font-medium text-slate-600">
                  Trial duration (days)
                </label>
                <input
                  id="plan-trial-days"
                  type="number"
                  min={1}
                  value={editing.trialDurationDays}
                  onChange={(event) => setEditing({ ...editing, trialDurationDays: event.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>
            ) : null}
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={editing.isPublic}
                onChange={(event) => setEditing({ ...editing, isPublic: event.target.checked })}
                className="h-4 w-4"
              />
              Public (shown as an available plan)
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={editing.isIntroductory}
                onChange={(event) => setEditing({ ...editing, isIntroductory: event.target.checked })}
                className="h-4 w-4"
              />
              Introductory price
            </label>
          </FormSection>

          <FormSection title="Reason" description="Required - recorded in the audit log with this change." columns={1}>
            <div>
              <label htmlFor="plan-reason" className="block text-xs font-medium text-slate-600">
                Reason
              </label>
              <input
                id="plan-reason"
                placeholder="e.g. Q3 price adjustment"
                value={editing.reason}
                onChange={(event) => setEditing({ ...editing, reason: event.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
          </FormSection>

          <div className="flex items-center gap-3">
            <Button type="submit" loading={saving}>
              {saving ? "Saving…" : "Save as new version"}
            </Button>
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setFormError(null);
              }}
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              Cancel
            </button>
          </div>
          {formError ? <p className="text-sm text-red-700">{formError}</p> : null}
        </form>
      ) : null}
    </Card>
  );
}
