import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";
import { ApiRequestError } from "@/lib/aws-api";
import type { WorkStatus } from "../care-team-admin";

/** One server-calculated requirement (0086 ogevia.caregiver_readiness). The browser never decides eligibility; it only shows this. */
export interface ReadinessItem {
  requirement: "background" | "training" | "signin" | "cpr" | "tb";
  label: string;
  kind: "hard" | "flexible" | "followup";
  state: "met" | "unmet" | "pending" | "overdue" | "problem";
  detail: string | null;
  dueDate: string | null;
  metOn: string | null;
  actorName: string | null;
  blocksShifts: boolean;
  nextAction: "view" | "verify" | "record" | "reopen" | "add_contact" | "send_link" | "resend_link" | "upload" | "none";
  extra: { requirementId?: string; lastSentAt?: string | null; sendCount?: number | null; override?: boolean };
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


/** A caregiver approved by an administrator before the first sign-in (0089). The approver and reason arrive only for someone who manages the Care Team. */
export interface SigninOverride { caregiverRecordId: string; approvedAt: string; approvedByName: string | null; reason: string | null }

/**
 * Who carries the badge "Approved by override — not signed in". The feature is released per environment: where the route (or the permission to see it) does not exist the answer is
 * simply "nobody", never an error on the page. A real failure is still an error for the caller to show.
 */
export function useSigninOverrides(enabled = true) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  return useQuery({
    queryKey: ["signin-overrides", activeOrganizationId],
    queryFn: async (): Promise<SigninOverride[]> => {
      try {
        return (await api.get<{ overrides: SigninOverride[] }>("/v1/signin-overrides", { organizationId: activeOrganizationId })).overrides;
      } catch (cause) {
        if (cause instanceof ApiRequestError && (cause.status === 404 || cause.status === 403)) return [];
        throw cause;
      }
    },
    enabled: !!activeOrganizationId && enabled,
    retry: false,
    staleTime: 30_000,
  });
}

export const OVERRIDE_BADGE_TEXT = "Approved by override — not signed in";
