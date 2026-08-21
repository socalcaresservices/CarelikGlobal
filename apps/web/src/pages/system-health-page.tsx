import { useQuery } from "@tanstack/react-query";
import { Card, MetricStrip, type MetricStripItem } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";

// Backed by get_platform_system_health() (see
// supabase/migrations/20260821010000_platform_system_health.sql) -
// platform-owner-only aggregates over the domain_events outbox and
// stripe_webhook_events, the only two pieces of real internal job/queue
// infrastructure this codebase has failure tracking for. There is no
// APM/monitoring integration anywhere in this app, so this deliberately
// does not attempt uptime/latency/error-rate metrics - only "is our own
// background processing keeping up."
interface SystemHealthSummary {
  domain_events_pending: number;
  domain_events_failed: number;
  domain_events_dead_letter: number;
  domain_events_oldest_due_minutes: number | null;
  stripe_webhook_failures_last_24h: number;
  stripe_webhook_last_failure_event_type: string | null;
  stripe_webhook_last_failure_error: string | null;
  stripe_webhook_last_failure_at: string | null;
}

// A queue running a little behind isn't an incident - process-events
// runs on its own schedule, so some pending/due backlog is normal.
// Only flag it once it's stale enough that the schedule itself looks
// broken, not merely mid-cycle.
const STALE_QUEUE_MINUTES = 15;

export function SystemHealthPage() {
  const { isPlatformOwner } = useOrganization();

  const healthQuery = useQuery({
    queryKey: ["platform-system-health"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_platform_system_health");
      if (error) throw error;
      return ((data ?? [])[0] ?? null) as SystemHealthSummary | null;
    },
    enabled: isPlatformOwner
  });

  if (!isPlatformOwner) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Platform Administration</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h2>
          <p className="mt-3 text-slate-600">Only the platform owner can view system health.</p>
        </Card>
      </section>
    );
  }

  const health = healthQuery.data;
  const queueStale = (health?.domain_events_oldest_due_minutes ?? 0) >= STALE_QUEUE_MINUTES;

  const queueMetrics: MetricStripItem[] = health
    ? [
        { key: "pending", label: "Events pending", value: health.domain_events_pending },
        {
          key: "failed",
          label: "Events retrying",
          value: health.domain_events_failed,
          tone: health.domain_events_failed > 0 ? "warning" : "success"
        },
        {
          key: "dead-letter",
          label: "Events dead-lettered",
          value: health.domain_events_dead_letter,
          tone: health.domain_events_dead_letter > 0 ? "danger" : "success"
        },
        {
          key: "oldest-due",
          label: "Oldest due event",
          value: health.domain_events_oldest_due_minutes !== null ? `${health.domain_events_oldest_due_minutes}m` : "—",
          tone: queueStale ? "danger" : "success",
          ...(queueStale ? { hint: "Queue may be stuck - check process-events" } : {})
        }
      ]
    : [];

  const webhookMetrics: MetricStripItem[] = health
    ? [
        {
          key: "webhook-failures",
          label: "Stripe sync failures (24h)",
          value: health.stripe_webhook_failures_last_24h,
          tone: health.stripe_webhook_failures_last_24h > 0 ? "danger" : "success"
        }
      ]
    : [];

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Platform Administration</p>
        <h1 className="text-2xl font-semibold text-slate-950">System health</h1>
        <p className="mt-1 text-sm text-slate-600">
          Internal job and sync health - the domain event outbox and Stripe webhook processing. Not infrastructure
          monitoring (uptime, latency, error rates) - no APM integration exists for that yet.
        </p>
      </div>

      {healthQuery.isLoading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : healthQuery.isError ? (
        <p className="text-sm text-red-700">Could not load system health.</p>
      ) : health ? (
        <>
          <div>
            <h3 className="text-sm font-semibold text-slate-700">Domain event outbox</h3>
            <div className="mt-2">
              <MetricStrip items={queueMetrics} />
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-slate-700">Stripe webhook sync</h3>
            <div className="mt-2">
              <MetricStrip items={webhookMetrics} />
            </div>
            {health.stripe_webhook_failures_last_24h > 0 && health.stripe_webhook_last_failure_event_type ? (
              <Card className="mt-3">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Most recent failure</p>
                <p className="mt-1 text-sm font-medium text-slate-900">
                  {health.stripe_webhook_last_failure_event_type}
                </p>
                {health.stripe_webhook_last_failure_error ? (
                  <p className="mt-1 text-sm text-slate-600">{health.stripe_webhook_last_failure_error}</p>
                ) : null}
                {health.stripe_webhook_last_failure_at ? (
                  <p className="mt-1 text-xs text-slate-400">
                    {new Date(health.stripe_webhook_last_failure_at).toLocaleString()}
                  </p>
                ) : null}
              </Card>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
