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
import { getWeekEnd, getWeekStart } from "@/lib/week";

// Formerly its own page at /owner-dashboard ("Workforce Insights"). Folded
// into Command Center as the strategic-rollup section beneath the Action
// Center's itemized "what needs attention" list and the Operational
// Snapshot's one-line strip - the three together were spread across two
// separate pages an owner had to navigate between to get a full picture,
// which is exactly the "scattered" gap this closes. Same gate as before
// (organization_owner/platform_owner only, checked by role rather than a
// permission - every other org-level role has an identical permission
// set), same source RPCs, same derive-at-read-time status functions - no
// new number that isn't already computed identically somewhere else in
// the app, with one addition: the "Coverage this week" chart, built from
// list_shifts() data the Action Center already fetches elsewhere in the
// app but never charted, closing the "coverage risk" gap in the audit
// that led here (money/coverage/compliance/growth all in one home view).
//
// Money is still not a real, dollar-denominated metric anywhere in this
// app - no invoice/claim/billed-vs-paid table exists yet (that's Biller-
// phase work). "Monthly capacity" is deliberately labeled as an hours
// proxy, not revenue, rather than presenting an invented dollar figure.

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

interface ShiftRow {
  status: "scheduled" | "completed" | "cancelled" | "no_show";
  needs_coverage: boolean;
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

const shiftStatusLabel: Record<ShiftRow["status"], string> = {
  scheduled: "Scheduled",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show"
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

export function OwnerInsights() {
  const { activeOrganizationId, role, hasPermission } = useOrganization();

  const isOwner = role === "organization_owner" || role === "platform_owner";

  const canSeeMembers = hasPermission("membership.read");
  const canSeeCredentials = hasPermission("credentials.read");
  const canSeeAuthorizations = hasPermission("authorizations.read");
  const canSeeIncidents = hasPermission("incidents.read");
  const canSeeApplicants = hasPermission("applicants.read");
  const canSeeAudit = hasPermission("audit.read");
  const canSeeShifts = hasPermission("shifts.read");

  const membersQuery = useQuery({
    queryKey: ["owner-insights-members", activeOrganizationId],
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
    queryKey: ["owner-insights-credentials", activeOrganizationId],
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
    queryKey: ["owner-insights-authorizations", activeOrganizationId],
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
    queryKey: ["owner-insights-incidents", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_incidents", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as IncidentRow[];
    },
    enabled: !!activeOrganizationId && isOwner && canSeeIncidents
  });

  const applicantsQuery = useQuery({
    queryKey: ["owner-insights-applicants", activeOrganizationId],
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
    queryKey: ["owner-insights-audit", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_audit_logs", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as AuditRow[];
    },
    enabled: !!activeOrganizationId && isOwner && canSeeAudit
  });

  const weekStart = getWeekStart(new Date());
  const weekEnd = getWeekEnd(weekStart);

  const shiftsQuery = useQuery({
    queryKey: ["owner-insights-shifts", activeOrganizationId, weekStart.toISOString()],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_shifts", {
        target_organization_id: activeOrganizationId!,
        from_time: weekStart.toISOString(),
        to_time: weekEnd.toISOString()
      });
      if (error) throw error;
      return (data ?? []) as ShiftRow[];
    },
    enabled: !!activeOrganizationId && isOwner && canSeeShifts
  });

  if (!isOwner) return null;

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
  // summed across every authorization instead of shown per-client - an
  // hours-based proxy for "how much of what we're authorized to bill are
  // we actually using," not a dollar figure (no billing data exists yet
  // to compute real revenue from).
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

  const shifts = shiftsQuery.data ?? [];
  const shiftStatusCounts = tally(shifts.map((s) => s.status));
  const needsCoverageCount = shifts.filter((s) => s.status === "scheduled" && s.needs_coverage).length;
  const coverageChartData = (["scheduled", "completed", "cancelled", "no_show"] as ShiftRow["status"][])
    .filter((status) => shiftStatusCounts.has(status))
    .map((status) => ({ name: shiftStatusLabel[status], count: shiftStatusCounts.get(status) ?? 0, status }));

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Owner insights</p>
        <p className="mt-1 text-sm text-slate-500">
          Money, coverage, compliance, and growth - a strategic read on where things stand, not a task list
          (that's the Action Center above).
        </p>
      </div>

      {canSeeShifts ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Coverage this week</h3>
          <p className="mt-1 text-xs text-slate-500">
            {weekStart.toLocaleDateString()} – {new Date(weekEnd.getTime() - 1).toLocaleDateString()} · every shift
            by outcome, plus how many scheduled shifts currently have no caregiver assigned.
          </p>
          {shiftsQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : shiftsQuery.isError ? (
            <p className="mt-3 text-sm text-red-700">Could not load this week's shifts.</p>
          ) : shifts.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No shifts scheduled this week.</p>
          ) : (
            <>
              {needsCoverageCount > 0 ? (
                <p className="mt-3 text-sm font-medium text-red-700">
                  {needsCoverageCount} shift{needsCoverageCount === 1 ? "" : "s"} need{needsCoverageCount === 1 ? "s" : ""}{" "}
                  coverage right now.
                </p>
              ) : (
                <p className="mt-3 text-sm font-medium text-emerald-700">Every shift this week has a caregiver.</p>
              )}
              <div className="mt-3 h-40" role="img" aria-label="Shifts this week by outcome">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={coverageChartData}>
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                      {coverageChartData.map((entry) => (
                        <Cell
                          key={entry.status}
                          fill={
                            entry.status === "scheduled"
                              ? CHART_COLORS.info
                              : entry.status === "completed"
                                ? CHART_COLORS.success
                                : entry.status === "no_show"
                                  ? CHART_COLORS.danger
                                  : CHART_COLORS.neutral
                          }
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </Card>
      ) : null}

      {canSeeAuthorizations ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Monthly capacity</h3>
          <p className="mt-1 text-xs text-slate-500">
            Authorized hours across every active authorization this month, split by how much is already used,
            scheduled, or still open - an hours-based proxy for revenue at risk, not a dollar figure (no billing
            data exists yet to compute real revenue from).
          </p>
          {authorizationsQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : authorizationsQuery.isError ? (
            <p className="mt-3 text-sm text-red-700">Could not load authorizations.</p>
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
            ) : authorizationsQuery.isError ? (
              <p className="mt-3 text-sm text-red-700">Could not load authorizations.</p>
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
            ) : authorizationsQuery.isError ? (
              <p className="mt-3 text-sm text-red-700">Could not load authorizations.</p>
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

      {canSeeCredentials ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Credential compliance</h3>
          {credentialsQuery.isLoading ? (
            <p className="mt-3 text-sm text-slate-500">Loading…</p>
          ) : credentialsQuery.isError ? (
            <p className="mt-3 text-sm text-red-700">Could not load credentials.</p>
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

      {canSeeIncidents ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <h3 className="font-semibold text-slate-950">Incidents by status</h3>
            {incidentsQuery.isLoading ? (
              <p className="mt-3 text-sm text-slate-500">Loading…</p>
            ) : incidentsQuery.isError ? (
              <p className="mt-3 text-sm text-red-700">Could not load incidents.</p>
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
            ) : incidentsQuery.isError ? (
              <p className="mt-3 text-sm text-red-700">Could not load incidents.</p>
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
          ) : applicantsQuery.isError ? (
            <p className="mt-3 text-sm text-red-700">Could not load applicants.</p>
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

      {canSeeMembers ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <h3 className="font-semibold text-slate-950">Team by role</h3>
            {membersQuery.isLoading ? (
              <p className="mt-3 text-sm text-slate-500">Loading…</p>
            ) : membersQuery.isError ? (
              <p className="mt-3 text-sm text-red-700">Could not load team members.</p>
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
            ) : membersQuery.isError ? (
              <p className="mt-3 text-sm text-red-700">Could not load team members.</p>
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

      {canSeeAudit ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Recent activity</h3>
          {auditQuery.isError ? (
            <p className="mt-3 text-sm text-red-700">Could not load recent activity.</p>
          ) : (
            <>
              <p className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">
                {auditQuery.isLoading ? "—" : auditLast7Days}
              </p>
              <p className="mt-1 text-sm text-slate-600">Audit log entries in the last 7 days</p>
            </>
          )}
        </Card>
      ) : null}
    </div>
  );
}
