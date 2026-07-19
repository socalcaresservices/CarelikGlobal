import { useQuery } from "@tanstack/react-query";
import { Card } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { useTableControls } from "@/lib/use-table-controls";
import { SortableHeader } from "@/components/sortable-header";

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

  const table = useTableControls<AuditLogRow, "when" | "who" | "action" | "record">(
    auditQuery.data,
    {
      matchesSearch: (row, query) =>
        row.actor_display_name.toLowerCase().includes(query) ||
        row.action.toLowerCase().includes(query) ||
        row.entity_type.toLowerCase().includes(query),
      sorters: {
        when: (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime(),
        who: (a, b) => a.actor_display_name.localeCompare(b.actor_display_name),
        action: (a, b) => a.action.localeCompare(b.action),
        record: (a, b) => a.entity_type.localeCompare(b.entity_type)
      }
      // No defaultSort: list_audit_logs() already returns newest-first,
      // matching the "most recent first" copy below. Defaulting a sort
      // key here would start it ascending (oldest first) and contradict
      // that on load - let the natural query order stand until the user
      // explicitly clicks a column.
    }
  );

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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Activity</p>
          <input
            type="search"
            value={table.search}
            onChange={(event) => table.setSearch(event.target.value)}
            placeholder="Search who, action, or record"
            aria-label="Search audit trail"
            className="w-full max-w-xs rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900"
          />
        </div>
        {auditQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : auditQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">Could not load the audit trail.</p>
        ) : (
          <table className="mt-4 w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                <SortableHeader
                  label="When"
                  active={table.sortKey === "when"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("when")}
                />
                <SortableHeader
                  label="Who"
                  active={table.sortKey === "who"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("who")}
                />
                <SortableHeader
                  label="Action"
                  active={table.sortKey === "action"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("action")}
                />
                <SortableHeader
                  label="Record"
                  active={table.sortKey === "record"}
                  direction={table.direction}
                  onClick={() => table.toggleSort("record")}
                />
              </tr>
            </thead>
            <tbody>
              {table.rows.map((entry) => (
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
              {table.rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-slate-400">
                    {table.search ? "No activity matches your search." : "No activity recorded yet."}
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
