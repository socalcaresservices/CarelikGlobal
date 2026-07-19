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
    </section>
  );
}
