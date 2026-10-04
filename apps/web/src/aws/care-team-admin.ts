// Care Team and services administration (0023): shared types and queries.
// Every rule is enforced again by the server.
import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";

export type CaregiverStatus = "onboarding" | "ready" | "active" | "inactive";

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
  /** Invitation (0025); null when never invited through Ogevia. */
  invitationEmail?: string | null;
  invitedAt?: string | null;
  invitationLastSentAt?: string | null;
  invitationSendCount?: number | null;
  firstSignedInAt?: string | null;
  plannedAssignments?: number;
}

export const CAREGIVER_STATUS_LABEL: Record<CaregiverStatus, string> = {
  onboarding: "Onboarding",
  ready: "Ready to work",
  active: "Active",
  inactive: "Inactive",
};

export const CAREGIVER_STATUS_BADGE: Record<CaregiverStatus, string> = {
  onboarding: "bg-sky-100 text-sky-900",
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
