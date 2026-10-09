import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button, Card } from "@carelik/ui";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";
import { actionError } from "./format";
import { useGuardedMutate } from "./use-guarded";

type Tag = { tagId: string; label: string };
type Mine = { tags: { tagId: string; label: string; status: "reported" | "confirmed" | "not_confirmed" }[] };

/** The signed-in caregiver reports their own experience. A report is not a confirmation and earns nothing until an administrator confirms it. */
export function MyExperience() {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const allowed = hasPermission("experience.report_own");
  const tags = useQuery({ queryKey: ["experience-tags", activeOrganizationId], queryFn: async () => (await api.get<{ tags: Tag[] }>("/v1/experience-tags", { organizationId: activeOrganizationId })).tags, enabled: !!activeOrganizationId && allowed });
  const mine = useQuery({ queryKey: ["my-experience", activeOrganizationId], queryFn: async () => (await api.get<{ experience: Mine }>("/v1/experience/me", { organizationId: activeOrganizationId })).experience, enabled: !!activeOrganizationId && allowed });
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [done, setDone] = useState(false);
  const key = useRef(newIdempotencyKey());
  useEffect(() => { setChecked(new Set((mine.data?.tags ?? []).filter((t) => t.status !== "not_confirmed").map((t) => t.tagId))); }, [mine.data]);
  const save = useMutation({
    mutationFn: () => api.post("/v1/experience/me", { organizationId: activeOrganizationId, tagIds: [...checked] }, { idempotencyKey: key.current }),
    onSuccess: () => { setDone(true); key.current = newIdempotencyKey(); void qc.invalidateQueries({ queryKey: ["my-experience"] }); },
  });
  const send = useGuardedMutate(save);
  if (!allowed) return null;
  const status = new Map((mine.data?.tags ?? []).map((t) => [t.tagId, t.status]));
  return (
    <Card role="region" className="space-y-2 p-4" aria-label="My experience">
      <h2 className="text-base font-semibold text-slate-950">My experience</h2>
      <p className="text-sm text-slate-800">Tell the agency what you have experience with. An administrator confirms it; until then it is only a note.</p>
      {tags.isLoading || mine.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {tags.isError || mine.isError ? <p role="alert" className="text-sm text-red-700">{actionError(tags.error ?? mine.error, "Experience could not be loaded.")}</p> : null}
      {tags.data && tags.data.length === 0 ? <p className="text-sm text-slate-600">The agency has not listed any experience areas yet.</p> : null}
      {tags.data && tags.data.length > 0 ? (
        <form className="space-y-2" aria-label="Report my experience" onSubmit={(e) => { e.preventDefault(); if (!save.isPending) send(); }}>
          <ul className="space-y-1">
            {tags.data.map((t) => (
              <li key={t.tagId}>
                <label className="flex min-h-[44px] items-center gap-2 text-sm text-slate-900">
                  <input type="checkbox" className="h-5 w-5" disabled={status.get(t.tagId) === "confirmed"} checked={checked.has(t.tagId)}
                    onChange={(e) => { setDone(false); key.current = newIdempotencyKey(); setChecked((prev) => { const n = new Set(prev); if (e.target.checked) n.add(t.tagId); else n.delete(t.tagId); return n; }); }} />
                  <span>{t.label}{status.get(t.tagId) === "confirmed" ? <span className="text-emerald-900"> · confirmed by the agency</span> : status.get(t.tagId) === "reported" ? <span className="text-slate-600"> · waiting for confirmation</span> : null}</span>
                </label>
              </li>
            ))}
          </ul>
          {save.isError ? <p role="alert" className="text-sm text-red-700">{actionError(save.error, "Your experience could not be saved.")}</p> : null}
          {done ? <p role="status" className="text-sm text-emerald-900">Saved. The agency will confirm it.</p> : null}
          <Button type="submit" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save my experience"}</Button>
        </form>
      ) : null}
    </Card>
  );
}
