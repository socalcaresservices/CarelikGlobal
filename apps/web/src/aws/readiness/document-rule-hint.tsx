import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";

interface SetupRow { requirement: "cpr" | "tb"; documentTypeId: string | null; documentTypeName: string | null; complete: boolean; gap: string | null }

/**
 * Why a document that was uploaded can still read "missing": only documents of the type the agency chose for CPR / TB count, and the agency must also have set a validity rule.
 * It names that type and links to where it is chosen. It shows nothing while loading or if the setup cannot be read (the server's own message stays the whole explanation).
 */
export function DocumentRuleHint({ requirement }: { requirement: "cpr" | "tb" }) {
  const api = useAwsApi();
  const { activeOrganizationId } = useOrganization();
  const setup = useQuery({
    queryKey: ["document-requirements", activeOrganizationId],
    queryFn: async () => (await api.get<{ setup: { requirements: SetupRow[] } }>("/v1/document-requirements", { organizationId: activeOrganizationId })).setup.requirements,
    retry: false,
  });
  const row = setup.data?.find((r) => r.requirement === requirement);
  if (!row) return null;
  const name = requirement.toUpperCase();
  const link = <Link className="inline-flex min-h-[44px] items-center underline md:min-h-[28px]" to="/care-team">Set up required documents (Care Team)</Link>;
  if (row.gap === "type_not_set") {
    return <span className="block text-xs text-slate-700" data-testid={`rule-hint-${requirement}`}>No document type is set as the agency's {name} record, so an uploaded {name} document is not linked to the {name} requirement. {link}</span>;
  }
  if (row.gap === "policy_not_set") {
    return <span className="block text-xs text-slate-700" data-testid={`rule-hint-${requirement}`}>The {name} document type is chosen, but the agency has not set how long it stays valid. {link}</span>;
  }
  return (
    <span className="block text-xs text-slate-700" data-testid={`rule-hint-${requirement}`}>
      Only documents of the type “{row.documentTypeName ?? "chosen for " + name}” count for {name}. One uploaded under another type does not, even if it shows Current on the Documents page. <Link className="inline-flex min-h-[44px] items-center underline md:min-h-[28px]" to="/documents">Open Documents</Link> · {link}
    </span>
  );
}
