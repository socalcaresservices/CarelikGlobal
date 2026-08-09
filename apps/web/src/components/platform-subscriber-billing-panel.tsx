import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, StatusBadge } from "@carelik/ui";
import { formatCents, getTrialDaysRemaining, SUBSCRIPTION_STATUS_LABELS, type SubscriptionEffectiveStatus } from "@carelik/shared";
import { supabase } from "@/lib/supabase";

interface BillingSummaryRow {
  effective_status: SubscriptionEffectiveStatus;
  plan_id: string | null;
  plan_key: string | null;
  plan_name: string | null;
  plan_version: number | null;
  monthly_price_cents: number | null;
  custom_monthly_price_cents: number | null;
  custom_annual_price_cents: number | null;
  is_complimentary: boolean;
  billing_cycle: "monthly" | "annual" | null;
  billing_cycle_anchor: string | null;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  override_max_active_clients: number | null;
  override_max_active_caregivers: number | null;
  override_max_administrators: number | null;
  override_reason: string | null;
  override_expires_at: string | null;
  active_clients: number;
  active_caregivers: number;
  administrators: number;
}

interface PlanOption {
  id: string;
  plan_key: string;
  name: string;
  version: number;
}

export function PlatformSubscriberBillingPanel({ organizationId }: { organizationId: string }) {
  const queryClient = useQueryClient();

  const summaryQuery = useQuery({
    queryKey: ["platform-org-billing-summary", organizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .rpc("get_organization_billing_summary", { target_organization_id: organizationId })
        .maybeSingle();
      if (error) throw error;
      return data as BillingSummaryRow | null;
    }
  });

  const plansQuery = useQuery({
    queryKey: ["platform-plan-versions-current"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_all_plan_versions");
      if (error) throw error;
      return ((data ?? []) as Array<PlanOption & { is_current: boolean }>).filter((row) => row.is_current);
    }
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["platform-org-billing-summary", organizationId] });
  }

  const [migratePlanId, setMigratePlanId] = useState("");
  const [migrateReason, setMigrateReason] = useState("");
  const [migrating, setMigrating] = useState(false);
  const [migrateError, setMigrateError] = useState<string | null>(null);

  async function handleMigrate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!migratePlanId || !migrateReason.trim()) {
      setMigrateError("Pick a plan and enter a reason.");
      return;
    }
    setMigrateError(null);
    setMigrating(true);
    try {
      const { error } = await supabase.rpc("migrate_organization_plan", {
        target_organization_id: organizationId,
        new_plan_definition_id: migratePlanId,
        change_reason: migrateReason.trim()
      });
      if (error) throw error;
      setMigrateReason("");
      refresh();
    } catch (cause) {
      setMigrateError(cause instanceof Error ? cause.message : "Could not migrate this organization's plan.");
    } finally {
      setMigrating(false);
    }
  }

  const [overrideForm, setOverrideForm] = useState({
    customMonthly: "",
    customAnnual: "",
    overrideClients: "",
    overrideCaregivers: "",
    overrideAdmins: "",
    complimentary: false,
    overrideReason: "",
    overrideExpires: "",
    reason: ""
  });
  const [overrideSaving, setOverrideSaving] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);

  useEffect(() => {
    if (!summaryQuery.data) return;
    const s = summaryQuery.data;
    setOverrideForm((prev) => ({
      ...prev,
      customMonthly: s.custom_monthly_price_cents !== null ? (s.custom_monthly_price_cents / 100).toString() : "",
      customAnnual: s.custom_annual_price_cents !== null ? (s.custom_annual_price_cents / 100).toString() : "",
      overrideClients: s.override_max_active_clients?.toString() ?? "",
      overrideCaregivers: s.override_max_active_caregivers?.toString() ?? "",
      overrideAdmins: s.override_max_administrators?.toString() ?? "",
      complimentary: s.is_complimentary,
      overrideReason: s.override_reason ?? "",
      overrideExpires: s.override_expires_at ? s.override_expires_at.slice(0, 10) : ""
    }));
  }, [summaryQuery.data]);

  function toCentsOrNull(value: string): number | null {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
  }
  function toIntOrNull(value: string): number | null {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  }

  async function handleSaveOverride(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!overrideForm.reason.trim()) {
      setOverrideError("A reason is required to change a subscriber override.");
      return;
    }
    setOverrideError(null);
    setOverrideSaving(true);
    try {
      const { error } = await supabase.rpc("set_organization_billing_override", {
        target_organization_id: organizationId,
        new_custom_monthly_price_cents: toCentsOrNull(overrideForm.customMonthly),
        new_custom_annual_price_cents: toCentsOrNull(overrideForm.customAnnual),
        new_override_max_active_clients: toIntOrNull(overrideForm.overrideClients),
        new_override_max_active_caregivers: toIntOrNull(overrideForm.overrideCaregivers),
        new_override_max_administrators: toIntOrNull(overrideForm.overrideAdmins),
        new_is_complimentary: overrideForm.complimentary,
        new_override_reason: overrideForm.overrideReason.trim() || null,
        new_override_expires_at: overrideForm.overrideExpires ? new Date(overrideForm.overrideExpires).toISOString() : null,
        change_reason: overrideForm.reason.trim()
      });
      if (error) throw error;
      setOverrideForm((prev) => ({ ...prev, reason: "" }));
      refresh();
    } catch (cause) {
      setOverrideError(cause instanceof Error ? cause.message : "Could not save this override.");
    } finally {
      setOverrideSaving(false);
    }
  }

  const [trialDays, setTrialDays] = useState("42");
  const [trialReason, setTrialReason] = useState("");
  const [trialSaving, setTrialSaving] = useState(false);
  const [trialError, setTrialError] = useState<string | null>(null);

  async function handleSetTrial(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trialReason.trim()) {
      setTrialError("A reason is required to start or restart a trial.");
      return;
    }
    setTrialError(null);
    setTrialSaving(true);
    try {
      const alreadyUsedTrial = !!summaryQuery.data?.trial_started_at;
      const { error } = await supabase.rpc("set_organization_trial", {
        target_organization_id: organizationId,
        trial_duration_days: toIntOrNull(trialDays) ?? 42,
        allow_restart: alreadyUsedTrial,
        change_reason: trialReason.trim()
      });
      if (error) throw error;
      setTrialReason("");
      refresh();
    } catch (cause) {
      setTrialError(cause instanceof Error ? cause.message : "Could not start the trial.");
    } finally {
      setTrialSaving(false);
    }
  }

  const [cycle, setCycle] = useState<"monthly" | "annual">("monthly");
  const [cycleAnchor, setCycleAnchor] = useState("");
  const [cycleReason, setCycleReason] = useState("");
  const [cycleSaving, setCycleSaving] = useState(false);
  const [cycleError, setCycleError] = useState<string | null>(null);

  useEffect(() => {
    if (summaryQuery.data?.billing_cycle) setCycle(summaryQuery.data.billing_cycle);
    if (summaryQuery.data?.billing_cycle_anchor) setCycleAnchor(summaryQuery.data.billing_cycle_anchor);
  }, [summaryQuery.data]);

  async function handleSetCycle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cycleReason.trim()) {
      setCycleError("A reason is required to change the billing cycle.");
      return;
    }
    setCycleError(null);
    setCycleSaving(true);
    try {
      const { error } = await supabase.rpc("set_organization_billing_cycle", {
        target_organization_id: organizationId,
        new_billing_cycle: cycle,
        new_billing_cycle_anchor: cycleAnchor || null,
        change_reason: cycleReason.trim()
      });
      if (error) throw error;
      setCycleReason("");
      refresh();
    } catch (cause) {
      setCycleError(cause instanceof Error ? cause.message : "Could not change the billing cycle.");
    } finally {
      setCycleSaving(false);
    }
  }

  if (summaryQuery.isLoading) {
    return <p className="text-sm text-slate-500">Loading billing…</p>;
  }
  if (summaryQuery.isError || !summaryQuery.data) {
    return <p className="text-sm text-red-700">Could not load billing for this organization.</p>;
  }

  const summary = summaryQuery.data;
  const trialDaysRemaining = getTrialDaysRemaining(summary.trial_ends_at);

  return (
    <div className="space-y-4 rounded-lg bg-slate-50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-slate-900">
            {summary.plan_name ?? "No plan"} {summary.plan_version ? `(v${summary.plan_version})` : ""}
          </p>
          <p className="text-xs text-slate-500">
            {formatCents(summary.custom_monthly_price_cents ?? summary.monthly_price_cents)}/mo ·{" "}
            {summary.active_clients} clients · {summary.active_caregivers} staff · {summary.administrators} admins
            {trialDaysRemaining !== null ? ` · ${trialDaysRemaining}d left in trial` : ""}
          </p>
        </div>
        <StatusBadge label={SUBSCRIPTION_STATUS_LABELS[summary.effective_status]} tone="info" />
      </div>

      <form onSubmit={handleMigrate} className="flex flex-wrap items-end gap-2 border-t border-slate-200 pt-3">
        <div className="min-w-[10rem]">
          <label htmlFor={`migrate-plan-${organizationId}`} className="block text-xs font-medium text-slate-600">
            Migrate to plan
          </label>
          <select
            id={`migrate-plan-${organizationId}`}
            value={migratePlanId}
            onChange={(event) => setMigratePlanId(event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
          >
            <option value="">Select a plan…</option>
            {(plansQuery.data ?? []).map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name} (v{plan.version})
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-[10rem] flex-1">
          <label htmlFor={`migrate-reason-${organizationId}`} className="block text-xs font-medium text-slate-600">
            Reason
          </label>
          <input
            id={`migrate-reason-${organizationId}`}
            value={migrateReason}
            onChange={(event) => setMigrateReason(event.target.value)}
            placeholder="Required"
            className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
          />
        </div>
        <Button type="submit" size="sm" loading={migrating}>
          Migrate
        </Button>
      </form>
      {migrateError ? <p className="text-sm text-red-700">{migrateError}</p> : null}

      <form onSubmit={handleSetTrial} className="flex flex-wrap items-end gap-2 border-t border-slate-200 pt-3">
        <div className="w-28">
          <label htmlFor={`trial-days-${organizationId}`} className="block text-xs font-medium text-slate-600">
            Trial days
          </label>
          <input
            id={`trial-days-${organizationId}`}
            type="number"
            min={1}
            value={trialDays}
            onChange={(event) => setTrialDays(event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
          />
        </div>
        <div className="min-w-[10rem] flex-1">
          <label htmlFor={`trial-reason-${organizationId}`} className="block text-xs font-medium text-slate-600">
            Reason
          </label>
          <input
            id={`trial-reason-${organizationId}`}
            value={trialReason}
            onChange={(event) => setTrialReason(event.target.value)}
            placeholder="Required"
            className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
          />
        </div>
        <Button type="submit" size="sm" loading={trialSaving} variant="secondary">
          {summary.trial_started_at ? "Restart trial" : "Start trial"}
        </Button>
      </form>
      {trialError ? <p className="text-sm text-red-700">{trialError}</p> : null}

      <form onSubmit={handleSetCycle} className="flex flex-wrap items-end gap-2 border-t border-slate-200 pt-3">
        <div className="w-32">
          <label htmlFor={`cycle-${organizationId}`} className="block text-xs font-medium text-slate-600">
            Billing cycle
          </label>
          <select
            id={`cycle-${organizationId}`}
            value={cycle}
            onChange={(event) => setCycle(event.target.value as "monthly" | "annual")}
            className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
          >
            <option value="monthly">Monthly</option>
            <option value="annual">Annual</option>
          </select>
        </div>
        <div className="w-36">
          <label htmlFor={`cycle-anchor-${organizationId}`} className="block text-xs font-medium text-slate-600">
            Anchor date
          </label>
          <input
            id={`cycle-anchor-${organizationId}`}
            type="date"
            value={cycleAnchor}
            onChange={(event) => setCycleAnchor(event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
          />
        </div>
        <div className="min-w-[10rem] flex-1">
          <label htmlFor={`cycle-reason-${organizationId}`} className="block text-xs font-medium text-slate-600">
            Reason
          </label>
          <input
            id={`cycle-reason-${organizationId}`}
            value={cycleReason}
            onChange={(event) => setCycleReason(event.target.value)}
            placeholder="Required"
            className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
          />
        </div>
        <Button type="submit" size="sm" variant="secondary" loading={cycleSaving}>
          Save cycle
        </Button>
      </form>
      {cycleError ? <p className="text-sm text-red-700">{cycleError}</p> : null}

      <form onSubmit={handleSaveOverride} className="space-y-2 border-t border-slate-200 pt-3">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Subscriber override</p>
        <div className="flex flex-wrap gap-2">
          <div className="w-28">
            <label htmlFor={`custom-monthly-${organizationId}`} className="block text-xs font-medium text-slate-600">
              Custom $/mo
            </label>
            <input
              id={`custom-monthly-${organizationId}`}
              value={overrideForm.customMonthly}
              onChange={(event) => setOverrideForm({ ...overrideForm, customMonthly: event.target.value })}
              placeholder="Plan price"
              className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
          </div>
          <div className="w-28">
            <label htmlFor={`custom-annual-${organizationId}`} className="block text-xs font-medium text-slate-600">
              Custom $/yr
            </label>
            <input
              id={`custom-annual-${organizationId}`}
              value={overrideForm.customAnnual}
              onChange={(event) => setOverrideForm({ ...overrideForm, customAnnual: event.target.value })}
              placeholder="Plan price"
              className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
          </div>
          <div className="w-24">
            <label htmlFor={`override-clients-${organizationId}`} className="block text-xs font-medium text-slate-600">
              Client cap
            </label>
            <input
              id={`override-clients-${organizationId}`}
              value={overrideForm.overrideClients}
              onChange={(event) => setOverrideForm({ ...overrideForm, overrideClients: event.target.value })}
              placeholder="Plan cap"
              className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
          </div>
          <div className="w-24">
            <label htmlFor={`override-caregivers-${organizationId}`} className="block text-xs font-medium text-slate-600">
              Staff cap
            </label>
            <input
              id={`override-caregivers-${organizationId}`}
              value={overrideForm.overrideCaregivers}
              onChange={(event) => setOverrideForm({ ...overrideForm, overrideCaregivers: event.target.value })}
              placeholder="Plan cap"
              className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
          </div>
          <div className="w-24">
            <label htmlFor={`override-admins-${organizationId}`} className="block text-xs font-medium text-slate-600">
              Admin cap
            </label>
            <input
              id={`override-admins-${organizationId}`}
              value={overrideForm.overrideAdmins}
              onChange={(event) => setOverrideForm({ ...overrideForm, overrideAdmins: event.target.value })}
              placeholder="Plan cap"
              className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
          </div>
          <div className="w-36">
            <label htmlFor={`override-expires-${organizationId}`} className="block text-xs font-medium text-slate-600">
              Expires
            </label>
            <input
              id={`override-expires-${organizationId}`}
              type="date"
              value={overrideForm.overrideExpires}
              onChange={(event) => setOverrideForm({ ...overrideForm, overrideExpires: event.target.value })}
              className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={overrideForm.complimentary}
            onChange={(event) => setOverrideForm({ ...overrideForm, complimentary: event.target.checked })}
            className="h-4 w-4"
          />
          Complimentary subscription (price is $0 regardless of plan/custom price)
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[10rem] flex-1">
            <label htmlFor={`override-note-${organizationId}`} className="block text-xs font-medium text-slate-600">
              Override note (shown to admins)
            </label>
            <input
              id={`override-note-${organizationId}`}
              value={overrideForm.overrideReason}
              onChange={(event) => setOverrideForm({ ...overrideForm, overrideReason: event.target.value })}
              className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
          </div>
          <div className="min-w-[10rem] flex-1">
            <label htmlFor={`override-reason-${organizationId}`} className="block text-xs font-medium text-slate-600">
              Audit reason
            </label>
            <input
              id={`override-reason-${organizationId}`}
              value={overrideForm.reason}
              onChange={(event) => setOverrideForm({ ...overrideForm, reason: event.target.value })}
              placeholder="Required"
              className="mt-1 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            />
          </div>
          <Button type="submit" size="sm" loading={overrideSaving}>
            Save override
          </Button>
        </div>
        {overrideError ? <p className="text-sm text-red-700">{overrideError}</p> : null}
      </form>
    </div>
  );
}
