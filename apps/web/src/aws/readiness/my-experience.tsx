import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";
import { actionError } from "./format";
import { useGuardedMutate } from "./use-guarded";
import { InfoTip } from "../ui/info-tip";

type Tag = { tagId: string; label: string };
type Mine = { tags: { tagId: string; label: string; status: "reported" | "confirmed" | "not_confirmed" }[] };

/**
 * The signed-in caregiver reports their own experience. A report is not a confirmation and earns nothing until an administrator confirms it.
 * Saving REPLACES the reported list, so the form can only be submitted once BOTH the agency's tags and the caregiver's existing experience have
 * loaded successfully; otherwise an empty submission could erase experience that was reported earlier. Edits are kept in their own state,
 * so a failed load, a retry, a refetch or a failed save never discards what the caregiver changed.
 */
export function MyExperience() {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const allowed = hasPermission("experience.report_own");
  const tags = useQuery({ queryKey: ["experience-tags", activeOrganizationId], queryFn: async () => (await api.get<{ tags: Tag[] }>("/v1/experience-tags", { organizationId: activeOrganizationId })).tags, enabled: !!activeOrganizationId && allowed });
  const mine = useQuery({ queryKey: ["my-experience", activeOrganizationId], queryFn: async () => (await api.get<{ experience: Mine }>("/v1/experience/me", { organizationId: activeOrganizationId })).experience, enabled: !!activeOrganizationId && allowed });
  const [edited, setEdited] = useState<Set<string> | null>(null);
  const [done, setDone] = useState(false);
  const key = useRef(newIdempotencyKey());
  const ready = tags.isSuccess && mine.isSuccess;
  const baseline = new Set((mine.data?.tags ?? []).filter((t) => t.status !== "not_confirmed").map((t) => t.tagId));
  const checked = edited ?? baseline;
  const save = useMutation({
    mutationFn: () => api.post("/v1/experience/me", { organizationId: activeOrganizationId, tagIds: [...checked] }, { idempotencyKey: key.current }),
    onSuccess: async () => {
      setDone(true);
      key.current = newIdempotencyKey();
      await qc.invalidateQueries({ queryKey: ["my-experience"] });
      setEdited(null);
    },
  });
  const send = useGuardedMutate(save);
  if (!allowed) return null;
  const status = new Map((mine.data?.tags ?? []).map((t) => [t.tagId, t.status]));
  const failed = tags.isError || mine.isError;
  const retry = () => { if (tags.isError) void tags.refetch(); if (mine.isError) void mine.refetch(); };
  return (
    <Card role="region" className="space-y-1.5" aria-label="My experience">
      <div className="flex items-center gap-1.5">
        <h2 className="text-sm font-semibold text-slate-950">My experience</h2>
        <InfoTip>Tell the agency what you have experience with. An administrator confirms it; until then it is only a note.</InfoTip>
      </div>
      {!ready && !failed ? <p role="status" className="text-sm text-slate-500">Loading…</p> : null}
      {failed ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-red-700">{actionError(tags.error ?? mine.error, "Your experience could not be loaded.")} Nothing can be saved until it loads, so your earlier answers are not replaced.</p>
          <Button type="button" variant="secondary" onClick={retry}>Try again</Button>
        </div>
      ) : null}
      {tags.data && tags.data.length === 0 ? <p className="text-sm text-slate-600">The agency has not listed any experience areas yet.</p> : null}
      {tags.data && tags.data.length > 0 ? (
        <form className="space-y-2" aria-label="Report my experience" onSubmit={(e) => { e.preventDefault(); if (ready && !save.isPending) send(); }}>
          <ul className="space-y-1">
            {tags.data.map((t) => (
              <li key={t.tagId}>
                <label className="flex min-h-[44px] items-center gap-2 text-sm text-slate-900">
                  <input type="checkbox" className="h-5 w-5" disabled={!ready || status.get(t.tagId) === "confirmed"} checked={checked.has(t.tagId)}
                    onChange={(e) => { setDone(false); key.current = newIdempotencyKey(); const n = new Set(checked); if (e.target.checked) n.add(t.tagId); else n.delete(t.tagId); setEdited(n); }} />
                  <span>{t.label}{status.get(t.tagId) === "confirmed" ? <span className="text-emerald-900"> · confirmed by the agency</span> : status.get(t.tagId) === "reported" ? <span className="text-slate-600"> · waiting for confirmation</span> : null}</span>
                </label>
              </li>
            ))}
          </ul>
          {save.isError ? <p role="alert" className="text-sm text-red-700">{actionError(save.error, "Your experience could not be saved.")} Your changes are kept; try again.</p> : null}
          {done ? <p role="status" className="text-sm text-emerald-900">Saved. The agency will confirm it.</p> : null}
          <Button type="submit" disabled={!ready || save.isPending}>{save.isPending ? "Saving…" : "Save my experience"}</Button>
        </form>
      ) : null}
    </Card>
  );
}
