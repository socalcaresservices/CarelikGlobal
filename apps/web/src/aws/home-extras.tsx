// Home additions (Board 1): a compact Today's Visits list, three quick actions, and a "last updated / Refresh" status line.
// Each reuses a query that already exists (the schedule's shifts, the attention overview); nothing here computes a count of its own.
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { formatClockTime } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { coverageTone, freshness, REFRESH_MS, type AttentionOverview } from "./attention";
import { useAwsApi } from "./aws-workspace";
import { useAgencyClock } from "./agency-clock";
import { todaysVisits, useNow } from "./home-data";
import type { Shift } from "./schedule-page";
import { StatusChip } from "./ui/status-chip";

const LIMIT = 6;
const linkClass = "inline-flex min-h-[44px] items-center font-semibold text-og-link underline md:min-h-[32px]";

export function TodaysVisits() {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const { today } = useAgencyClock();
  const allowed = hasPermission("shifts.manage") || hasPermission("visits.manage");
  const now = useNow();
  const q = useQuery({
    queryKey: ["aws-shifts", activeOrganizationId, today, today],
    queryFn: async () => (await api.get<{ shifts: Shift[] }>("/v1/shifts", { organizationId: activeOrganizationId, from: today, to: today })).shifts,
    enabled: !!activeOrganizationId && allowed,
    refetchInterval: REFRESH_MS,
  });
  if (!allowed) return null;
  const all = q.data ?? [];
  const list = todaysVisits(all, now);
  const shown = list.slice(0, LIMIT);
  return (
    <section aria-labelledby="today-heading" className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h2 id="today-heading" className="text-lg font-bold text-og-ink">Today&apos;s visits</h2>
        <Link className={linkClass} to="/schedule">View all</Link>
      </div>
      {q.isLoading ? <p className="text-sm text-og-sub">Loading…</p> : null}
      {q.isError ? <p role="alert" className="text-sm text-red-700">Today&apos;s visits could not be loaded. They are not shown as zero. Use Refresh to try again.</p> : null}
      {q.data && all.length === 0 ? <p className="text-sm text-og-sub">No visits scheduled today.</p> : null}
      {q.data && all.length > 0 && list.length === 0 ? <p className="text-sm text-og-sub">No more visits today.</p> : null}
      {shown.length > 0 ? (
        <ul className="divide-y divide-og-line rounded-og border border-og-line bg-og-card" data-testid="todays-visits">
          {shown.map((s) => {
            const open = s.coverageState === "needs_coverage";
            const started = Date.parse(s.startsAt) <= now;
            return (
              <li key={s.shiftId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
                <span className="basis-full font-og-mono tabular-nums text-og-ink sm:basis-auto">{formatClockTime(s.startsAt)}–{formatClockTime(s.endsAt)}</span>
                <span className="min-w-0 flex-1 text-og-ink">
                  <span className="font-semibold">{s.clientName ?? s.clientCode}</span>
                  <span className="text-og-sub"> · {open ? "No caregiver" : (s.caregiverName ?? s.caregiverCode ?? "Caregiver assigned")}</span>
                </span>
                {open ? <StatusChip tone={coverageTone(s.startsAt, now)}>{coverageTone(s.startsAt, now) === "red" ? "Critical" : "Urgent"}</StatusChip>
                  : <span className="text-og-sub">{started && s.hasVisit ? "In progress" : "Scheduled"}</span>}
              </li>
            );
          })}
        </ul>
      ) : null}
      {list.length > LIMIT ? <p className="text-xs text-og-sub">Showing {LIMIT} of {list.length}. <Link className="font-semibold text-og-link underline" to="/schedule">View all</Link></p> : null}
    </section>
  );
}

const primary = "inline-flex min-h-[44px] items-center justify-center rounded-lg bg-og-accent px-4 text-sm font-semibold text-og-on-accent hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-link md:min-h-[40px]";
const secondary = "inline-flex min-h-[44px] items-center justify-center rounded-lg border border-og-line bg-og-card px-4 text-sm font-semibold text-og-ink hover:bg-og-page focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-link md:min-h-[40px]";

/** Exactly three actions, each shown only to someone who may use it. Each opens an existing workflow; none creates anything itself. */
export function QuickActions() {
  const { hasPermission } = useOrganization();
  const manage = hasPermission("shifts.manage");
  const actions = [
    manage ? { label: "Schedule Visit", to: "/schedule?add=1", cls: primary } : null,
    hasPermission("clients.names.read") ? { label: "Find Client", to: "/clients?find=1", cls: secondary } : null,
    manage ? { label: "Resolve Coverage", to: "/schedule?coverage=1", cls: secondary } : null,
  ].filter((a): a is { label: string; to: string; cls: string } => a !== null);
  if (actions.length === 0) return null;
  return (
    <nav aria-label="Quick actions" className="flex flex-wrap gap-2">
      {actions.map((a) => <Link key={a.label} to={a.to} className={a.cls}>{a.label}</Link>)}
    </nav>
  );
}

/** "Updated 3:42 PM" with a Refresh button, and a plain warning when the figures may be out of date. A failed refresh never shows zero. */
export function RefreshStatus({ overview, loading, failed, refreshing, onRefresh }: {
  overview: AttentionOverview | undefined; loading: boolean; failed: boolean; refreshing: boolean; onRefresh: () => void;
}) {
  const now = useNow();
  const f = freshness(loading, failed, overview, now);
  const time = "asOf" in f ? formatClockTime(f.asOf) : null;
  const warn = f.kind === "stale" ? (f.reason === "refresh_failed" ? `Could not refresh. These figures are from ${time} and may be out of date.` : `These figures are from ${time} and may be out of date.`)
    : f.kind === "unavailable" ? "These figures could not be loaded. They are not zero. Try again." : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p className="text-xs text-og-sub" data-testid="updated-at">{time ? `Updated ${time}` : f.kind === "loading" ? "Checking…" : "Not updated"}</p>
      <button type="button" onClick={onRefresh} disabled={refreshing} className="inline-flex min-h-[44px] items-center rounded-lg border border-og-line bg-og-card px-3 text-sm font-semibold text-og-ink hover:bg-og-page disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-link md:min-h-[40px]">
        {refreshing ? "Refreshing…" : f.kind === "unavailable" || (f.kind === "stale" && f.reason === "refresh_failed") ? "Retry" : "Refresh"}
      </button>
      {warn ? <p role="status" className="basis-full text-sm font-semibold text-amber-900"><span aria-hidden="true">▲ </span>{warn}</p> : null}
    </div>
  );
}

