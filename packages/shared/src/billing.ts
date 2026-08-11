// Billing/subscription types and pure helpers shared between the
// agency-facing Settings -> Billing page and the platform-owner plan
// editor. Backed by plan_definitions + organizations' subscriber
// columns (supabase/migrations/20260809161000_billing_plans_and_subscribers.sql,
// 20260809162000_billing_usage_enforcement.sql) - every number here
// mirrors what the database actually enforces, nothing is a
// frontend-only guess.

export type BillingSupportLevel = "standard" | "priority" | "dedicated";

export type SubscriptionEffectiveStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "suspended"
  | "trial_expired";

export type BillingCycle = "monthly" | "annual";

export interface OrganizationBillingSummary {
  organizationId: string;
  effectiveStatus: SubscriptionEffectiveStatus;
  planId: string | null;
  planKey: string | null;
  planName: string | null;
  planVersion: number | null;
  monthlyPriceCents: number | null;
  annualPriceCents: number | null;
  customMonthlyPriceCents: number | null;
  customAnnualPriceCents: number | null;
  isComplimentary: boolean;
  billingCycle: BillingCycle | null;
  billingCycleAnchor: string | null;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  maxActiveClients: number | null;
  maxActiveCaregivers: number | null;
  maxAdministrators: number | null;
  maxCompletedVisits: number | null;
  overrideMaxActiveClients: number | null;
  overrideMaxActiveCaregivers: number | null;
  overrideMaxAdministrators: number | null;
  overrideReason: string | null;
  overrideExpiresAt: string | null;
  reportRetentionDays: number | null;
  bulkExportLimit: number | null;
  supportLevel: BillingSupportLevel;
  smsAllowance: number;
  features: string[];
  activeClients: number;
  activeCaregivers: number;
  administrators: number;
  completedVisits: number;
  stripeConfigured: boolean;
  stripeCurrentPeriodStart: string | null;
  stripeCurrentPeriodEnd: string | null;
}

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionEffectiveStatus, string> = {
  trialing: "Trialing",
  active: "Active",
  past_due: "Past due",
  canceled: "Canceled",
  suspended: "Suspended",
  trial_expired: "Trial expired"
};

export const FEATURE_LABELS: Record<string, string> = {
  client_caregiver_management: "Client & caregiver management",
  assignments: "Caregiver-client-service assignments",
  scheduling: "Scheduling",
  service_codes: "Service codes",
  routing_sheets: "Service/routing sheets",
  signatures: "Electronic signatures",
  authorization_hours: "Authorization-hour limits",
  hour_calculations: "Authorized / scheduled / completed / remaining / gap hour calculations",
  corrections_audit_history: "Corrections with required notes and audit history",
  branded_pdfs: "Branded printable PDFs",
  hours_by_client: "Hours by client",
  hours_by_caregiver: "Hours by caregiver",
  pay_period_reports: "Pay-period and billing-period reports",
  dashboards: "Charts and dashboards",
  priority_support: "Priority support",
  extended_report_history: "Extended report history",
  bulk_export: "Bulk export",
  dedicated_support: "Dedicated support",
  sms_notifications: "SMS notifications"
};

// Same four-tier shape as getAuthorizationUsageStatus in ./authorizations.ts -
// "at limit" (right at the cap) is a distinct, actionable signal from
// "over" and from merely "approaching". A null limit means unlimited.
export type UsageStatus = "normal" | "warning_80" | "warning_90" | "at_limit";

export function getUsageStatus(used: number, limit: number | null): UsageStatus {
  if (limit === null) return "normal";
  if (used >= limit) return "at_limit";
  if (limit <= 0) return "normal";
  const ratio = used / limit;
  if (ratio >= 0.9) return "warning_90";
  if (ratio >= 0.8) return "warning_80";
  return "normal";
}

// An override wins over the plan's own limit only while it hasn't
// expired - mirrors get_organization_effective_limits() exactly so the
// UI's "X of Y" never disagrees with what the database will actually
// enforce on the next write.
export function getEffectiveLimit(
  planLimit: number | null,
  override: number | null,
  overrideExpiresAt: string | null,
  now: Date = new Date()
): number | null {
  if (override !== null && (overrideExpiresAt === null || new Date(overrideExpiresAt) > now)) {
    return override;
  }
  return planLimit;
}

export function getEffectivePriceCents(
  planPriceCents: number | null,
  customPriceCents: number | null,
  isComplimentary: boolean
): number | null {
  if (isComplimentary) return 0;
  if (customPriceCents !== null) return customPriceCents;
  return planPriceCents;
}

export function formatCents(cents: number | null): string {
  if (cents === null) return "—";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function getTrialDaysRemaining(trialEndsAt: string | null, now: Date = new Date()): number | null {
  if (!trialEndsAt) return null;
  const diffMs = new Date(trialEndsAt).getTime() - now.getTime();
  return Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
}

export function isReadOnlyStatus(status: SubscriptionEffectiveStatus): boolean {
  return status === "trial_expired" || status === "suspended" || status === "canceled";
}
