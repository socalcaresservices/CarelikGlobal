// Care Team and services administration (0023): shared types and queries.
// Every rule is enforced again by the server.
import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";

/** Stages in order (0054). "ready" is shown as "Approved"; only Approved and Active can be scheduled. */
export type CaregiverStatus = "applicant" | "interview" | "offer" | "onboarding" | "pending_documents" | "ready" | "active" | "inactive";
export const CAREGIVER_STAGES: readonly CaregiverStatus[] = ["applicant", "interview", "offer", "onboarding", "pending_documents", "ready", "active", "inactive"];
/** The stages before Approved: the recruiting pipeline. */
export const PIPELINE_STAGES = ["applicant", "interview", "offer", "onboarding", "pending_documents"] as const;

export interface Caregiver {
  caregiverRecordId: string;
  caregiverCode: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  status: CaregiverStatus;
  hasSignIn: boolean;
  signInStatus: string | null;
  activeAssignments: number;
  openVisits: number;
  /** Server flag: another caregiver in this agency has the same name. */
  duplicateName?: boolean;
  /** Invitation (0025); null when never invited through Ogevia. */
  invitationEmail?: string | null;
  invitedAt?: string | null;
  invitationLastSentAt?: string | null;
  invitationSendCount?: number | null;
  firstSignedInAt?: string | null;
  plannedAssignments?: number;
  /** 0030: separate facts. null hire type = not recorded (never guessed). */
  hireType?: "direct_hire" | "eor" | null;
  schedulingMode?: "fixed" | "flexible";
  /** 0054: needs the onboarding checklist, and how far along it is. */
  onboardingRequired?: boolean;
  onboardingDone?: number;
  onboardingTotal?: number;
  /** 0086: the calculated status and readiness, identical on every screen (ogevia.caregiver_work_status / caregiver_readiness). */
  workStatus: WorkStatus;
  readinessMet?: number;
  readinessTotal?: number;
  waitingOn?: string[];
  signedIn?: boolean;
  hasContact?: boolean;
}

/** Not ready -> Approved -> Active, plus Inactive. Calculated by the server; never chosen by hand. */
export type WorkStatus = "not_ready" | "approved" | "active" | "inactive";
export const WORK_STATUS_LABEL: Record<WorkStatus, string> = { not_ready: "Not ready", approved: "Approved", active: "Active", inactive: "Inactive" };
export const WORK_STATUS_BADGE: Record<WorkStatus, string> = {
  not_ready: "bg-amber-100 text-amber-900",
  approved: "bg-indigo-100 text-indigo-900",
  active: "bg-emerald-100 text-emerald-900",
  inactive: "bg-slate-200 text-slate-800",
};

export const CAREGIVER_STATUS_LABEL: Record<CaregiverStatus, string> = {
  applicant: "Applicant",
  interview: "Interview",
  offer: "Offer",
  onboarding: "Onboarding",
  pending_documents: "Pending documents",
  ready: "Approved",
  active: "Active",
  inactive: "Inactive",
};

export const CAREGIVER_STATUS_BADGE: Record<CaregiverStatus, string> = {
  applicant: "bg-slate-100 text-slate-800",
  interview: "bg-violet-100 text-violet-900",
  offer: "bg-fuchsia-100 text-fuchsia-900",
  onboarding: "bg-sky-100 text-sky-900",
  pending_documents: "bg-amber-100 text-amber-900",
  ready: "bg-indigo-100 text-indigo-900",
  active: "bg-emerald-100 text-emerald-900",
  inactive: "bg-slate-200 text-slate-800",
};

export const caregiverName = (c: Pick<Caregiver, "firstName" | "lastName" | "preferredName">) =>
  `${c.firstName} ${c.lastName}${c.preferredName ? ` ("${c.preferredName}")` : ""}`;

export function signInLabel(c: Pick<Caregiver, "hasSignIn" | "signInStatus"> & Partial<Pick<Caregiver, "invitedAt" | "firstSignedInAt">>): string {
  if (!c.hasSignIn) return "No sign-in yet";
  if (c.invitedAt && !c.firstSignedInAt && c.signInStatus === "active") return "Invited — has not signed in yet";
  if (c.signInStatus === "active") return "Sign-in active";
  if (c.signInStatus === "suspended") return "Sign-in suspended";
  return `Sign-in ${c.signInStatus ?? "not in this agency"}`;
}

export function useCaregivers() {
  const api = useAwsApi();
  const { activeOrganizationId, hasPermission } = useOrganization();
  return useQuery({
    queryKey: ["aws-caregivers", activeOrganizationId],
    queryFn: async () => (await api.get<{ caregivers: Caregiver[] }>("/v1/caregivers", { organizationId: activeOrganizationId })).caregivers,
    enabled: !!activeOrganizationId && hasPermission("visits.read"),
  });
}
