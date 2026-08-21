import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, ProgressBar, StatusBadge, usageTone, type StatusTone } from "@carelik/ui";
import {
  FEATURE_LABELS,
  SUBSCRIPTION_STATUS_LABELS,
  formatCents,
  getEffectiveLimit,
  getEffectivePriceCents,
  getTrialDaysRemaining,
  getUsageStatus,
  isReadOnlyStatus,
  type OrganizationBillingSummary,
  type SubscriptionEffectiveStatus
} from "@carelik/shared";
import { supabase } from "@/lib/supabase";
import { createCheckoutSession } from "@/lib/billing-checkout";
import { createBillingPortalSession } from "@/lib/billing-portal";

// Row shape returned by get_organization_billing_summary() - snake_case
// straight off the RPC, mapped once into the shared camelCase type below
// rather than threading snake_case through the component.
interface BillingSummaryRow {
  organization_id: string;
  effective_status: SubscriptionEffectiveStatus;
  plan_id: string | null;
  plan_key: string | null;
  plan_name: string | null;
  plan_version: number | null;
  monthly_price_cents: number | null;
  annual_price_cents: number | null;
  custom_monthly_price_cents: number | null;
  custom_annual_price_cents: number | null;
  is_complimentary: boolean;
  billing_cycle: "monthly" | "annual" | null;
  billing_cycle_anchor: string | null;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  max_active_clients: number | null;
  max_active_caregivers: number | null;
  max_administrators: number | null;
  max_completed_visits: number | null;
  override_max_active_clients: number | null;
  override_max_active_caregivers: number | null;
  override_max_administrators: number | null;
  override_reason: string | null;
  override_expires_at: string | null;
  report_retention_days: number | null;
  bulk_export_limit: number | null;
  support_level: "standard" | "priority" | "dedicated";
  sms_allowance: number;
  features: string[];
  active_clients: number;
  active_caregivers: number;
  administrators: number;
  completed_visits: number;
  stripe_configured: boolean;
  stripe_current_period_start: string | null;
  stripe_current_period_end: string | null;
}

function toSummary(row: BillingSummaryRow): OrganizationBillingSummary {
  return {
    organizationId: row.organization_id,
    effectiveStatus: row.effective_status,
    planId: row.plan_id,
    planKey: row.plan_key,
    planName: row.plan_name,
    planVersion: row.plan_version,
    monthlyPriceCents: row.monthly_price_cents,
    annualPriceCents: row.annual_price_cents,
    customMonthlyPriceCents: row.custom_monthly_price_cents,
    customAnnualPriceCents: row.custom_annual_price_cents,
    isComplimentary: row.is_complimentary,
    billingCycle: row.billing_cycle,
    billingCycleAnchor: row.billing_cycle_anchor,
    trialStartedAt: row.trial_started_at,
    trialEndsAt: row.trial_ends_at,
    maxActiveClients: row.max_active_clients,
    maxActiveCaregivers: row.max_active_caregivers,
    maxAdministrators: row.max_administrators,
    maxCompletedVisits: row.max_completed_visits,
    overrideMaxActiveClients: row.override_max_active_clients,
    overrideMaxActiveCaregivers: row.override_max_active_caregivers,
    overrideMaxAdministrators: row.override_max_administrators,
    overrideReason: row.override_reason,
    overrideExpiresAt: row.override_expires_at,
    reportRetentionDays: row.report_retention_days,
    bulkExportLimit: row.bulk_export_limit,
    supportLevel: row.support_level,
    smsAllowance: row.sms_allowance,
    features: row.features ?? [],
    activeClients: row.active_clients,
    activeCaregivers: row.active_caregivers,
    administrators: row.administrators,
    completedVisits: row.completed_visits,
    stripeConfigured: row.stripe_configured,
    stripeCurrentPeriodStart: row.stripe_current_period_start,
    stripeCurrentPeriodEnd: row.stripe_current_period_end
  };
}

const STATUS_TONE: Record<SubscriptionEffectiveStatus, StatusTone> = {
  trialing: "info",
  active: "success",
  past_due: "warning",
  canceled: "neutral",
  suspended: "danger",
  trial_expired: "danger"
};

function UsageRow({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const status = getUsageStatus(used, limit);
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-slate-700">{label}</span>
        <span className="text-slate-500">{limit === null ? `${used} used` : `${used} of ${limit}`}</span>
      </div>
      {limit !== null ? (
        <>
          <ProgressBar value={used} max={limit} tone={usageTone(used, limit)} className="mt-1.5" />
          {status === "at_limit" ? (
            <p className="mt-1 text-xs font-medium text-red-700">Limit reached - upgrade to add more.</p>
          ) : status === "warning_90" ? (
            <p className="mt-1 text-xs font-medium text-amber-700">Approaching the plan limit (90%+ used).</p>
          ) : status === "warning_80" ? (
            <p className="mt-1 text-xs text-amber-600">80%+ of the plan limit used.</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function BillingSummaryCard({
  organizationId,
  canRead,
  canUpdate
}: {
  organizationId: string | null | undefined;
  canRead: boolean;
  canUpdate: boolean;
}) {
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [startingCheckout, setStartingCheckout] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);
  const [openingPortal, setOpeningPortal] = useState(false);
  // One-time read of ?checkout=success|cancelled - set by
  // create-checkout-session's success_url/cancel_url after a real Stripe
  // Checkout redirect. Reaching this page never means an org is paid on
  // its own; that only ever happens once stripe-webhook.ts processes the
  // signed event, hence "processing" phrasing rather than "success."
  const [checkoutParam] = useState(() => new URLSearchParams(window.location.search).get("checkout"));

  const summaryQuery = useQuery({
    queryKey: ["organization-billing-summary", organizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .rpc("get_organization_billing_summary", { target_organization_id: organizationId! })
        .maybeSingle();
      if (error) throw error;
      return data ? toSummary(data as BillingSummaryRow) : null;
    },
    enabled: !!organizationId && canRead
  });

  async function handleCheckout() {
    if (!organizationId) return;
    setStartingCheckout(true);
    setCheckoutError(null);
    try {
      const { url } = await createCheckoutSession(organizationId);
      window.location.href = url;
    } catch (cause) {
      setCheckoutError(cause instanceof Error ? cause.message : "Could not start checkout.");
      setStartingCheckout(false);
    }
  }

  async function handleOpenPortal() {
    if (!organizationId) return;
    setOpeningPortal(true);
    setPortalError(null);
    try {
      const { url } = await createBillingPortalSession(organizationId);
      window.location.href = url;
    } catch (cause) {
      setPortalError(cause instanceof Error ? cause.message : "Could not open billing management.");
      setOpeningPortal(false);
    }
  }

  if (!canRead) return null;

  if (summaryQuery.isLoading) {
    return (
      <Card>
        <p className="text-sm text-slate-500">Loading billing…</p>
      </Card>
    );
  }

  if (summaryQuery.isError || !summaryQuery.data) {
    return (
      <Card>
        <h3 className="font-semibold text-slate-950">Billing</h3>
        <p className="mt-2 text-sm text-red-700">Could not load billing information for this organization.</p>
      </Card>
    );
  }

  const summary = summaryQuery.data;
  const readOnly = isReadOnlyStatus(summary.effectiveStatus);
  const trialDaysRemaining = getTrialDaysRemaining(summary.trialEndsAt);

  const clientLimit = getEffectiveLimit(summary.maxActiveClients, summary.overrideMaxActiveClients, summary.overrideExpiresAt);
  const caregiverLimit = getEffectiveLimit(
    summary.maxActiveCaregivers,
    summary.overrideMaxActiveCaregivers,
    summary.overrideExpiresAt
  );
  const adminLimit = getEffectiveLimit(summary.maxAdministrators, summary.overrideMaxAdministrators, summary.overrideExpiresAt);

  const monthlyEffective = getEffectivePriceCents(summary.monthlyPriceCents, summary.customMonthlyPriceCents, summary.isComplimentary);
  const annualEffective = getEffectivePriceCents(summary.annualPriceCents, summary.customAnnualPriceCents, summary.isComplimentary);
  const cycle = summary.billingCycle ?? "monthly";
  const displayedPriceCents = cycle === "annual" ? annualEffective : monthlyEffective;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-500">Billing</p>
          <h3 className="mt-1 text-xl font-semibold text-slate-950">{summary.planName ?? "No plan assigned"}</h3>
        </div>
        <StatusBadge label={SUBSCRIPTION_STATUS_LABELS[summary.effectiveStatus]} tone={STATUS_TONE[summary.effectiveStatus]} />
      </div>

      {readOnly ? (
        <div className="mt-3 rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-800">
          {summary.effectiveStatus === "trial_expired"
            ? "Your trial has ended. Existing clients, visits, and signed records remain available to view, print, and export - contact your Ogevia platform administrator to upgrade and keep adding new ones."
            : "This subscription is not active. Existing records remain available to view, print, and export - contact your Ogevia platform administrator to reactivate."}
        </div>
      ) : null}

      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Price</dt>
          <dd className="mt-1 text-sm text-slate-700">
            {summary.isComplimentary ? (
              "Complimentary"
            ) : (
              <>
                {formatCents(displayedPriceCents)} / {cycle === "annual" ? "year" : "month"}
                {summary.customMonthlyPriceCents !== null || summary.customAnnualPriceCents !== null ? (
                  <span className="ml-1.5 text-xs text-slate-400">(custom price)</span>
                ) : null}
              </>
            )}
          </dd>
        </div>
        {summary.effectiveStatus === "trialing" ? (
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Trial days remaining</dt>
            <dd className="mt-1 text-sm text-slate-700">
              {trialDaysRemaining !== null ? `${trialDaysRemaining} day${trialDaysRemaining === 1 ? "" : "s"}` : "—"}
            </dd>
          </div>
        ) : (
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Renewal date</dt>
            <dd className="mt-1 text-sm text-slate-700">
              {/* stripeCurrentPeriodEnd (from the real Stripe subscription,
                  synced by the webhook) is authoritative when present -
                  billingCycleAnchor is only ever a manually-set fallback
                  for orgs without a real Stripe subscription (complimentary/
                  platform-overridden billing). */}
              {summary.stripeCurrentPeriodEnd
                ? new Date(summary.stripeCurrentPeriodEnd).toLocaleDateString()
                : summary.billingCycleAnchor
                  ? new Date(summary.billingCycleAnchor).toLocaleDateString()
                  : "Not set"}
            </dd>
          </div>
        )}
      </dl>

      <div className="mt-5 space-y-4 border-t border-slate-100 pt-4">
        <UsageRow label="Active clients" used={summary.activeClients} limit={clientLimit} />
        <UsageRow label="Caregivers / staff" used={summary.activeCaregivers} limit={caregiverLimit} />
        <UsageRow label="Administrators" used={summary.administrators} limit={adminLimit} />
        {summary.maxCompletedVisits !== null ? (
          <UsageRow label="Completed visits (trial)" used={summary.completedVisits} limit={summary.maxCompletedVisits} />
        ) : null}
      </div>

      {summary.features.length > 0 ? (
        <div className="mt-5 border-t border-slate-100 pt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Included features</p>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {summary.features.map((feature) => (
              <li key={feature} className="text-sm text-slate-700">
                {FEATURE_LABELS[feature] ?? feature}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-5 border-t border-slate-100 pt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Payment method &amp; invoices</p>
        {summary.stripeConfigured ? (
          canUpdate ? (
            <div className="mt-2 space-y-2">
              {portalError ? <p className="text-sm text-red-700">{portalError}</p> : null}
              <Button type="button" variant="secondary" loading={openingPortal} onClick={handleOpenPortal}>
                Manage billing
              </Button>
              <p className="text-xs text-slate-400">
                Opens Stripe&rsquo;s secure billing portal to update your payment method, view invoices, or cancel.
              </p>
            </div>
          ) : (
            <p className="mt-1 text-sm text-slate-400">
              Contact an organization admin to update the payment method or view invoices.
            </p>
          )
        ) : (
          <p className="mt-1 text-sm text-slate-400">No payment history available yet.</p>
        )}
      </div>

      {canUpdate ? (
        <div className="mt-5 space-y-3 border-t border-slate-100 pt-4">
          {checkoutParam === "success" ? (
            <p className="rounded-lg bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800">
              Checkout complete - your subscription is being processed and will show up here within a minute or
              two.
            </p>
          ) : checkoutParam === "cancelled" ? (
            <p className="rounded-lg bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
              Checkout was cancelled - no charge was made.
            </p>
          ) : null}
          {checkoutError ? <p className="text-sm text-red-700">{checkoutError}</p> : null}

          {summary.effectiveStatus === "active" ? (
            <p className="text-sm text-slate-600">You&rsquo;re subscribed to Ogevia Starter.</p>
          ) : (
            <Button type="button" loading={startingCheckout} onClick={handleCheckout}>
              Subscribe to Ogevia Starter
            </Button>
          )}
        </div>
      ) : null}
    </Card>
  );
}
