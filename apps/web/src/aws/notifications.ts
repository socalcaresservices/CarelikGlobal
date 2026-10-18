import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { REASON_LABEL } from "./attention";

// In-app notifications (0077): Critical always, Urgent per agency setting, never Routine. The server brings the list up to date with the caller's own view each time it is read.
export interface AppNotification {
  id: string; issueKey: string; severity: "critical" | "urgent"; kind: string; reason: string; queue: string; clientCode: string | null;
  createdAt: string; readAt: string | null; resolvedAt: string | null; state: "unread" | "read" | "resolved";
}
export interface NotificationList { asOf: string; unread: number; items: AppNotification[] }
export interface NotificationSettings { urgentInApp: boolean; criticalInApp: boolean; routine: string; outboundChannels: string }

export const NOTIFICATION_REFRESH_MS = 60_000;

export function useNotifications() {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const allowed = hasPermission("visits.read") || hasPermission("shifts.manage") || hasPermission("documents.read") || hasPermission("readiness.read");
  return useQuery({
    queryKey: ["notifications", activeOrganizationId],
    enabled: !!activeOrganizationId && allowed,
    refetchInterval: NOTIFICATION_REFRESH_MS,
    queryFn: async () => (await api.get<{ notifications: NotificationList }>("/v1/notifications", { organizationId: activeOrganizationId, includeRead: "true", limit: "20" })).notifications,
  });
}

const MORE_LABELS: Record<string, string> = {
  confirmation_overdue: "Client confirmation is overdue", needs_review: "A visit needs review", late_response: "A late response needs review",
  expired: "A document has expired", overdue: "A document is overdue", review_overdue: "A document upload is waiting too long for review", awaiting_review: "A document is waiting for review",
  rejected: "A document was rejected",
};
/** Plain words for a notification's reason; an unknown reason is shown as a sentence rather than a code. */
export function notificationLabel(reason: string): string {
  const text = REASON_LABEL[reason] ?? MORE_LABELS[reason] ?? reason.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
