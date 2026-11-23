// Types and the shell's badge query for the notification centre (0113). Kept apart from the page so the page file only exports components.
import { useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { AwsApiContext } from "./aws-workspace";

export interface CenterItem { id: string; category: "cover_shift"; title: string; body: string; link: string | null; shiftId: string | null; createdAt: string; readAt: string | null; archivedAt: string | null; state: "unread" | "read" | "archived" }
export interface CenterList { asOf: string; unread: number; items: CenterItem[] }
export type CenterState = "inbox" | "unread" | "archived" | "all";
export interface Prefs { coverShift: { inApp: boolean; email: boolean }; emailAvailable: boolean }
export interface CoverSettings { enabled: boolean; emailEnabled: boolean; autoNotify: boolean; windowHours: number; maxRecipients: number; audience: "office" | "agency"; subjectTemplate: string }
export interface HistoryRow { notificationId: string; shiftId: string | null; caregiverCode: string | null; createdAt: string; inApp: boolean; readAt: string | null; emailStatus: string | null; emailAttempts: number | null; emailError: string | null; emailSentAt: string | null }

export const CENTER_REFRESH_MS = 60_000;

/** The shell's view of the centre: is the switch on (the list loaded), and how many are unread. Quiet (no error banner) where it is off. */
export function useNotificationCenter(enabled = true) {
  const api = useContext(AwsApiContext);
  const { activeOrganizationId } = useOrganization();
  const q = useQuery({
    queryKey: ["notification-center", activeOrganizationId, "badge"],
    queryFn: async () => (await api!.get<{ notifications: CenterList }>("/v1/notification-center", { organizationId: activeOrganizationId, state: "unread", limit: "1" })).notifications,
    enabled: enabled && !!api && !!activeOrganizationId,
    retry: false,
    refetchInterval: CENTER_REFRESH_MS,
  });
  return { available: q.isSuccess, unread: q.data?.unread ?? 0 };
}

