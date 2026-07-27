import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { Card, StatusBadge, type StatusTone } from "@carelik/ui";
import {
  applicantStatusSchema,
  getAuthorizationExpiryStatus,
  getAuthorizationUsageStatus,
  getCredentialStatus,
  membershipStatusSchema,
  type ApplicantStatus,
  type AuthorizationExpiryStatus,
  type AuthorizationUsageStatus,
  type CredentialStatus,
  type IncidentSeverity,
  type IncidentStatus,
  type MembershipStatus
} from "@carelik/shared";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";

// Owner-only rollup, surfaced in the sidebar as "Workforce Insights."
// Aggregate counts across every operational entity in one place.
// Distinct from the two dashboard-ish views that already exist on the
// Command Center - the Action Center (an itemized "what needs my
// attention right now" list) and the Operational Snapshot (a handful of
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

interface ApplicantRow {
  status: ApplicantStatus;
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

const applicantStatusTone: Record<ApplicantStatus, StatusTone> = {
  new: "info",
  reviewing: "warning",
  hired: "success",
  rejected: "danger",
  withdrawn: "neutral"
};

const applicantStatusLabel: Record<ApplicantStatus, string> = {
  new: "New",
  reviewing: "Reviewing",
  hired: "Hired",
  rejected: "Rejected",
  withdrawn: "Withdrawn"
};

function formatRole(role: string) {
  return role.replace(/_/g, " ");
}

// Hex values, not Tailwind classes - recharts renders raw SVG fill/stroke
// attributes, so it can't consume the semantic color utility classes
// packages/ui's StatusBadge/StatusChip use. These are the same swatches
// tailwind.config.ts's success/warning/danger/info scale points at
// (emerald/amber/red/sky-500), kept in sync manually since there's no
// build-time bridge from Tailwind tokens into a JS-consumable palette.
const CHART_COLORS = {
  success: "#10b981",
  warning: "#f59e0b",
  danger: "#ef4444",
  info: "#0ea5e9",
  neutral: "#94a3b8"
};

const ROLE_CHART_COLORS = ["#0ea5e9", "#10b981", "#f59e0b", "#94a3b8", "#8b5cf6", "#ef4444", "#14b8a6"];

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
  const canSeeApplicants = hasPermission("applicants.read");
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

  // Every other section here rolls up an entity that already existed
  // when this page was first built. Applicants (grown into a full
  // workflow across Builds 002-008) were never added - the gap this
  // build closes, found by reading this page rather than assuming.
  const applicantsQuery = useQuery({
    queryKey: ["owner-dashboard-applicants", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_applicants", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as ApplicantRow[];
    },
    enabled: !!activeOrganizationId && isOwner && canSeeApplicants
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
          <p className="text-sm font-medium text-slate-500">Workforce Insights</p>
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

  // Org-wide monthly capacity: same three numbers each authorization row
  // already shows on the Client detail page (used/scheduled/remaining),
  // summed across every authorization instead of shown per-client - the
  // rollup answers "how much of what we're authorized to bill are we
  // actually using this month," which is the "Revenue at Risk"/
  // "Remaining Capacity" question the owner asked for on this page.
  const totalAuthorizedHours = (authorizationsQuery.data ?? []).reduce((sum, a) => sum + a.max_monthly_hours, 0);
  const totalUsedHours = (authorizationsQuery.data ?? []).reduce((sum, a) => sum + a.hours_used_this_month, 0);
  const totalScheduledHours = (authorizationsQuery.data ?? []).reduce(
    (sum, a) => sum + a.hours_scheduled_this_month,
    0
  );
  const totalRemainingHours = Math.max(0, totalAuthorizedHours - totalUsedHours - totalScheduledHours);
  const capacityChartData = [
    {
      name: "This month",
      "Used": totalUsedHours,
      "Scheduled": totalScheduledHours,
      "Remaining": totalRemainingHours
    }
  ];

  const roleChartData = [...roleCounts.entries()].map(([roleKey, count]) => ({
    name: formatRole(roleKey),
    value: count
  }));

  const incidentStatusCounts = tally((incidentsQuery.data ?? []).map((i) => i.status));
  const incidentSeverityCounts = tally((incidentsQuery.data ?? []).map((i) => i.severity));

  const applicantStatusCounts = tally((applicantsQuery.data ?? []).map((a) => a.status));

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const auditLast7Days = (auditQuery.data ?? []).filter(
    (entry) => new Date(entry.occurred_at).getTime() >= sevenDaysAgo.getTime()
  ).length;

  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Workforce Insights</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-950">
          {activeOrganization?.displayName ?? "Operations rollup"}
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Organization-wide counts by status, for a strategic read on where things stand -
          not a task list (that's the Action Center on Command Center).
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
              <>
                <div className="mt-2 h-40" role="img" aria-label="Team composition by role">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={roleChartData} dataKey="value" nameKey="name" innerRadius={35} outerRadius={60}>
                        {roleChartData.map((entry, index) => (
                          <Cell key={entry.name} fill={ROLE_CHART_COLORS[index % ROLE_CHART_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-2 divide-y divide-slate-100">
                  {[...roleCounts.entries()].map(([roleKey, count]) => (
                    <BreakdownRow key={roleKey} label={formatRole(roleKey)} tone="neutral" count={count} />
                  ))}
                </div>
              </>
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
        <Card>
          <h3 className="font-semibold text-slate-950">Monthly capacity</h3>
          <p className="mt-1 text-xs text-slate-500">
            Authorized hours across every active authorization this month, split by how much is already used,
            scheduled, or still open - answers whether there&apos;s room to take on more hours or a real risk of
            going over.
          </p>
          {authorizationsQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : totalAuthorizedHours === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No authorizations tracked yet.</p>
          ) : (
            <div className="mt-3 h-24" role="img" aria-label="Monthly authorized hours: used, scheduled, and remaining">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={capacityChartData} layout="vertical" margin={{ left: 8, right: 24 }}>
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="name" hide />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="Used" stackId="hours" fill={CHART_COLORS.danger} />
                  <Bar dataKey="Scheduled" stackId="hours" fill={CHART_COLORS.warning} />
                  <Bar dataKey="Remaining" stackId="hours" fill={CHART_COLORS.success} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
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

      {canSeeApplicants ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Applicants by status</h3>
          {applicantsQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : applicantStatusCounts.size === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No applications yet.</p>
          ) : (
            <div className="mt-2 grid gap-x-6 sm:grid-cols-2">
              {applicantStatusSchema.options
                .filter((status) => applicantStatusCounts.has(status))
                .map((status) => (
                  <BreakdownRow
                    key={status}
                    label={applicantStatusLabel[status]}
                    tone={applicantStatusTone[status]}
                    count={applicantStatusCounts.get(status) ?? 0}
                  />
                ))}
            </div>
          )}
        </Card>
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
