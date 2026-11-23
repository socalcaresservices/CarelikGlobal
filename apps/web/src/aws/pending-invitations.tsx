import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@carelik/auth";
import { meQueryKey, useAwsApi, useMyPendingInvitations } from "./aws-workspace";

const ROLE_NAME: Record<string, string> = {
  organization_admin: "Administrator", manager: "Manager", scheduler: "Scheduler", coordinator: "Coordinator", staff: "Staff", read_only: "Read-only",
};

/**
 * Staff invitations to an agency that this person has not accepted yet (0087). An invitation grants nothing until it is accepted here;
 * accepting is the person's own action, so an agency cannot give itself access to an existing sign-in by typing its e-mail address.
 */
export function PendingInvitations() {
  const invitations = useMyPendingInvitations();
  const api = useAwsApi();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const accept = useMutation({
    mutationFn: (organizationId: string) => api.post(`/v1/me/staff-invitations/${encodeURIComponent(organizationId)}/accept`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: meQueryKey(user?.id) }),
  });
  if (invitations.length === 0) return null;
  return (
    <section aria-label="Invitations waiting for you" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-left">
      <h2 className="text-sm font-semibold text-amber-950">{invitations.length === 1 ? "You have been invited to an organization" : "You have been invited to organizations"}</h2>
      <p className="mt-1 text-sm text-amber-950">Accepting gives you the access shown. You are not part of the organization until you accept.</p>
      <ul className="mt-2 space-y-2">
        {invitations.map((i) => (
          <li key={i.organizationId} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-slate-900"><span className="font-medium">{i.organizationName}</span> as {ROLE_NAME[i.role] ?? i.role}</span>
            <button
              type="button"
              className="min-h-[44px] rounded-lg border border-slate-900 bg-slate-900 px-3 text-sm font-medium text-white disabled:opacity-60"
              disabled={accept.isPending}
              onClick={() => accept.mutate(i.organizationId)}
            >
              Accept invitation
            </button>
          </li>
        ))}
      </ul>
      {accept.isError ? <p role="alert" className="mt-2 text-sm text-red-700">{(accept.error as Error).message || "The invitation could not be accepted."}</p> : null}
    </section>
  );
}
