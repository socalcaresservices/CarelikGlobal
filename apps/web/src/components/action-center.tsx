import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  AlertOctagon,
  AlertTriangle,
  BadgeCheck,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  FileSignature,
  FolderClock,
  Mail,
  UserPlus,
  UserX
} from "lucide-react";
import { AlertCard, type StatusTone } from "@carelik/ui";
import {
  getAuthorizationExpiryStatus,
  getAuthorizationUsageStatus,
  getCredentialStatus,
  isAuthorizationActive
} from "@carelik/shared";
import type { IncidentStatus } from "@carelik/shared";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { getWeekEnd, getWeekStart } from "@/lib/week";
import type { CaregiverHoursRow } from "@/components/caregiver-hours";

// The Action Center: "what needs my attention" comes before anything
// else on the dashboard, per docs/design-system.md. Every signal here
// is computed from data that actually exists - nothing is a placeholder
// number. See that doc's "Not yet built" section for signals (expiring
// credentials, expiring authorizations, incidents, hour targets) that
// intentionally aren't here yet, because there's no table backing them.
//
// This only holds *issues* - things with a healthy/attention/critical
// reading. Purely informational counts (e.g. "shifts today") live in
// <OperationalSnapshot /> instead, so a zero-issue day can genuinely
// collapse to one line instead of a grid of green tiles.

interface ShiftForSignals {
  id: string;
  client_id: string;
  starts_at: string;
  ends_at: string;
  status: "scheduled" | "completed" | "cancelled" | "no_show";
}

interface ClientForSignals {
  id: string;
}

interface CredentialForSignals {
  id: string;
  expires_at: string | null;
}

interface AuthorizationForSignals {
  id: string;
  max_monthly_hours: number;
  hours_used_this_month: number;
  hours_scheduled_this_month: number;
  period_start: string;
  period_end: string;
}

interface IncidentForSignals {
  id: string;
  status: IncidentStatus;
}

interface VisitForSignals {
  id: string;
  status: "draft" | "awaiting_signature" | "signed" | "administrator_review" | "corrected" | "voided";
}

interface CandidateForSignals {
  id: string;
  pipeline_stage: string;
}

interface DocumentRequestForSignals {
  id: string;
}

// Same terminal-stage set candidate-detail-page.tsx uses to decide
// whether a candidate's pipeline is done - a candidate not yet in one
// of these needs someone to move them forward.
const TERMINAL_CANDIDATE_STAGES = ["care_team", "rejected", "withdrawn"];

// Reuses @carelik/ui's shared StatusTone (healthy -> success, attention
// -> warning, critical -> danger) instead of a parallel local tone type,
// so this dashboard's tones and every StatusBadge/StatusChip/ProgressBar
// tone in the app come from the same five-tone enum (BUILD 001.5).
// Lower rank = shown first. Healthy (success) signals never render as
// cards, so they don't need a rank.
const toneRank: Record<StatusTone, number> = { danger: 0, warning: 1, success: 2, info: 3, neutral: 4 };

interface Signal {
  key: string;
  label: string;
  count: number;
  tone: StatusTone;
  icon: typeof AlertTriangle;
  to: string;
  statusText: string;
}

export function ActionCenter() {
  const { activeOrganizationId, hasPermission } = useOrganization();

  const canSeeClients = hasPermission("clients.read");
  const canSeeAllShifts = hasPermission("shifts.read");
  const canSeeMembers = hasPermission("membership.read");
  const canSeeAuthorizations = hasPermission("authorizations.read");
  const canSeeVisits = hasPermission("visits.read");
  const canSeeCandidates = hasPermission("applicants.read");
  const canSeeDocuments = hasPermission("documents.read");

  const now = new Date();
  const windowStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const shiftsQuery = useQuery({
    queryKey: ["action-center-shifts", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_shifts", {
        target_organization_id: activeOrganizationId!,
        from_time: windowStart.toISOString(),
        to_time: windowEnd.toISOString()
      });
      if (error) throw error;
      return (data ?? []) as ShiftForSignals[];
    },
    enabled: !!activeOrganizationId
  });

  const clientsQuery = useQuery({
    queryKey: ["action-center-clients", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("clients")
        .select("id")
        .eq("organization_id", activeOrganizationId!)
        .eq("status", "active");
      if (error) throw error;
      return (data ?? []) as ClientForSignals[];
    },
    enabled: !!activeOrganizationId && canSeeClients && canSeeAllShifts
  });

  const membersQuery = useQuery({
    queryKey: ["action-center-members", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_organization_members", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as Array<{ status: string }>;
    },
    enabled: !!activeOrganizationId && canSeeMembers
  });

  const weekStart = getWeekStart(now);
  const weekEnd = getWeekEnd(weekStart);

  const caregiverHoursQuery = useQuery({
    queryKey: ["action-center-caregiver-hours", activeOrganizationId, weekStart.toISOString()],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_caregiver_hours", {
        target_organization_id: activeOrganizationId!,
        week_start: weekStart.toISOString(),
        week_end: weekEnd.toISOString()
      });
      if (error) throw error;
      return (data ?? []) as CaregiverHoursRow[];
    },
    enabled: !!activeOrganizationId
  });

  const credentialsQuery = useQuery({
    queryKey: ["action-center-credentials", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_caregiver_credentials", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as CredentialForSignals[];
    },
    enabled: !!activeOrganizationId
  });

  const authorizationsQuery = useQuery({
    queryKey: ["action-center-authorizations", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_client_authorizations", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as AuthorizationForSignals[];
    },
    enabled: !!activeOrganizationId && canSeeAuthorizations
  });

  const incidentsQuery = useQuery({
    queryKey: ["action-center-incidents", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_incidents", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as IncidentForSignals[];
    },
    enabled: !!activeOrganizationId
  });

  const unsignedVisitsQuery = useQuery({
    queryKey: ["action-center-unsigned-visits", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_service_visits", {
        target_organization_id: activeOrganizationId!,
        filter_status: "awaiting_signature"
      });
      if (error) throw error;
      return (data ?? []) as VisitForSignals[];
    },
    enabled: !!activeOrganizationId && canSeeVisits
  });

  const candidatesQuery = useQuery({
    queryKey: ["action-center-candidates", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_candidates_v1", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as CandidateForSignals[];
    },
    enabled: !!activeOrganizationId && canSeeCandidates
  });

  const documentRequestsQuery = useQuery({
    queryKey: ["action-center-document-requests", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_document_requests_awaiting_review", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as DocumentRequestForSignals[];
    },
    enabled: !!activeOrganizationId && canSeeDocuments
  });

  if (!activeOrganizationId) return null;

  // Every signal below is gated on `if (...Query.data)`, so a failed
  // fetch just silently drops that signal from the list rather than
  // throwing - without this check, enough failures could leave
  // `needsAttention` empty and render the reassuring "All caught up"
  // banner even though the page couldn't actually confirm that. Only
  // queries this render is actually using (permission-gated ones only
  // count when the permission is held) count toward this.
  const hasError =
    shiftsQuery.isError ||
    (canSeeClients && canSeeAllShifts && clientsQuery.isError) ||
    (canSeeMembers && membersQuery.isError) ||
    caregiverHoursQuery.isError ||
    credentialsQuery.isError ||
    (canSeeAuthorizations && authorizationsQuery.isError) ||
    incidentsQuery.isError ||
    (canSeeVisits && unsignedVisitsQuery.isError) ||
    (canSeeCandidates && candidatesQuery.isError) ||
    (canSeeDocuments && documentRequestsQuery.isError);

  const shifts = shiftsQuery.data ?? [];

  const overdueCount = shifts.filter(
    (shift) => shift.status === "scheduled" && new Date(shift.ends_at).getTime() < now.getTime()
  ).length;

  const signals: Signal[] = [
    {
      key: "overdue",
      label: "Shifts needing a status update",
      count: overdueCount,
      tone: overdueCount > 0 ? "warning" : "success",
      icon: AlertTriangle,
      to: "/schedule",
      statusText: overdueCount > 0 ? "Review" : "All caught up"
    }
  ];

  if (canSeeClients && canSeeAllShifts && clientsQuery.data) {
    // "Has an upcoming shift" reuses the same shifts window fetched
    // above rather than a second query - a client with nothing in the
    // next 7 days shows up here even if they have something scheduled
    // further out, which is an intentional, honest limitation of the
    // 7-day window rather than a bug.
    const clientIdsWithUpcomingShift = new Set(
      shifts
        .filter((shift) => shift.status === "scheduled" && new Date(shift.starts_at).getTime() >= now.getTime())
        .map((shift) => shift.client_id)
    );
    const uncoveredClients = clientsQuery.data.filter(
      (client) => !clientIdsWithUpcomingShift.has(client.id)
    ).length;

    signals.push({
      key: "uncovered-clients",
      label: "Active clients with no upcoming visit",
      count: uncoveredClients,
      tone: uncoveredClients > 0 ? "warning" : "success",
      icon: UserX,
      to: "/clients",
      statusText: uncoveredClients > 0 ? "Review" : "Everyone covered"
    });
  }

  if (canSeeMembers && membersQuery.data) {
    const pendingCount = membersQuery.data.filter((member) => member.status === "invited").length;
    signals.push({
      key: "pending-invites",
      label: "Pending invitations",
      count: pendingCount,
      tone: pendingCount > 0 ? "warning" : "success",
      icon: Mail,
      to: "/access",
      statusText: pendingCount > 0 ? "Review" : "None pending"
    });
  }

  if (caregiverHoursQuery.data) {
    const overTargetCount = caregiverHoursQuery.data.filter(
      (row) => row.target_hours_per_week !== null && row.scheduled_hours > row.target_hours_per_week
    ).length;
    signals.push({
      key: "over-target",
      label: "Caregivers over their weekly hour target",
      count: overTargetCount,
      tone: overTargetCount > 0 ? "danger" : "success",
      icon: Clock,
      to: "/schedule",
      statusText: overTargetCount > 0 ? "Review" : "Everyone on track"
    });
  }

  if (credentialsQuery.data) {
    const expiringOrExpiredCount = credentialsQuery.data.filter((row) => {
      const status = getCredentialStatus(row.expires_at);
      return status === "expiring_soon" || status === "expired";
    }).length;
    signals.push({
      key: "credentials-expiring",
      label: "Credentials expiring or expired",
      count: expiringOrExpiredCount,
      tone: expiringOrExpiredCount > 0 ? "danger" : "success",
      icon: BadgeCheck,
      to: "/credentials",
      statusText: expiringOrExpiredCount > 0 ? "Review" : "All current"
    });
  }

  if (canSeeAuthorizations && authorizationsQuery.data) {
    const overAuthorizedCount = authorizationsQuery.data.filter(
      (row) =>
        isAuthorizationActive(row.period_start, row.period_end) &&
        getAuthorizationUsageStatus(row.max_monthly_hours, row.hours_used_this_month, row.hours_scheduled_this_month) ===
          "over_limit"
    ).length;
    signals.push({
      key: "over-authorized",
      label: "Clients over their monthly authorized hours",
      count: overAuthorizedCount,
      tone: overAuthorizedCount > 0 ? "danger" : "success",
      icon: ClipboardCheck,
      to: "/authorizations",
      statusText: overAuthorizedCount > 0 ? "Review" : "Everyone within authorization"
    });

    // Same shape as the credentials-expiring signal above - a distinct
    // concern from "over-authorized" (usage against the monthly hours
    // cap): a client can be well within their hours cap and still have
    // an authorization period ending soon or already lapsed, which needs
    // a renewal, not a scheduling fix. Reuses the authorizations already
    // fetched for the signal above - no second query. Same "no windowing
    // beyond deleted_at" precedent as credentials-expiring: an agency
    // that lets a lapsed authorization sit un-deleted will keep seeing
    // it here, matching how the Authorizations page and Client detail
    // page already show it, rather than inventing a new trailing-window
    // rule this signal alone would follow.
    const expiringOrExpiredAuthorizationCount = authorizationsQuery.data.filter((row) => {
      const status = getAuthorizationExpiryStatus(row.period_end);
      return status === "expiring_soon" || status === "expired";
    }).length;
    signals.push({
      key: "authorizations-expiring",
      label: "Authorizations expiring or expired",
      count: expiringOrExpiredAuthorizationCount,
      tone: expiringOrExpiredAuthorizationCount > 0 ? "danger" : "success",
      icon: CalendarClock,
      to: "/authorizations",
      statusText: expiringOrExpiredAuthorizationCount > 0 ? "Review" : "All current"
    });
  }

  if (incidentsQuery.data) {
    const awaitingReviewCount = incidentsQuery.data.filter((row) => row.status !== "resolved").length;
    signals.push({
      key: "incidents-awaiting-review",
      label: "Incidents awaiting review",
      count: awaitingReviewCount,
      tone: awaitingReviewCount > 0 ? "danger" : "success",
      icon: AlertOctagon,
      to: "/incidents",
      statusText: awaitingReviewCount > 0 ? "Review" : "Nothing open"
    });
  }

  if (canSeeVisits && unsignedVisitsQuery.data) {
    const unsignedCount = unsignedVisitsQuery.data.length;
    signals.push({
      key: "unsigned-visits",
      label: "Visits awaiting signature",
      count: unsignedCount,
      tone: unsignedCount > 0 ? "warning" : "success",
      icon: FileSignature,
      to: "/service-verification",
      statusText: unsignedCount > 0 ? "Review" : "All signed"
    });
  }

  if (canSeeCandidates && candidatesQuery.data) {
    const awaitingActionCount = candidatesQuery.data.filter(
      (candidate) => !TERMINAL_CANDIDATE_STAGES.includes(candidate.pipeline_stage)
    ).length;
    signals.push({
      key: "candidates-awaiting-action",
      label: "Candidates awaiting action",
      count: awaitingActionCount,
      tone: awaitingActionCount > 0 ? "info" : "success",
      icon: UserPlus,
      to: "/candidates",
      statusText: awaitingActionCount > 0 ? "Review" : "All caught up"
    });
  }

  if (canSeeDocuments && documentRequestsQuery.data) {
    const awaitingReviewCount = documentRequestsQuery.data.length;
    signals.push({
      key: "document-requests-awaiting-review",
      label: "Document requests awaiting review",
      count: awaitingReviewCount,
      tone: awaitingReviewCount > 0 ? "warning" : "success",
      icon: FolderClock,
      to: "/candidates",
      statusText: awaitingReviewCount > 0 ? "Review" : "Nothing pending"
    });
  }

  const needsAttention = signals
    .filter((signal) => signal.tone !== "success")
    .sort((a, b) => toneRank[a.tone] - toneRank[b.tone]);
  const healthyCount = signals.length - needsAttention.length;

  return (
    <div>
      <p className="text-sm font-medium text-slate-500">Needs attention</p>
      {hasError ? (
        <div className="mt-3 flex items-center gap-3 rounded-2xl border border-red-100 bg-red-50/60 px-5 py-4">
          <AlertOctagon className="h-5 w-5 shrink-0 text-red-600" />
          <p className="text-sm font-medium text-red-800">
            Could not load all signals — this list may be incomplete.
          </p>
        </div>
      ) : null}
      {needsAttention.length === 0 ? (
        hasError ? null : (
          <div className="mt-3 flex items-center gap-3 rounded-2xl border border-emerald-100 bg-emerald-50/60 px-5 py-4">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
            <p className="text-sm font-medium text-emerald-800">
              All caught up — every tracked signal is within normal range.
            </p>
          </div>
        )
      ) : (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {needsAttention.map((signal) => {
              const Icon = signal.icon;
              return (
                <Link key={signal.key} to={signal.to} className="block">
                  <AlertCard
                    icon={<Icon className="h-5 w-5" />}
                    value={signal.count}
                    label={signal.label}
                    statusText={signal.statusText}
                    tone={signal.tone}
                    linkable
                  />
                </Link>
              );
            })}
          </div>
          {healthyCount > 0 ? (
            <p className="mt-3 text-xs text-slate-400">
              {healthyCount} other {healthyCount === 1 ? "check is" : "checks are"} within normal range.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
