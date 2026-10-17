// Caregiver compliance (migration 0053). OWNER-DEFINED rules, not verified legal requirements. The database decides everything;
// these hooks only fetch and refresh. Kept out of the component files so hot reload keeps working.
import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";

export interface ComplianceReason {
  requirement: "background" | "cpr" | "tb";
  code: string;
  message: string;
  dueDate: string | null;
}

export interface ComplianceRequirement {
  requirement: "cpr" | "tb";
  documentStatus: string;
  validUntil: string | null;
  documentId: string | null;
  blocking: boolean;
  pending: boolean;
  current: boolean;
  code: string | null;
  message: string | null;
  dueDate: string | null;
}

export interface CaregiverComplianceState {
  caregiverRecordId: string;
  caregiverStatus: string;
  enforcementActive: boolean;
  timezone: string | null;
  graceDays: number;
  hireDate: string | null;
  dueDate: string | null;
  graceEndsAt: string | null;
  inGrace: boolean;
  deadlineRule: string;
  background: {
    state: string;
    qualifies: boolean;
    status: string;
    result: "approved" | "not_approved" | null;
    evidenceNote: string | null;
    verifiedAt: string | null;
    verifiedByName: string | null;
  };
  requirements: ComplianceRequirement[];
  hold: { id: string; openedAt: string; automatic: boolean; reasons: ComplianceReason[]; graceClosed: boolean } | null;
  eligible: boolean;
  hireDateRequired: boolean;
}

export interface HoldShift { flagId: string; shiftId: string; startsAt: string; endsAt: string; clientCode: string | null; seriesId: string | null }
export interface HoldAssignment { flagId: string; assignmentId: string; clientCode: string | null; effectiveStart: string; effectiveEnd: string | null }
export interface HoldVisit { visitId: string; timeIn: string; clientCode: string | null; shiftId: string | null }
export interface ComplianceHold {
  holdId: string;
  caregiverRecordId: string;
  caregiverCode: string;
  caregiverName: string;
  openedAt: string;
  automatic: boolean;
  reasons: ComplianceReason[];
  affectedShifts: HoldShift[];
  affectedAssignments: HoldAssignment[];
  inProgressVisits: HoldVisit[];
}
export interface ComplianceHolds {
  holds: ComplianceHold[];
  totals: { holds: number; affectedShifts: number; affectedAssignments: number; inProgressVisits: number };
}

export const COMPLIANCE_KEYS = ["caregiver-compliance", "compliance-holds", "aws-attention", "readiness", "document-readiness"] as const;

export function useCaregiverCompliance(caregiverRecordId: string, enabled = true) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  return useQuery({
    queryKey: ["caregiver-compliance", activeOrganizationId, caregiverRecordId],
    queryFn: async () =>
      (await api.get<{ compliance: CaregiverComplianceState }>(`/v1/caregivers/${encodeURIComponent(caregiverRecordId)}/compliance`, { organizationId: activeOrganizationId })).compliance,
    enabled: !!activeOrganizationId && enabled,
  });
}

export function useComplianceHolds() {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  return useQuery({
    queryKey: ["compliance-holds", activeOrganizationId],
    queryFn: async () => await api.get<ComplianceHolds>("/v1/compliance/holds", { organizationId: activeOrganizationId }),
    enabled: !!activeOrganizationId && hasPermission("readiness.read"),
    refetchInterval: 5 * 60_000,
  });
}

/** The calendar day after a YYYY-MM-DD date, read from the string (never through a time zone). */
export function nextDay(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export const BACKGROUND_STATUS_LABEL: Record<string, string> = {
  not_started: "Not started",
  requested: "Requested",
  submitted: "Submitted",
  pending: "Pending",
  completed: "Completed",
  needs_attention: "Needs attention",
};

/** Where to fix a requirement. CPR and TB are documents; the background check and the hire date are on the caregiver's own profile. */
export function fixLink(reason: Pick<ComplianceReason, "requirement" | "code">, caregiverRecordId: string): { to: string; label: string } {
  if (reason.requirement === "background") return { to: `/care-team/${caregiverRecordId}#background-check`, label: "Open the background check" };
  if (reason.code.endsWith("_no_hire_date")) return { to: `/care-team/${caregiverRecordId}#hire-date`, label: "Enter the hire date" };
  return { to: "/documents", label: `Open ${reason.requirement.toUpperCase()} documents` };
}
