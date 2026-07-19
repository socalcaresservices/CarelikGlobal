import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@carelik/ui";
import { systemRoleSchema } from "@carelik/shared";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";
import { inviteMember, type InvitableRole } from "@/lib/invitations";

interface MemberRow {
  membership_id: string;
  user_id: string;
  display_name: string;
  role: string;
  status: "invited" | "active" | "suspended" | "revoked";
  invited_by: string | null;
  joined_at: string | null;
  created_at: string;
}

const invitableRoles = systemRoleSchema.options.filter(
  (role): role is InvitableRole => role !== "platform_owner"
);

const statusStyles: Record<MemberRow["status"], string> = {
  active: "bg-emerald-50 text-emerald-700",
  invited: "bg-amber-50 text-amber-700",
  suspended: "bg-slate-100 text-slate-600",
  revoked: "bg-red-50 text-red-700"
};

function formatRole(role: string) {
  return role.replace(/_/g, " ");
}

export function AccessPage() {
  const { activeOrganizationId, activeOrganization, hasPermission } = useOrganization();
  const queryClient = useQueryClient();

  const canRead = hasPermission("membership.read");
  const canInvite = hasPermission("membership.invite");

  const membersQuery = useQuery({
    queryKey: ["organization-members", activeOrganizationId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_organization_members", {
        target_organization_id: activeOrganizationId!
      });
      if (error) throw error;
      return (data ?? []) as MemberRow[];
    },
    enabled: !!activeOrganizationId && canRead
  });

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitableRole>("staff");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeOrganizationId) return;

    setSubmitting(true);
    setFormError(null);
    setFormSuccess(null);
    try {
      await inviteMember({ email, organizationId: activeOrganizationId, role });
      setFormSuccess(`Invited ${email}.`);
      setEmail("");
      void queryClient.invalidateQueries({
        queryKey: ["organization-members", activeOrganizationId]
      });
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "Invite failed. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!canRead) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Access control</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h2>
          <p className="mt-3 text-slate-600">
            You don&apos;t have permission to view membership for this organization.
          </p>
        </Card>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Access control</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-950">
          {activeOrganization?.displayName ?? "Members"}
        </h2>
      </div>

      {canInvite ? (
        <Card>
          <h3 className="font-semibold text-slate-950">Invite a member</h3>
          <form onSubmit={handleInvite} className="mt-4 flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <label htmlFor="invite-email" className="block text-xs font-medium text-slate-600">
                Email
              </label>
              <input
                id="invite-email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              />
            </div>
            <div>
              <label htmlFor="invite-role" className="block text-xs font-medium text-slate-600">
                Role
              </label>
              <select
                id="invite-role"
                value={role}
                onChange={(event) => setRole(event.target.value as InvitableRole)}
                className="mt-1 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900"
              >
                {invitableRoles.map((option) => (
                  <option key={option} value={option}>
                    {formatRole(option)}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? "Sending…" : "Send invite"}
            </button>
          </form>
          {formError ? <p className="mt-3 text-sm text-red-700">{formError}</p> : null}
          {formSuccess ? <p className="mt-3 text-sm text-emerald-700">{formSuccess}</p> : null}
        </Card>
      ) : null}

      <Card>
        <h3 className="font-semibold text-slate-950">Members</h3>
        {membersQuery.isLoading ? (
          <p className="mt-3 text-sm text-slate-500">Loading…</p>
        ) : membersQuery.isError ? (
          <p className="mt-3 text-sm text-red-700">Could not load members.</p>
        ) : (
          <table className="mt-4 w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Role</th>
                <th className="pb-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {(membersQuery.data ?? []).map((member) => (
                <tr key={member.membership_id} className="border-b border-slate-100 last:border-0">
                  <td className="py-2.5 text-slate-800">{member.display_name}</td>
                  <td className="py-2.5 text-slate-600">{formatRole(member.role)}</td>
                  <td className="py-2.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[member.status]}`}
                    >
                      {member.status}
                    </span>
                  </td>
                </tr>
              ))}
              {(membersQuery.data ?? []).length === 0 ? (
                <tr>
                  <td colSpan={3} className="py-4 text-center text-slate-400">
                    No members yet.
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
