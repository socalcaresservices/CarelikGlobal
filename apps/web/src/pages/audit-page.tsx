import { useQuery } from "@tanstack/react-query";
import { Card } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";

// Backed by list_audit_logs(), a security-definer RPC (see
// supabase/migrations/20260719220000_list_audit_logs.sql) rather than a
// direct table read - it joins in the actor's display name, which RLS on
// user_profiles wouldn't let this page do on its own.
interface AuditLogRow {
  id: number;
  occurred_at: string;
  actor_user_id: string | null;
  actor_display_name: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
}

function formatAction(action: string) {
  return action.replace(/\./g, " · ").replace(/_/g, " ");
}

export function AuditPage() {
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();

  const canRead = hasPermission("audit.read");

  const auditQuery = useQuery({
    queryKey: ["audit-logs", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_audit_logs", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as AuditLogRow[];
    },
    enabled: !!activeOrganizationId && canRead
  });

  if (!canRead) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Audit trail</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h2>
          <p className="mt-3 text-slate-600">
            You don&apos;t have permission to view the audit trail for this organization.
          </p>
        </Card>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Audit trail</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-950">
          {activeOrganization?.displayName ?? "Activity"}
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Every insert, update, and delete this organization&apos;s data has gone through,
          most recent first. This is a read-only record — nothing here can be edited or removed
          from the app.
        </p>
      </div>

      <Card>
        {auditQuery.isLoading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : auditQuery.isError ? (
          <p className="text-sm text-red-700">Could not load the audit trail.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <th className="pb-2 font-medium">When</th>
                <th className="pb-2 font-medium">Who</th>
                <th className="pb-2 font-medium">Action</th>
                <th className="pb-2 font-medium">Record</th>
              </tr>
            </thead>
            <tbody>
              {(auditQuery.data ?? []).map((entry) => (
                <tr key={entry.id} className="border-b border-slate-100 last:border-0">
                  <td className="py-2.5 whitespace-nowrap text-slate-500">
                    {new Date(entry.occurred_at).toLocaleString()}
                  </td>
                  <td className="py-2.5 text-slate-800">{entry.actor_display_name}</td>
                  <td className="py-2.5 text-slate-700">{formatAction(entry.action)}</td>
                  <td className="py-2.5 font-mono text-xs text-slate-500">
                    {entry.entity_type}
                    {entry.entity_id ? ` · ${entry.entity_id.slice(0, 8)}…` : ""}
                  </td>
                </tr>
              ))}
              {(auditQuery.data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-slate-400">
                    No activity recorded yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        )}
      </Card>
    </section>
  );
}
