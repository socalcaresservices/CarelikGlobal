import { useQuery } from "@tanstack/react-query";
import { Card, PageHeader, StatusBadge, ProgressBar, usageTone, type StatusTone } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";

// Platform-only registry view, backed by list_platform_organizations()
// (supabase/migrations/20260807131803_subscriptions_and_registry.sql)
// rather than a direct organizations read - platform staff have no RLS
// access to every tenant's row otherwise, and the RPC also joins in
// storage usage, seat count, last login, and the primary owner, none of
// which live on the organizations table itself. Read-only by design (see
// docs/BUILD_022_MULTI_TENANT_ARCHITECTURE.md: "Organization registry
// (read-only list of all tenants)") - an organization's own profile is
// edited from within its own Settings, not from here.
interface PlatformOrganizationRow {
  organization_id: string;
  slug: string;
  display_name: string;
  status: "active" | "suspended" | "closed";
  subscription_plan: "trial" | "starter" | "professional" | "enterprise";
  subscription_status: "trialing" | "active" | "past_due" | "canceled" | "suspended";
  storage_used_bytes: number;
  storage_limit_gb: number;
  user_count: number;
  last_login_at: string | null;
  primary_owner_name: string | null;
  primary_owner_email: string | null;
  created_at: string;
}

const ORG_STATUS: Record<PlatformOrganizationRow["status"], { label: string; tone: StatusTone }> = {
  active: { label: "Active", tone: "success" },
  suspended: { label: "Suspended", tone: "warning" },
  closed: { label: "Closed", tone: "neutral" }
};

const SUBSCRIPTION_STATUS: Record<PlatformOrganizationRow["subscription_status"], { label: string; tone: StatusTone }> = {
  trialing: { label: "Trialing", tone: "info" },
  active: { label: "Active", tone: "success" },
  past_due: { label: "Past due", tone: "warning" },
  canceled: { label: "Canceled", tone: "neutral" },
  suspended: { label: "Suspended", tone: "danger" }
};

const PLAN_LABEL: Record<PlatformOrganizationRow["subscription_plan"], string> = {
  trial: "Trial",
  starter: "Starter",
  professional: "Professional",
  enterprise: "Enterprise"
};

const BYTES_PER_GB = 1024 * 1024 * 1024;

function usedGb(bytes: number) {
  return bytes / BYTES_PER_GB;
}

export function OrganizationsPage() {
  const { isPlatformOwner } = useOrganization();

  const registryQuery = useQuery({
    queryKey: ["platform-organizations"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_platform_organizations");
      if (error) throw error;
      return (data ?? []) as PlatformOrganizationRow[];
    },
    enabled: isPlatformOwner
  });

  if (!isPlatformOwner) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Platform Administration</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h2>
          <p className="mt-3 text-slate-600">Only the platform owner can view the organization registry.</p>
        </Card>
      </section>
    );
  }

  const rows = registryQuery.data ?? [];

  return (
    <section className="mx-auto max-w-6xl space-y-6 pb-12">
      <PageHeader
        eyebrow="Platform Administration"
        title={`${rows.length} organization${rows.length === 1 ? "" : "s"}`}
        description="Every tenant on CareLik — plan, billing status, storage, seats, and account owner. Read-only: an organization's own profile is edited from within that tenant's Settings."
      />

      <Card>
        {registryQuery.isLoading ? (
          <p className="text-sm text-slate-500">Loading organizations…</p>
        ) : registryQuery.isError ? (
          <p className="text-sm text-red-700">Could not load the organization registry.</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-400">No organizations yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <th className="pb-2 font-medium">Organization</th>
                  <th className="pb-2 font-medium">Plan</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Storage</th>
                  <th className="pb-2 font-medium">Users</th>
                  <th className="pb-2 font-medium">Last login</th>
                  <th className="pb-2 font-medium">Primary owner</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((org) => {
                  const orgStatus = ORG_STATUS[org.status];
                  const subscriptionStatus = SUBSCRIPTION_STATUS[org.subscription_status];
                  const used = usedGb(org.storage_used_bytes);
                  return (
                    <tr key={org.organization_id} className="border-b border-slate-100 last:border-0">
                      <td className="py-2.5 pr-4">
                        <p className="font-medium text-slate-900">{org.display_name}</p>
                        <p className="text-xs text-slate-500">{org.slug}</p>
                      </td>
                      <td className="py-2.5 pr-4 text-slate-700">{PLAN_LABEL[org.subscription_plan]}</td>
                      <td className="py-2.5 pr-4">
                        <div className="flex flex-col items-start gap-1">
                          <StatusBadge label={orgStatus.label} tone={orgStatus.tone} />
                          <StatusBadge label={subscriptionStatus.label} tone={subscriptionStatus.tone} />
                        </div>
                      </td>
                      <td className="py-2.5 min-w-[9rem] pr-4">
                        <ProgressBar value={used} max={org.storage_limit_gb} tone={usageTone(used, org.storage_limit_gb)} />
                        <p className="mt-1 text-xs text-slate-500">
                          {used.toFixed(2)} GB / {org.storage_limit_gb} GB
                        </p>
                      </td>
                      <td className="py-2.5 pr-4 text-slate-700">{org.user_count}</td>
                      <td className="py-2.5 pr-4 whitespace-nowrap text-slate-500">
                        {org.last_login_at ? new Date(org.last_login_at).toLocaleString() : "Never"}
                      </td>
                      <td className="py-2.5">
                        <p className="text-slate-800">{org.primary_owner_name ?? "—"}</p>
                        <p className="text-xs text-slate-500">{org.primary_owner_email ?? ""}</p>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </section>
  );
}
