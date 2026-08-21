import { useQuery } from "@tanstack/react-query";
import { Card, MetricStrip, type MetricStripItem } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";

// Backed by get_platform_dashboard_summary() and
// get_platform_plan_distribution() (see
// supabase/migrations/20260820070000_platform_dashboard_summary.sql) -
// platform-owner-only aggregates over the same organizations/
// plan_definitions data the Organizations registry already shows per
// row. This is the "how many, how much" view getPlatformRoutes has had
// a TODO for since the platform shell was first written; Organizations
// stays the place for row-level detail and per-org actions.
interface DashboardSummary {
  total_organizations: number;
  trialing_count: number;
  active_count: number;
  past_due_count: number;
  canceled_count: number;
  suspended_count: number;
  trial_expired_count: number;
  new_organizations_last_30_days: number;
  trials_ending_next_7_days: number;
  mrr_cents: number;
}

interface PlanDistributionRow {
  plan_key: string;
  plan_name: string;
  subscriber_count: number;
}

function formatCurrency(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function PlatformDashboardPage() {
  const { isPlatformOwner } = useOrganization();

  const summaryQuery = useQuery({
    queryKey: ["platform-dashboard-summary"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_platform_dashboard_summary");
      if (error) throw error;
      return ((data ?? [])[0] ?? null) as DashboardSummary | null;
    },
    enabled: isPlatformOwner
  });

  const distributionQuery = useQuery({
    queryKey: ["platform-plan-distribution"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_platform_plan_distribution");
      if (error) throw error;
      return (data ?? []) as PlanDistributionRow[];
    },
    enabled: isPlatformOwner
  });

  if (!isPlatformOwner) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Platform Administration</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h2>
          <p className="mt-3 text-slate-600">Only the platform owner can view the platform dashboard.</p>
        </Card>
      </section>
    );
  }

  const summary = summaryQuery.data;

  const topMetrics: MetricStripItem[] = summary
    ? [
        { key: "total", label: "Organizations", value: summary.total_organizations },
        { key: "mrr", label: "MRR", value: formatCurrency(summary.mrr_cents) },
        { key: "signups", label: "New (30 days)", value: summary.new_organizations_last_30_days },
        {
          key: "trials-ending",
          label: "Trials ending (7 days)",
          value: summary.trials_ending_next_7_days,
          tone: summary.trials_ending_next_7_days > 0 ? "warning" : "success"
        }
      ]
    : [];

  const statusMetrics: MetricStripItem[] = summary
    ? [
        { key: "trialing", label: "Trialing", value: summary.trialing_count },
        { key: "active", label: "Active", value: summary.active_count, tone: "success" },
        { key: "past_due", label: "Past due", value: summary.past_due_count, tone: summary.past_due_count > 0 ? "danger" : "success" },
        { key: "trial_expired", label: "Trial expired", value: summary.trial_expired_count, tone: summary.trial_expired_count > 0 ? "warning" : "success" },
        { key: "suspended", label: "Suspended", value: summary.suspended_count, tone: summary.suspended_count > 0 ? "danger" : "success" },
        { key: "canceled", label: "Canceled", value: summary.canceled_count }
      ]
    : [];

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Platform Administration</p>
        <h1 className="text-2xl font-semibold text-slate-950">Dashboard</h1>
        <p className="mt-1 text-sm text-slate-600">
          Platform-wide subscriber and revenue summary. See Organizations for row-level detail and per-org actions.
        </p>
      </div>

      {summaryQuery.isLoading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : summaryQuery.isError ? (
        <p className="text-sm text-red-700">Could not load the platform dashboard.</p>
      ) : summary ? (
        <>
          <MetricStrip items={topMetrics} />
          <MetricStrip items={statusMetrics} />
        </>
      ) : null}

      <Card>
        <h3 className="font-semibold text-slate-950">Plan distribution</h3>
        {distributionQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : distributionQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">Could not load plan distribution.</p>
        ) : (distributionQuery.data ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No plans configured.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {(distributionQuery.data ?? []).map((row) => (
              <li key={row.plan_key} className="flex items-center justify-between py-2 text-sm">
                <span className="text-slate-700">{row.plan_name}</span>
                <span className="font-medium text-slate-900">{row.subscriber_count}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
