import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, StatusBadge } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";

// Administrative workforce records only. This screen does not rank, score,
// recommend, select, or remove people. Authorized staff control record changes.
interface WorkforceRow {
  id: string;
  linked_user_id: string | null;
  display_name: string;
  email: string | null;
  phone: string | null;
  status: string;
  desired_weekly_hours: number | null;
  available_start_date: string | null;
}

export function WorkforcePage() {
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const queryClient = useQueryClient();
  const canRead = hasPermission("membership.read");
  const canManage = hasPermission("membership.update");
  const [showAdd, setShowAdd] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  const recordsQuery = useQuery({
    queryKey: ["care-team-records", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_care_team_records", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as WorkforceRow[];
    },
    enabled: !!activeOrganizationId && canRead
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("caregiver_records").insert({
        organization_id: activeOrganizationId!,
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        status: "active"
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setFirstName(""); setLastName(""); setEmail(""); setPhone(""); setShowAdd(false);
      void queryClient.invalidateQueries({ queryKey: ["care-team-records", activeOrganizationId] });
    }
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (firstName.trim() && lastName.trim()) addMutation.mutate();
  }

  if (!canRead) return <Card><p className="text-sm text-slate-600">You do not have permission to view workforce records.</p></Card>;

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-start justify-between gap-4"><div><p className="text-sm font-medium text-slate-500">Care Team</p><h1 className="mt-1 text-2xl font-semibold text-slate-950">{activeOrganization?.displayName ?? "Care Team"}</h1><p className="mt-1 text-sm text-slate-500">A workforce record does not require a login account.</p></div>{canManage ? <Button onClick={() => setShowAdd((v) => !v)}>{showAdd ? "Cancel" : "Add caregiver"}</Button> : null}</div>
      {showAdd ? <Card><form onSubmit={submit} className="grid gap-3 sm:grid-cols-2"><input required placeholder="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm"/><input required placeholder="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm"/><input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm"/><input placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm"/><div className="sm:col-span-2"><Button type="submit" loading={addMutation.isPending}>Create record</Button>{addMutation.isError ? <p className="mt-2 text-sm text-red-700">Could not create the record.</p> : null}</div></form></Card> : null}
      {recordsQuery.isLoading ? <p className="text-sm text-slate-500">Loading…</p> : recordsQuery.isError ? <p className="text-sm text-red-700">Could not load records.</p> : <Card><div className="overflow-x-auto"><table className="min-w-full text-sm"><thead><tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500"><th className="px-3 py-2">Name</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Hours</th><th className="px-3 py-2">Access</th></tr></thead><tbody>{(recordsQuery.data ?? []).map((row) => <tr key={row.id} className="border-b border-slate-100"><td className="px-3 py-3"><Link to={`/team/${row.id}`} className="font-semibold text-slate-900 hover:underline">{row.display_name}</Link><p className="text-xs text-slate-500">{row.email ?? ""}{row.phone ? ` · ${row.phone}` : ""}</p></td><td className="px-3 py-3"><StatusBadge label={row.status.replace(/_/g," ")} tone={row.status === "active" || row.status === "ready" ? "success" : "neutral"}/></td><td className="px-3 py-3">{row.desired_weekly_hours != null ? `${row.desired_weekly_hours}/wk` : "—"}</td><td className="px-3 py-3"><StatusBadge label={row.linked_user_id ? "Linked" : "No login"} tone={row.linked_user_id ? "success" : "neutral"}/></td></tr>)}</tbody></table></div></Card>}
    </section>
  );
}
