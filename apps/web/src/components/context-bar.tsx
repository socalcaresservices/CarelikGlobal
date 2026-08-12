import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Gauge, ShieldCheck, Users } from "lucide-react";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";

// The floating context bar: a thin, always-visible strip of live
// operational metrics sitting under the header on every page, reusing
// get_agency_dashboard (20260719300000) - the same aggregate already
// powering the owner dashboard's headline numbers - rather than
// inventing a second source of truth for "how is this organization
// doing right now." Distinct from the nav rail's badges (which flag
// *issues*): this bar is purely informational, same "counts vs signals"
// split action-center.tsx already draws between itself and
// OperationalSnapshot.
//
// A null metric (e.g. fill_rate_pct with no active authorizations to
// measure against) renders as "-" rather than 0%, so an org with
// nothing configured yet doesn't read as "0% filled."
//
// Deliberately does NOT repeat the organization's name - the sidebar
// header and the AppShell top bar both already show it, and a third
// repetition directly underneath added visual noise without adding
// information (OGEVIA SaaS structure spec, "remove duplicate
// organization titles").

interface AgencyDashboard {
  active_clients: number;
  active_caregivers: number;
  fill_rate_pct: number | null;
  compliance_score_pct: number | null;
  available_capacity_hours: number | null;
}

function formatPercent(value: number | null) {
  return value === null ? "—" : `${value}%`;
}

function formatHours(value: number | null) {
  if (value === null) return "—";
  return `${Math.round(value)}h`;
}

function formatToday(now: Date) {
  return now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

export function ContextBar() {
  const { activeOrganization, activeOrganizationId, hasPermission } = useOrganization();

  const dashboardQuery = useQuery({
    queryKey: ["context-bar-dashboard", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .rpc("get_agency_dashboard", { target_organization_id: activeOrganizationId! })
        .single();
      if (error) throw error;
      return data as AgencyDashboard;
    },
    enabled: !!activeOrganizationId && hasPermission("membership.read")
  });

  if (!activeOrganizationId || !activeOrganization) return null;

  const dashboard = dashboardQuery.data;

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-slate-200 bg-slate-50/80 px-6 py-2 text-sm text-slate-600">
      <span className="flex shrink-0 items-center gap-1.5">
        <CalendarDays className="h-3.5 w-3.5 text-slate-400" />
        {formatToday(new Date())}
      </span>
      {dashboardQuery.isLoading ? (
        <span className="text-slate-400">Loading live metrics…</span>
      ) : dashboardQuery.isError ? (
        <span className="text-red-600">Could not load live metrics.</span>
      ) : dashboard ? (
        <>
          <span className="flex shrink-0 items-center gap-1.5">
            <Gauge className="h-3.5 w-3.5 text-slate-400" />
            Coverage <span className="font-semibold text-slate-900">{formatPercent(dashboard.fill_rate_pct)}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-slate-400" />
            Compliance{" "}
            <span className="font-semibold text-slate-900">{formatPercent(dashboard.compliance_score_pct)}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <Users className="h-3.5 w-3.5 text-slate-400" />
            {dashboard.active_clients} clients · {dashboard.active_caregivers} caregivers
          </span>
          <span className="shrink-0 text-slate-500">
            {formatHours(dashboard.available_capacity_hours)} available capacity this week
          </span>
        </>
      ) : null}
    </div>
  );
}
