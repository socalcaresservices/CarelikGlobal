import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";

/** 0067: a shift that ended with no visit record and still holds authorization time. */
export interface ShiftToReconcile {
  shiftId: string; reservationId: string; startsAt: string; endsAt: string; localDate: string; clientCode: string | null; serviceCode: string | null; serviceName: string | null;
  caregiverCode: string | null; clientName?: string; duplicateName?: boolean; caregiverName?: string; caregiverDuplicateName?: boolean; reservedMinutes: number; bucket: "unreconciled" | "awaiting_record"; endedHours: number;
  lastOutcome: "no_service_delivered" | "hold_service_may_have_occurred" | "delivered_unverified" | null; lastNote: string | null; lastDecidedAt: string | null;
}

/** The shifts that ended with no visit record, for the schedule's "Past: need review" count and list. Same query everywhere, so it is fetched once. */
export function useShiftsToReconcile() {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  return useQuery({
    queryKey: ["aws-reconcile", activeOrganizationId],
    queryFn: async () => (await api.get<{ shifts: ShiftToReconcile[] }>("/v1/shifts-to-reconcile", { organizationId: activeOrganizationId })).shifts,
    enabled: !!activeOrganizationId && hasPermission("shifts.manage"),
  });
}

