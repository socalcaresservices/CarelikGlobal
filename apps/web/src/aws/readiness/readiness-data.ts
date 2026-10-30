import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";
import type { WorkStatus } from "../care-team-admin";

/** One server-calculated requirement (0086 ogevia.caregiver_readiness). The browser never decides eligibility; it only shows this. */
export interface ReadinessItem {
  requirement: "background" | "training" | "signin" | "cpr" | "tb";
  label: string;
  kind: "hard" | "flexible";
  state: "met" | "unmet" | "pending" | "overdue" | "problem";
  detail: string | null;
  dueDate: string | null;
  metOn: string | null;
  actorName: string | null;
  blocksShifts: boolean;
  nextAction: "view" | "verify" | "record" | "reopen" | "add_contact" | "send_link" | "resend_link" | "upload" | "none";
  extra: { requirementId?: string; lastSentAt?: string | null; sendCount?: number | null };
}
export interface CaregiverReadinessState {
  caregiverRecordId: string;
  caregiverCode: string;
  status: WorkStatus;
  approved: boolean;
  approvedAt: string | null;
  approvedByName: string | null;
  approvalSource: "approval" | "legacy_status" | null;
  met: number;
  total: number;
  waitingOn: string[];
  canApprove: boolean;
  hireDate: string | null;
  graceDays: number;
  cprTbDueDate: string | null;
  enforcementActive: boolean;
  items: ReadinessItem[];
}

export function useCaregiverReadiness(caregiverRecordId: string, enabled = true) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  return useQuery({
    queryKey: ["caregiver-readiness", activeOrganizationId, caregiverRecordId],
    queryFn: async () =>
      (await api.get<{ readiness: CaregiverReadinessState }>(`/v1/caregivers/${encodeURIComponent(caregiverRecordId)}/readiness`, { organizationId: activeOrganizationId })).readiness,
    enabled: !!activeOrganizationId && enabled,
  });
}

