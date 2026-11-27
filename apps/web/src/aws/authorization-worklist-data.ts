// Authorization Worklist (0125, behind the authorizationWorklist release switch). Where the switch is off the route does not exist and the browser sees a failed request, so
// `available` is true only when a cheap probe actually succeeded.
import { useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { AwsApiContext } from "./aws-workspace";
import type { ExportColumn } from "./report-export";

export interface WorklistRow {
  clientId: string; clientCode: string; officeId: string | null; officeName: string | null; serviceId: string; serviceName: string; program: string | null; authorizationId: string | null;
  authorizationNumber: string | null; versionNumber: number | null; periodStart: string | null; periodEnd: string | null; daysToExpiry: number | null; authorizedMinutes: number | null;
  usedMinutes: number | null; scheduledMinutes: number | null; remainingMinutes: number | null; percentCommitted: number | null;
  status: "missing" | "expired" | "expiring" | "exhausted" | "nearly_exhausted" | "ok"; flags: string[];
}
export const WORKLIST_STATUSES: ReadonlyArray<readonly [WorklistRow["status"], string]> = [
  ["missing", "Missing"], ["expired", "Expired"], ["exhausted", "Exhausted"], ["expiring", "Expiring"], ["nearly_exhausted", "Nearly exhausted"], ["ok", "OK"],
];
export const statusLabel = (s: string) => WORKLIST_STATUSES.find(([v]) => v === s)?.[1] ?? s;
/** Hours with one decimal ("12.5"); minutes stay whole in the data. */
export const hoursText = (minutes: number | null | undefined) => (minutes === null || minutes === undefined ? "" : (Math.round((minutes / 60) * 10) / 10).toString());

export function useWorklistAvailable(enabled = true) {
  const api = useContext(AwsApiContext);
  const { activeOrganizationId } = useOrganization();
  const q = useQuery({
    queryKey: ["authorization-worklist-available", activeOrganizationId],
    queryFn: async () => { await api!.get("/v1/authorization-worklist", { organizationId: activeOrganizationId, clientId: "00000000-0000-0000-0000-000000000000" }); return true; },
    enabled: enabled && !!api && !!activeOrganizationId, retry: false, staleTime: 5 * 60_000,
  });
  return { available: q.isSuccess && q.data === true };
}

const dayKey = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
/** The columns of the screen, in screen order, for CSV and Excel. */
export const WORKLIST_COLUMNS: readonly ExportColumn[] = [
  ["Status", "status", (v) => statusLabel(String(v))], ["Client", "clientCode"], ["Office", "officeName"], ["Service", "serviceName"], ["Program", "program"], ["Authorization number", "authorizationNumber"],
  ["Period start", "periodStart", (v) => dayKey(v as string | null)], ["Period end", "periodEnd", (v) => dayKey(v as string | null)], ["Days to expiry", "daysToExpiry"],
  ["Authorized (hours)", "authorizedMinutes", (v) => hoursText(v as number | null)], ["Used (hours)", "usedMinutes", (v) => hoursText(v as number | null)],
  ["Scheduled (hours)", "scheduledMinutes", (v) => hoursText(v as number | null)], ["Remaining (hours)", "remainingMinutes", (v) => hoursText(v as number | null)], ["Committed (%)", "percentCommitted"],
];
