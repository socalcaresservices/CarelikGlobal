import { useQuery } from "@tanstack/react-query";
import { MetricStrip, type MetricStripItem } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";

// The compact "numbers an owner needs the instant the page loads"
// strip - one dense row instead of the two separate "This week" /
// "Agency health" card grids that used to live on the dashboard.
// Every value here comes from a query that already exists elsewhere in
// the app (list_shifts, get_agency_dashboard, active clients/members
// counts) - nothing new is computed, this only changes how it's laid
// out. See docs/design-system.md's "Not yet built" section for metrics
// (coverage %, revenue at risk, staffing deficit) that intentionally
// aren't here: there's no data model behind them yet, and a fabricated
// number is worse than no number.
//
// Renders as one MetricStrip band (BUILD 001.5) instead of a grid of
// separate MetricCards - the same numbers, closer to the Epic-style
// "record header carries every headline metric at a glance" pattern
// docs/design-system.md describes, and the six cards' worth of
// individual borders/shadows collapse into one.

interface AgencyDashboardRow {
  active_clients: number;
  active_caregivers: number;
  fill_rate_pct: number | null;
  compliance_score_pct: number | null;
  available_capacity_hours: number | null;
}

function formatHours(hours: number) {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

function startOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

// A failed fetch previously fell back to the same "—" a metric with no
// data yet shows - indistinguishable from "nothing configured" even
// though the two mean very different things to an owner glancing at
// this strip. An errored metric now reads "!" in the danger tone with
// an explanatory hint instead.
function errorAwareItem(
  key: string,
  label: string,
  isError: boolean,
  value: MetricStripItem["value"],
  hint?: string
): MetricStripItem {
  if (isError) {
    return { key, label, value: "!", tone: "danger", hint: "Could not load" };
  }
  return { key, label, value, ...(hint ? { hint } : {}) };
}

export function OperationalSnapshot() {
  const { activeOrganizationId, hasPermission } = useOrganization();

  const canSeeClients = hasPermission("clients.read");
  const canSeeMembers = hasPermission("membership.read");

  const now = new Date();

  const shiftsTodayQuery = useQuery({
    queryKey: ["snapshot-shifts-today", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_shifts", {
        target_organization_id: activeOrganizationId!,
        from_time: startOfDay(now).toISOString(),
        to_time: endOfDay(now).toISOString()
      });
      if (error) throw error;
      return ((data ?? []) as Array<{ status: string }>).filter((shift) => shift.status === "scheduled")
        .length;
    },
    enabled: !!activeOrganizationId
  });

  const clientsCountQuery = useQuery({
    queryKey: ["snapshot-clients-count", activeOrganizationId],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("clients")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", activeOrganizationId!)
        .eq("status", "active");
      if (error) throw error;
      return count ?? 0;
    },
    enabled: !!activeOrganizationId && canSeeClients
  });

  const membersCountQuery = useQuery({
    queryKey: ["snapshot-members-count", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_organization_members", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return ((data ?? []) as Array<{ status: string }>).filter((member) => member.status === "active")
        .length;
    },
    enabled: !!activeOrganizationId && canSeeMembers
  });

  const dashboardQuery = useQuery({
    queryKey: ["snapshot-agency-dashboard", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_agency_dashboard", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return ((data ?? [])[0] ?? null) as AgencyDashboardRow | null;
    },
    enabled: !!activeOrganizationId && canSeeMembers
  });

  const fillRateHint = dashboardQuery.data?.fill_rate_pct === null ? "(no authorizations on file)" : undefined;
  const complianceHint =
    dashboardQuery.data?.compliance_score_pct === null ? "(no credentials on file)" : undefined;
  const capacityHint =
    dashboardQuery.data?.available_capacity_hours === null ? "(no weekly targets set)" : undefined;

  const items: MetricStripItem[] = [
    errorAwareItem("shifts-today", "Shifts today", shiftsTodayQuery.isError, shiftsTodayQuery.data ?? "—")
  ];

  if (canSeeClients) {
    items.push(
      errorAwareItem("active-clients", "Active clients", clientsCountQuery.isError, clientsCountQuery.data ?? "—")
    );
  }

  if (canSeeMembers) {
    items.push(
      errorAwareItem(
        "active-team",
        "Active team members",
        membersCountQuery.isError,
        membersCountQuery.data ?? "—"
      )
    );
    items.push(
      errorAwareItem(
        "fill-rate",
        "Fill rate this week",
        dashboardQuery.isError,
        dashboardQuery.data?.fill_rate_pct !== null && dashboardQuery.data?.fill_rate_pct !== undefined
          ? `${dashboardQuery.data.fill_rate_pct}%`
          : "—",
        fillRateHint
      )
    );
    items.push(
      errorAwareItem(
        "compliance-score",
        "Compliance score",
        dashboardQuery.isError,
        dashboardQuery.data?.compliance_score_pct !== null && dashboardQuery.data?.compliance_score_pct !== undefined
          ? `${dashboardQuery.data.compliance_score_pct}%`
          : "—",
        complianceHint
      )
    );
    items.push(
      errorAwareItem(
        "available-capacity",
        "Available capacity",
        dashboardQuery.isError,
        dashboardQuery.data?.available_capacity_hours !== null &&
          dashboardQuery.data?.available_capacity_hours !== undefined
          ? `${formatHours(dashboardQuery.data.available_capacity_hours)}h`
          : "—",
        capacityHint
      )
    );
  }

  return (
    <div>
      <p className="text-sm font-medium text-slate-500">Operational snapshot</p>
      <div className="mt-3">
        <MetricStrip items={items} />
      </div>
    </div>
  );
}
