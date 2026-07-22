import { useQuery } from "@tanstack/react-query";
import { Card, StatusBadge, type StatusTone } from "@carelik/ui";
import {
  getAuthorizationExpiryStatus,
  getAuthorizationUsageStatus,
  getCredentialStatus,
  membershipStatusSchema,
  type AuthorizationExpiryStatus,
  type AuthorizationUsageStatus,
  type CredentialStatus,
  type IncidentSeverity,
  type IncidentStatus,
  type MembershipStatus
} from "@carelik/shared";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";

// Owner-only rollup: aggregate counts across every operational entity in
// one place. Distinct from the two dashboard-ish views that already
// exist - Action Center (an itemized "what needs my attention right
// now" list on Overview) and Overview's "Agency health" cards (three
// headline metrics visible to anyone with membership.read) - this page
// answers "how many of X are in each state," which is a strategic
// rollup rather than a day-to-day task list. Restricted to
// organization_owner/platform_owner via `role` (not a permission check -
// every other org-level role, including organization_admin, has an
// identical permission set today, so this is the one place in the app
// that gates on role instead of a granted permission).
//
// Every section reuses the exact same list_* RPCs and derive-at-read-
// time status functions the source pages already use (list_organization_
// members, list_caregiver_credentials, list_client_authorizations,
// list_incidents, list_audit_logs) - no new RPC, no new schema, no
// number that isn't already computed identically somewhere else in the
// app. Each section is additionally gated on its own read permission
// (defensive - owners typically hold every permission, but the page
// shouldn't assume that) and simply doesn't render if the caller lacks
// it, same "degrade gracefully" pattern global_search() uses.

interface MemberRow {
  role: string;
  status: MembershipStatus;
}

interface CredentialRow {
  expires_at: string | null;
}

interface AuthorizationRow {
  max_monthly_hours: number;
  hours_used_this_month: number;
  hours_scheduled_this_month: number;
  period_end: string;
}

interface IncidentRow {
  severity: IncidentSeverity;
  status: IncidentStatus;
  occurred_at: string;
}

interface AuditRow {
  occurred_at: string;
}

const credentialStatusTone: Record<CredentialStatus, StatusTone> = {
  no_expiration: "neutral",
  active: "success",
  expiring_soon: "warning",
  expired: "danger"
};

const credentialStatusLabel: Record<CredentialStatus, string> = {
  no_expiration: "No expiration",
  active: "Active",
  expiring_soon: "Expiring soon",
  expired: "Expired"
};

const authUsageTone: Record<AuthorizationUsageStatus, StatusTone> = {
  normal: "success",
  approaching_limit: "warning",
  at_limit: "danger",
  over_limit: "danger"
};

const authUsageLabel: Record<AuthorizationUsageStatus, string> = {
  normal: "Normal usage",
  approaching_limit: "Approaching limit",
  at_limit: "At limit",
  over_limit: "Over limit"
};

const authExpiryTone: Record<AuthorizationExpiryStatus, StatusTone> = {
  active: "success",
  expiring_soon: "warning",
  expired: "danger"
};

const authExpiryLabel: Record<AuthorizationExpiryStatus, string> = {
  active: "Active",
  expiring_soon: "Expiring soon",
  expired: "Expired"
};

const incidentStatusTone: Record<IncidentStatus, StatusTone> = {
  open: "danger",
  under_review: "warning",
  resolved: "success"
};

const incidentStatusLabel: Record<IncidentStatus, string> = {
  open: "Open",
  under_review: "Under review",
  resolved: "Resolved"
};

const incidentSeverityTone: Record<IncidentSeverity, StatusTone> = {
  low: "neutral",
  medium: "warning",
  high: "danger"
};

const membershipStatusTone: Record<MembershipStatus, StatusTone> = {
  active: "success",
  invited: "warning",
  suspended: "neutral",
  revoked: "danger"
};

function formatRole(role: string) {
  return role.replace(/_/g, " ");
}

function tally<T extends string>(values: T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function BreakdownRow({ label, tone, count }: { label: string; tone: StatusTone; count: number }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <StatusBadge label={label} tone={tone} />
      <span className="text-sm font-semibold text-slate-900">{count}</span>
    </div>
  );
}

export function OwnerDashboardPage() {
  const { activeOrganization, activeOrganizationId, role, hasPermission } = useOrganization();

  const isOwner = role === "organization_owner" || role === "platform_owner";

  const canSeeMembers = hasPermission("membership.read");
  const canSeeCredentials = hasPermission("credentials.read");
  const canSeeAuthorizations = hasPermission("authorizations.read");
  const canSeeIncidents = hasPermission("incidents.read");
  const canSeeAudit = hasPermission("audit.read");

  const membersQuery = useQuery({
    queryKey: ["owner-dashboard-members", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_organization_members", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as MemberRow[];
    },
    enabled: !!activeOrganizationId && isOwner && canSeeMembers
  });

  const credentialsQuery = useQuery({
    queryKey: ["owner-dashboard-credentials", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_caregiver_credentials", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as CredentialRow[];
    },
    enabled: !!activeOrganizationId && isOwner && canSeeCredentials
  });

  const authorizationsQuery = useQuery({
    queryKey: ["owner-dashboard-authorizations", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_client_authorizations", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as AuthorizationRow[];
    },
    enabled: !!activeOrganizationId && isOwner && canSeeAuthorizations
  });

  const incidentsQuery = useQuery({
    queryKey: ["owner-dashboard-incidents", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_incidents", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as IncidentRow[];
    },
    enabled: !!activeOrganizationId && isOwner && canSeeIncidents
  });

  const auditQuery = useQuery({
    queryKey: ["owner-dashboard-audit", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_audit_logs", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as AuditRow[];
    },
    enabled: !!activeOrganizationId && isOwner && canSeeAudit
  });

  if (!isOwner) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Owner dashboard</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h2>
          <p className="mt-3 text-slate-600">
            Only the organization owner can view this rollup.
          </p>
        </Card>
      </section>
    );
  }

  const roleCounts = tally((membersQuery.data ?? []).map((m) => m.role));
  const statusCounts = tally((membersQuery.data ?? []).map((m) => m.status));

  const credentialCounts = tally(
    (credentialsQuery.data ?? []).map((c) => getCredentialStatus(c.expires_at))
  );

  const usageCounts = tally(
    (authorizationsQuery.data ?? []).map((a) =>
      getAuthorizationUsageStatus(a.max_monthly_hours, a.hours_used_this_month, a.hours_scheduled_this_month)
    )
  );
  const expiryCounts = tally((authorizationsQuery.data ?? []).map((a) => getAuthorizationExpiryStatus(a.period_end)));

  const incidentStatusCounts = tally((incidentsQuery.data ?? []).map((i) => i.status));
  const incidentSeverityCounts = tally((incidentsQuery.data ?? []).map((i) => i.severity));

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const auditLast7Days = (auditQuery.data ?? []).filter(
    (entry) => new Date(entry.occurred_at).getTime() >= sevenDaysAgo.getTime()
  ).length;

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Owner dashboard</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-950">
          {activeOrganization?.displayName ?? "Operations rollup"}
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Organization-wide counts by status, for a strategic read on where things stand -
          not a task list (that's Action Center on Overview).
        </p>
      </div>

      {canSeeMembers ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <h3 className="font-semibold text-slate-950">Team by role</h3>
            {membersQuery.isLoading ? (
              <p className="mt-3 text-sm text-slate-500">Loading…</p>
            ) : roleCounts.size === 0 ? (
              <p className="mt-3 text-sm text-slate-400">No team members yet.</p>
            ) : (
              <div className="mt-2 divide-y divide-slate-100">
                {[...roleCounts.entries()].map(([roleKey, count]) => (
                  <BreakdownRow key={roleKey} label={formatRole(roleKey)} tone="neutral" count={count} />
                ))}
              </div>
            )}
          </Card>
          <Card>
            <h3 className="font-semibold text-slate-950">Team by status</h3>
            {membersQuery.isLoading ? (
              <p className="mt-3 text-sm text-slate-500">Loading…</p>
            ) : statusCounts.size === 0 ? (
              <p className="mt-3 text-sm text-slate-400">No team members yet.</p>
            ) : (
              <div className="mt-2 divide-y divide-slate-100">
                {membershipStatusSchema.options
                  .filter((status) => statusCounts.has(status))
                  .map((status) => (
                    <BreakdownRow
                      key={status}
                      label={status}
                      tone={membershipStatusTone[status]}
                      count={statusCounts.get(status) ?? 0}
                    />
                  ))}
              </div>
            )}
          </Card>
        </div>
      ) : null}

      {canSeeCredentials ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Credential compliance</h3>
          {credentialsQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : credentialCounts.size === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No credentials tracked yet.</p>
          ) : (
            <div className="mt-2 grid gap-x-6 sm:grid-cols-2">
              {(Object.keys(credentialStatusLabel) as CredentialStatus[])
                .filter((status) => credentialCounts.has(status))
                .map((status) => (
                  <BreakdownRow
                    key={status}
                    label={credentialStatusLabel[status]}
                    tone={credentialStatusTone[status]}
                    count={credentialCounts.get(status) ?? 0}
                  />
                ))}
            </div>
          )}
        </Card>
      ) : null}

      {canSeeAuthorizations ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <h3 className="font-semibold text-slate-950">Authorizations by usage</h3>
            {authorizationsQuery.isLoading ? (
              <p className="mt-3 text-sm text-slate-500">Loading…</p>
            ) : usageCounts.size === 0 ? (
              <p className="mt-3 text-sm text-slate-400">No authorizations tracked yet.</p>
            ) : (
              <div className="mt-2 divide-y divide-slate-100">
                {(Object.keys(authUsageLabel) as AuthorizationUsageStatus[])
                  .filter((status) => usageCounts.has(status))
                  .map((status) => (
                    <BreakdownRow
                      key={status}
                      label={authUsageLabel[status]}
                      tone={authUsageTone[status]}
                      count={usageCounts.get(status) ?? 0}
                    />
                  ))}
              </div>
            )}
          </Card>
          <Card>
            <h3 className="font-semibold text-slate-950">Authorizations by expiry</h3>
            {authorizationsQuery.isLoading ? (
              <p className="mt-3 text-sm text-slate-500">Loading…</p>
            ) : expiryCounts.size === 0 ? (
              <p className="mt-3 text-sm text-slate-400">No authorizations tracked yet.</p>
            ) : (
              <div className="mt-2 divide-y divide-slate-100">
                {(Object.keys(authExpiryLabel) as AuthorizationExpiryStatus[])
                  .filter((status) => expiryCounts.has(status))
                  .map((status) => (
                    <BreakdownRow
                      key={status}
                      label={authExpiryLabel[status]}
                      tone={authExpiryTone[status]}
                      count={expiryCounts.get(status) ?? 0}
                    />
                  ))}
              </div>
            )}
          </Card>
        </div>
      ) : null}

      {canSeeIncidents ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <h3 className="font-semibold text-slate-950">Incidents by status</h3>
            {incidentsQuery.isLoading ? (
              <p className="mt-3 text-sm text-slate-500">Loading…</p>
            ) : incidentStatusCounts.size === 0 ? (
              <p className="mt-3 text-sm text-slate-400">No incidents reported.</p>
            ) : (
              <div className="mt-2 divide-y divide-slate-100">
                {(["open", "under_review", "resolved"] as IncidentStatus[])
                  .filter((status) => incidentStatusCounts.has(status))
                  .map((status) => (
                    <BreakdownRow
                      key={status}
                      label={incidentStatusLabel[status]}
                      tone={incidentStatusTone[status]}
                      count={incidentStatusCounts.get(status) ?? 0}
                    />
                  ))}
              </div>
            )}
          </Card>
          <Card>
            <h3 className="font-semibold text-slate-950">Incidents by severity</h3>
            {incidentsQuery.isLoading ? (
              <p className="mt-3 text-sm text-slate-500">Loading…</p>
            ) : incidentSeverityCounts.size === 0 ? (
              <p className="mt-3 text-sm text-slate-400">No incidents reported.</p>
            ) : (
              <div className="mt-2 divide-y divide-slate-100">
                {(["low", "medium", "high"] as IncidentSeverity[])
                  .filter((severity) => incidentSeverityCounts.has(severity))
                  .map((severity) => (
                    <BreakdownRow
                      key={severity}
                      label={severity}
                      tone={incidentSeverityTone[severity]}
                      count={incidentSeverityCounts.get(severity) ?? 0}
                    />
                  ))}
              </div>
            )}
          </Card>
        </div>
      ) : null}

      {canSeeAudit ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Recent activity</h3>
          <p className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">
            {auditQuery.isLoading ? "—" : auditLast7Days}
          </p>
          <p className="mt-1 text-sm text-slate-600">Audit log entries in the last 7 days</p>
        </Card>
      ) : null}
    </section>
  );
}
