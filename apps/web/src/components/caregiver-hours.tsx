import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, StatusBadge, usageLabel, usageTone } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { getWeekEnd, getWeekStart } from "@/lib/week";

// Backed by get_caregiver_hours(), a security-definer RPC (see
// supabase/migrations/20260719240000_caregiver_hour_targets.sql).
// Access mirrors shifts: org-wide with shifts.read, otherwise just your
// own row - a caregiver without shifts.read still sees whether they're
// over their own target.
export interface CaregiverHoursRow {
  caregiver_user_id: string;
  caregiver_name: string;
  target_hours_per_week: number | null;
  scheduled_hours: number;
}

function formatHours(hours: number) {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

export function CaregiverHoursCard() {
  const { activeOrganizationId, hasPermission } = useOrganization();
  const queryClient = useQueryClient();
  const canSetTargets = hasPermission("shifts.update");

  const weekStart = getWeekStart(new Date());
  const weekEnd = getWeekEnd(weekStart);

  const hoursQuery = useQuery({
    queryKey: ["caregiver-hours", activeOrganizationId, weekStart.toISOString()],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_caregiver_hours", {
        target_organization_id: activeOrganizationId!,
        week_start: weekStart.toISOString(),
        week_end: weekEnd.toISOString()
      });
      if (error) throw error;
      return (data ?? []) as CaregiverHoursRow[];
    },
    enabled: !!activeOrganizationId
  });

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  function draftFor(row: CaregiverHoursRow) {
    return drafts[row.caregiver_user_id] ?? (row.target_hours_per_week?.toString() ?? "");
  }

  async function handleSaveTarget(row: CaregiverHoursRow) {
    if (!activeOrganizationId) return;
    const raw = draftFor(row).trim();
    const parsed = raw === "" ? null : Number(raw);
    if (raw !== "" && (Number.isNaN(parsed) || parsed! < 0 || parsed! > 168)) {
      setRowError("Target hours must be a number between 0 and 168.");
      return;
    }

    setRowError(null);
    setSavingId(row.caregiver_user_id);
    try {
      const { error } = await supabase.rpc("set_caregiver_weekly_target", {
        target_organization_id: activeOrganizationId,
        target_user_id: row.caregiver_user_id,
        target_hours: parsed
      });
      if (error) throw error;
      setDrafts((current) => {
        const next = { ...current };
        delete next[row.caregiver_user_id];
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ["caregiver-hours", activeOrganizationId] });
      void queryClient.invalidateQueries({ queryKey: ["action-center-caregiver-hours", activeOrganizationId] });
    } catch (cause) {
      setRowError(cause instanceof Error ? cause.message : "Could not save target.");
    } finally {
      setSavingId(null);
    }
  }

  const rows = hoursQuery.data ?? [];
  if (!hoursQuery.isLoading && rows.length === 0) return null;

  return (
    <Card>
      <h3 className="font-semibold text-slate-950">Caregiver hours this week</h3>
      <p className="mt-1 text-xs text-slate-500">
        {weekStart.toLocaleDateString()} – {new Date(weekEnd.getTime() - 1).toLocaleDateString()} · scheduled +
        completed shift hours against each caregiver&apos;s weekly target.
      </p>
      {rowError ? <p className="mt-2 text-sm text-red-700">{rowError}</p> : null}
      {hoursQuery.isLoading ? (
        <p className="mt-3 text-sm text-slate-500">Loading…</p>
      ) : hoursQuery.isError ? (
        <p className="mt-3 text-sm text-red-700">Could not load caregiver hours.</p>
      ) : (
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
              <th className="pb-2 font-medium">Caregiver</th>
              <th className="pb-2 font-medium">Target</th>
              <th className="pb-2 font-medium">Scheduled</th>
              <th className="pb-2 font-medium">Gap</th>
              <th className="pb-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const hasTarget = row.target_hours_per_week !== null;
              const gap = hasTarget ? row.target_hours_per_week! - row.scheduled_hours : null;
              return (
                <tr key={row.caregiver_user_id} className="border-b border-slate-100 last:border-0">
                  <td className="py-2.5 text-slate-800">{row.caregiver_name}</td>
                  <td className="py-2.5">
                    {canSetTargets ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={0}
                          max={168}
                          step={0.5}
                          value={draftFor(row)}
                          onChange={(event) =>
                            setDrafts((current) => ({
                              ...current,
                              [row.caregiver_user_id]: event.target.value
                            }))
                          }
                          aria-label={`Target hours for ${row.caregiver_name}`}
                          className="w-20 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-900"
                        />
                        <button
                          type="button"
                          disabled={savingId === row.caregiver_user_id}
                          onClick={() => handleSaveTarget(row)}
                          className="text-xs font-medium text-slate-700 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Save
                        </button>
                      </div>
                    ) : hasTarget ? (
                      `${formatHours(row.target_hours_per_week!)}h`
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-2.5 text-slate-600">{formatHours(row.scheduled_hours)}h</td>
                  <td className="py-2.5 text-slate-600">
                    {gap !== null ? `${gap >= 0 ? "" : "+"}${formatHours(Math.abs(gap))}h` : "—"}
                  </td>
                  <td className="py-2.5">
                    {hasTarget ? (
                      <StatusBadge
                        label={usageLabel(row.scheduled_hours, row.target_hours_per_week!)}
                        tone={usageTone(row.scheduled_hours, row.target_hours_per_week!)}
                      />
                    ) : (
                      <StatusBadge label="No target set" tone="neutral" />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
