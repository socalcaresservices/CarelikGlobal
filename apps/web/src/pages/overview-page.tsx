import { useQuery } from "@tanstack/react-query";
import { Card } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { ActionCenter } from "@/components/action-center";

// Overview leads with the Action Center - "what needs my attention" -
// per docs/design-system.md, not architecture talk. See that doc for
// why deeper signals (compliance, authorizations, incidents) aren't
// here yet: no data model exists for them, and a fabricated number is
// worse than no number.

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

export function OverviewPage() {
  const { activeOrganization, activeOrganizationId, hasPermission } = useOrganization();

  const canSeeClients = hasPermission("clients.read");
  const canSeeMembers = hasPermission("membership.read");

  const clientsCountQuery = useQuery({
    queryKey: ["overview-clients-count", activeOrganizationId],
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
    queryKey: ["overview-members-count", activeOrganizationId],
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

  const upcomingShiftsQuery = useQuery({
    queryKey: ["overview-upcoming-shifts", activeOrganizationId],
    queryFn: async () => {
      const now = new Date();
      const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const { data, error } = await supabase.rpc("list_shifts", {
        target_organization_id: activeOrganizationId!,
        from_time: now.toISOString(),
        to_time: weekOut.toISOString()
      });
      if (error) throw error;
      return ((data ?? []) as Array<{ status: string }>).filter((shift) => shift.status === "scheduled")
        .length;
    },
    enabled: !!activeOrganizationId
  });

  const dashboardQuery = useQuery({
    queryKey: ["overview-agency-dashboard", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_agency_dashboard", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return ((data ?? [])[0] ?? null) as AgencyDashboardRow | null;
    },
    enabled: !!activeOrganizationId && canSeeMembers
  });

  return (
    <section className="mx-auto max-w-6xl space-y-8">
      <div>
        <p className="text-sm font-medium text-slate-500">Overview</p>
        <h2 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">
          {activeOrganization?.displayName ?? "CareLik Global"}
        </h2>
      </div>

      <ActionCenter />

      <div>
        <p className="text-sm font-medium text-slate-500">This week</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Card>
            <p className="text-3xl font-semibold tracking-tight text-slate-950">
              {upcomingShiftsQuery.data ?? "—"}
            </p>
            <p className="mt-1 text-sm text-slate-600">Shifts in the next 7 days</p>
          </Card>
          {canSeeClients ? (
            <Card>
              <p className="text-3xl font-semibold tracking-tight text-slate-950">
                {clientsCountQuery.data ?? "—"}
              </p>
              <p className="mt-1 text-sm text-slate-600">Active clients</p>
            </Card>
          ) : null}
          {canSeeMembers ? (
            <Card>
              <p className="text-3xl font-semibold tracking-tight text-slate-950">
                {membersCountQuery.data ?? "—"}
              </p>
              <p className="mt-1 text-sm text-slate-600">Active team members</p>
            </Card>
          ) : null}
        </div>
      </div>

      {canSeeMembers ? (
        <div>
          <p className="text-sm font-medium text-slate-500">Agency health</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Card>
              <p className="text-3xl font-semibold tracking-tight text-slate-950">
                {dashboardQuery.data?.fill_rate_pct !== null && dashboardQuery.data?.fill_rate_pct !== undefined
                  ? `${dashboardQuery.data.fill_rate_pct}%`
                  : "—"}
              </p>
              <p className="mt-1 text-sm text-slate-600">
                Fill rate this week
                {dashboardQuery.data?.fill_rate_pct === null ? " (no authorizations on file)" : ""}
              </p>
            </Card>
            <Card>
              <p className="text-3xl font-semibold tracking-tight text-slate-950">
                {dashboardQuery.data?.compliance_score_pct !== null &&
                dashboardQuery.data?.compliance_score_pct !== undefined
                  ? `${dashboardQuery.data.compliance_score_pct}%`
                  : "—"}
              </p>
              <p className="mt-1 text-sm text-slate-600">
                Compliance score
                {dashboardQuery.data?.compliance_score_pct === null ? " (no credentials on file)" : ""}
              </p>
            </Card>
            <Card>
              <p className="text-3xl font-semibold tracking-tight text-slate-950">
                {dashboardQuery.data?.available_capacity_hours !== null &&
                dashboardQuery.data?.available_capacity_hours !== undefined
                  ? `${formatHours(dashboardQuery.data.available_capacity_hours)}h`
                  : "—"}
              </p>
              <p className="mt-1 text-sm text-slate-600">
                Available capacity
                {dashboardQuery.data?.available_capacity_hours === null ? " (no weekly targets set)" : ""}
              </p>
            </Card>
          </div>
        </div>
      ) : null}
    </section>
  );
}
