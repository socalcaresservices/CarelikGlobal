import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@carelik/ui";
import { supabase } from "@/lib/supabase";

type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
interface Slot { day_of_week: Weekday; start_time: string; end_time: string; notes: string; }
const WEEKDAYS: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const title = (value: string) => value[0]!.toUpperCase() + value.slice(1);

export function ClientRequestedSchedule({ organizationId, clientId, canManage }: { organizationId: string; clientId: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["client-requested-schedule", organizationId, clientId],
    queryFn: async () => {
      const { data, error } = await supabase.from("client_requested_schedule").select("day_of_week, start_time, end_time, notes").eq("organization_id", organizationId).eq("client_id", clientId).order("day_of_week").order("start_time");
      if (error) throw error;
      return (data ?? []) as Slot[];
    }
  });
  const [slots, setSlots] = useState<Slot[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { if (query.data) setSlots(query.data.map((slot: Slot) => ({ ...slot, start_time: slot.start_time.slice(0, 5), end_time: slot.end_time.slice(0, 5), notes: slot.notes ?? "" }))); }, [query.data]);
  const byDay = useMemo(() => Object.fromEntries(WEEKDAYS.map((day) => [day, slots.filter((slot) => slot.day_of_week === day)])) as Record<Weekday, Slot[]>, [slots]);
  function add(day: Weekday) { if (byDay[day].length < 2) setSlots((rows) => [...rows, { day_of_week: day, start_time: "09:00", end_time: "13:00", notes: "" }]); }
  function update(day: Weekday, index: number, patch: Partial<Slot>) { setSlots((rows) => { let seen = -1; return rows.map((row) => { if (row.day_of_week !== day) return row; seen += 1; return seen === index ? { ...row, ...patch } : row; }); }); }
  function remove(day: Weekday, index: number) { setSlots((rows) => { let seen = -1; return rows.filter((row) => { if (row.day_of_week !== day) return true; seen += 1; return seen !== index; }); }); }
  async function save() {
    setSaving(true); setMessage(null);
    const { error } = await supabase.rpc("replace_client_requested_schedule", { target_organization_id: organizationId, target_client_id: clientId, requested_slots: slots });
    setSaving(false);
    if (error) { setMessage(error.message); return; }
    setMessage("Requested schedule saved.");
    void queryClient.invalidateQueries({ queryKey: ["client-requested-schedule", organizationId, clientId] });
  }
  if (query.isError) return <p className="text-sm text-red-700">Could not load requested days and times.</p>;
  return <div className="space-y-3"><div className="grid gap-2 md:grid-cols-2">{WEEKDAYS.map((day) => <div key={day} className="rounded-lg border border-slate-200 p-2.5"><div className="flex items-center justify-between"><p className="text-sm font-semibold text-slate-800">{title(day)}</p>{canManage && byDay[day].length < 2 ? <button type="button" onClick={() => add(day)} className="text-xs font-medium text-slate-700">+ Add shift</button> : null}</div>{byDay[day].length === 0 ? <p className="mt-1 text-xs text-slate-400">No shift requested</p> : <div className="mt-2 space-y-2">{byDay[day].map((slot, index) => <div key={`${day}-${index}`} className="grid grid-cols-[1fr_1fr_auto] gap-1.5"><input aria-label={`${title(day)} shift ${index + 1} start`} disabled={!canManage} type="time" value={slot.start_time} onChange={(event) => update(day, index, { start_time: event.target.value })} className="min-w-0 rounded-md border border-slate-200 px-2 py-1.5 text-sm"/><input aria-label={`${title(day)} shift ${index + 1} end`} disabled={!canManage} type="time" value={slot.end_time} onChange={(event) => update(day, index, { end_time: event.target.value })} className="min-w-0 rounded-md border border-slate-200 px-2 py-1.5 text-sm"/>{canManage ? <button type="button" onClick={() => remove(day, index)} className="px-1 text-xs text-red-600">Remove</button> : null}<input aria-label={`${title(day)} shift ${index + 1} notes`} disabled={!canManage} value={slot.notes} onChange={(event) => update(day, index, { notes: event.target.value })} placeholder="Optional timing notes" className="col-span-3 rounded-md border border-slate-200 px-2 py-1.5 text-sm"/></div>)}</div>}</div>)}</div>{canManage ? <Button type="button" variant="secondary" loading={saving} onClick={save}>Save requested schedule</Button> : null}{message ? <p className={`text-sm ${message.endsWith("saved.") ? "text-emerald-700" : "text-red-700"}`}>{message}</p> : null}</div>;
}
