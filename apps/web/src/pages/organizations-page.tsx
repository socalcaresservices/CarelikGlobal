import { Fragment, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, PageHeader, StatusBadge, ProgressBar, usageTone, Button, type StatusTone } from "@carelik/ui";
import { useAuth } from "@carelik/auth";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { toAppUrl } from "@/lib/tenant-resolver";
import { PlatformPlanManager } from "@/components/platform-plan-manager";
import { PlatformSubscriberBillingPanel } from "@/components/platform-subscriber-billing-panel";

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

// Mirrors public.support_access_status (supabase/migrations/20260807000000_support_access.sql).
type SupportAccessStatus = "requested" | "active" | "expired" | "revoked" | "denied";

interface SupportAccessGrant {
  id: string;
  organization_id: string;
  grantee_user_id: string;
  requested_by: string;
  reason: string;
  status: SupportAccessStatus;
  requested_minutes: number;
  approved_by: string | null;
  approved_at: string | null;
  expires_at: string | null;
  revoked_by: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

const SUPPORT_ACCESS_STATUS: Record<SupportAccessStatus, { label: string; tone: StatusTone }> = {
  requested: { label: "Requested", tone: "info" },
  active: { label: "Active", tone: "success" },
  expired: { label: "Expired", tone: "neutral" },
  revoked: { label: "Revoked", tone: "neutral" },
  denied: { label: "Denied", tone: "danger" }
};

// A grant's `status` column only flips away from 'active' when someone
// calls revoke_support_access() - nothing flips it to 'expired' once
// expires_at passes (has_active_support_access() just checks both status
// and expires_at together). This derives the display-only distinction so
// a lapsed grant doesn't keep reading "Active" here.
function isEffectivelyExpired(grant: SupportAccessGrant) {
  return grant.status === "active" && grant.expires_at !== null && new Date(grant.expires_at) <= new Date();
}

// Requesting time-boxed access into a tenant, and reviewing/revoking your
// own past requests for that tenant - approve/deny happen tenant-side
// (see settings-page.tsx's SupportAccessCard). grantee_user_id and
// requested_by are always the calling platform user's own id (see
// request_support_access()), so "you" is the only identity this panel
// ever needs to distinguish - is_platform_owner() lets any platform
// owner also read every other platform staffer's grants for this org,
// shown here as "Platform staff" for that reason.
function SupportAccessPanel({ organizationId, currentUserId }: { organizationId: string; currentUserId: string }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const grantsQuery = useQuery({
    queryKey: ["support-access-grants", organizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_support_access_grants", {
        target_organization_id: organizationId
      });
      if (error) throw error;
      return (data ?? []) as SupportAccessGrant[];
    }
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["support-access-grants", organizationId] });
  }

  const grants = grantsQuery.data ?? [];
  const hasOpenRequest = grants.some(
    (grant) =>
      grant.grantee_user_id === currentUserId && (grant.status === "requested" || grant.status === "active")
  );

  async function handleRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reason.trim()) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const { error } = await supabase.rpc("request_support_access", {
        target_organization_id: organizationId,
        access_reason: reason.trim(),
        minutes
      });
      if (error) throw error;
      setReason("");
      setMinutes(60);
      refresh();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Could not request access.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(grantId: string) {
    setActionError(null);
    setPendingId(grantId);
    try {
      const { error } = await supabase.rpc("revoke_support_access", { grant_id: grantId });
      if (error) throw error;
      refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not revoke this grant.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="space-y-4 rounded-lg bg-slate-50 p-4">
      {grantsQuery.isLoading ? (
        <p className="text-sm text-slate-500">Loading support access…</p>
      ) : grantsQuery.isError ? (
        <p className="text-sm text-red-700">Could not load support access history.</p>
      ) : grants.length === 0 ? (
        <p className="text-sm text-slate-400">No support access requested for this organization yet.</p>
      ) : (
        <ul className="space-y-2">
          {grants.map((grant) => {
            const expired = isEffectivelyExpired(grant);
            const display = expired ? { label: "Expired", tone: "neutral" as const } : SUPPORT_ACCESS_STATUS[grant.status];
            const isOwnOpenGrant =
              grant.grantee_user_id === currentUserId && (grant.status === "requested" || grant.status === "active") && !expired;
            return (
              <li key={grant.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white p-3 text-sm">
                <div>
                  <p className="text-slate-800">{grant.grantee_user_id === currentUserId ? "Platform staff (you)" : "Platform staff"}</p>
                  <p className="text-xs text-slate-500">{grant.reason}</p>
                  {grant.expires_at ? (
                    <p className="text-xs text-slate-400">
                      {expired ? "Expired" : "Expires"} {new Date(grant.expires_at).toLocaleString()}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge label={display.label} tone={display.tone} />
                  {isOwnOpenGrant ? (
                    <Button type="button" variant="ghost" size="sm" loading={pendingId === grant.id} onClick={() => handleRevoke(grant.id)}>
                      Revoke
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {actionError ? <p className="text-sm text-red-700">{actionError}</p> : null}

      {!hasOpenRequest ? (
        <form onSubmit={handleRequest} className="flex flex-wrap items-end gap-3 border-t border-slate-200 pt-4">
          <div className="min-w-[220px] flex-1">
            <label htmlFor={`support-access-reason-${organizationId}`} className="block text-xs font-medium text-slate-600">
              Reason
            </label>
            <input
              id={`support-access-reason-${organizationId}`}
              required
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. Investigating a billing discrepancy ticket"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
            />
          </div>
          <div>
            <label htmlFor={`support-access-minutes-${organizationId}`} className="block text-xs font-medium text-slate-600">
              Minutes
            </label>
            <input
              id={`support-access-minutes-${organizationId}`}
              type="number"
              min={5}
              max={480}
              value={minutes}
              onChange={(event) => setMinutes(Number(event.target.value))}
              className="mt-1 w-24 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
            />
          </div>
          <Button type="submit" size="sm" loading={submitting}>
            Request access
          </Button>
        </form>
      ) : (
        <p className="text-xs text-slate-500">
          You already have an open request or active grant for this organization - revoke it before requesting again.
        </p>
      )}
      {formError ? <p className="text-sm text-red-700">{formError}</p> : null}
    </div>
  );
}

export function OrganizationsPage() {
  const { isPlatformOwner } = useOrganization();
  const { user } = useAuth();
  const [expandedOrgId, setExpandedOrgId] = useState<string | null>(null);

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
        description="Every tenant on Ogevia — plan, billing status, storage, seats, and account owner. Read-only: an organization's own profile is edited from within that tenant's Settings."
      />

      <PlatformPlanManager />

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
                  <th className="pb-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {rows.map((org) => {
                  const orgStatus = ORG_STATUS[org.status];
                  const subscriptionStatus = SUBSCRIPTION_STATUS[org.subscription_status];
                  const used = usedGb(org.storage_used_bytes);
                  const isExpanded = expandedOrgId === org.organization_id;
                  return (
                    <Fragment key={org.organization_id}>
                      <tr className="border-b border-slate-100 last:border-0">
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
                        <td className="py-2.5 pr-4">
                          <p className="text-slate-800">{org.primary_owner_name ?? "—"}</p>
                          <p className="text-xs text-slate-500">{org.primary_owner_email ?? ""}</p>
                        </td>
                        <td className="py-2.5 text-right">
                          <div className="flex items-center justify-end gap-3">
                            <a
                              href={toAppUrl(`/?org=${encodeURIComponent(org.slug)}`)}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs font-medium text-slate-700 underline-offset-2 hover:underline"
                            >
                              Enter organization
                            </a>
                            <button
                              type="button"
                              onClick={() => setExpandedOrgId(isExpanded ? null : org.organization_id)}
                              className="text-xs font-medium text-slate-700 underline-offset-2 hover:underline"
                            >
                              {isExpanded ? "Hide" : "Billing & support"}
                            </button>
                          </div>
                        </td>
                      </tr>
                      {isExpanded && user ? (
                        <tr className="border-b border-slate-100 last:border-0">
                          <td colSpan={8} className="space-y-3 py-3">
                            <PlatformSubscriberBillingPanel organizationId={org.organization_id} />
                            <SupportAccessPanel organizationId={org.organization_id} currentUserId={user.id} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
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
