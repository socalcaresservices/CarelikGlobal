import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle, BadgeCheck, CalendarClock, ClipboardCheck, Clock, Mail, UserX } from "lucide-react";
import { cn } from "@carelik/ui";
import { getCredentialStatus, getUtilizationStatus, isAuthorizationActive } from "@carelik/shared";
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
  authorized_hours: number;
  scheduled_hours: number;
  period_start: string;
  period_end: string;
}

type Tone = "healthy" | "info" | "attention" | "critical";

const toneStyles: Record<Tone, { dot: string; text: string }> = {
  healthy: { dot: "bg-emerald-500", text: "text-emerald-700" },
  info: { dot: "bg-sky-500", text: "text-sky-700" },
  attention: { dot: "bg-amber-500", text: "text-amber-700" },
  critical: { dot: "bg-red-500", text: "text-red-700" }
};

interface Signal {
  key: string;
  label: string;
  count: number;
  tone: Tone;
  icon: typeof AlertTriangle;
  to: string;
  statusText: string;
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

export function ActionCenter() {
  const { activeOrganizationId, hasPermission } = useOrganization();

  const canSeeClients = hasPermission("clients.read");
  const canSeeAllShifts = hasPermission("shifts.read");
  const canSeeMembers = hasPermission("membership.read");
  const canSeeAuthorizations = hasPermission("authorizations.read");

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

  if (!activeOrganizationId) return null;

  const shifts = shiftsQuery.data ?? [];

  const overdueCount = shifts.filter(
    (shift) => shift.status === "scheduled" && new Date(shift.ends_at).getTime() < now.getTime()
  ).length;

  const todayStart = startOfDay(now).getTime();
  const todayEnd = endOfDay(now).getTime();
  const todayCount = shifts.filter((shift) => {
    const startsAt = new Date(shift.starts_at).getTime();
    return shift.status === "scheduled" && startsAt >= todayStart && startsAt <= todayEnd;
  }).length;

  const signals: Signal[] = [
    {
      key: "overdue",
      label: "Shifts needing a status update",
      count: overdueCount,
      tone: overdueCount > 0 ? "attention" : "healthy",
      icon: AlertTriangle,
      to: "/schedule",
      statusText: overdueCount > 0 ? "Review" : "All caught up"
    },
    {
      key: "today",
      label: "Shifts today",
      count: todayCount,
      tone: "info",
      icon: CalendarClock,
      to: "/schedule",
      statusText: "View schedule"
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
      tone: uncoveredClients > 0 ? "attention" : "healthy",
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
      tone: pendingCount > 0 ? "info" : "healthy",
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
      tone: overTargetCount > 0 ? "critical" : "healthy",
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
      tone: expiringOrExpiredCount > 0 ? "critical" : "healthy",
      icon: BadgeCheck,
      to: "/credentials",
      statusText: expiringOrExpiredCount > 0 ? "Review" : "All current"
    });
  }

  if (canSeeAuthorizations && authorizationsQuery.data) {
    const overAuthorizedCount = authorizationsQuery.data.filter(
      (row) =>
        isAuthorizationActive(row.period_start, row.period_end) &&
        getUtilizationStatus(row.authorized_hours, row.scheduled_hours) === "over"
    ).length;
    signals.push({
      key: "over-authorized",
      label: "Clients scheduled over their authorized hours",
      count: overAuthorizedCount,
      tone: overAuthorizedCount > 0 ? "critical" : "healthy",
      icon: ClipboardCheck,
      to: "/authorizations",
      statusText: overAuthorizedCount > 0 ? "Review" : "Everyone within authorization"
    });
  }

  return (
    <div>
      <p className="text-sm font-medium text-slate-500">What needs attention</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {signals.map((signal) => {
          const Icon = signal.icon;
          const tone = toneStyles[signal.tone];
          return (
            <Link
              key={signal.key}
              to={signal.to}
              className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300 hover:shadow-md"
            >
              <div className="flex items-center justify-between">
                <Icon className="h-5 w-5 text-slate-400" />
                <span className={cn("flex items-center gap-1.5 text-xs font-medium", tone.text)}>
                  <span className={cn("h-1.5 w-1.5 rounded-full", tone.dot)} />
                  {signal.statusText}
                </span>
              </div>
              <p className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">{signal.count}</p>
              <p className="mt-1 text-sm text-slate-600">{signal.label}</p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
