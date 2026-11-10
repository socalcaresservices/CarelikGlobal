import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card } from "@carelik/ui";
import { Link } from "react-router-dom";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { ACCOUNT_STATUS_BADGE, ACCOUNT_STATUS_HELP, ACCOUNT_STATUS_LABEL, isAccountStatus, roleLabel } from "./account-status";
import { WORK_STATUS_BADGE, WORK_STATUS_LABEL, type WorkStatus } from "./care-team-admin";
import { SendSignInLink } from "./readiness/send-signin-link";
import { HelpLine } from "./ui/help-line";


interface Account {
  userId: string | null;
  displayName: string | null;
  role: string;
  accountStatus: string;
  caregiverRecordId: string | null;
  caregiverCode: string | null;
  isSelf: boolean;
  /** 0086: the calculated caregiver status, identical to the Caregivers list and the caregiver page (null for staff who are not caregivers). */
  workStatus?: WorkStatus | null;
  readinessMet?: number | null;
  readinessTotal?: number | null;
  hasContact?: boolean | null;
}

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

/** Sign-in accounts: plain-language status and Admin disable/enable. Passwords are never shown, set or stored here. */
export function AccountsPage() {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId, hasPermission } = useOrganization();
  const [acting, setActing] = useState<{ userId: string; kind: "disable" | "enable" } | null>(null);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const allowed = hasPermission("accounts.manage");
  const accounts = useQuery({
    queryKey: ["aws-accounts", activeOrganizationId],
    queryFn: () => api.get<{ accounts: Account[] }>("/v1/accounts", { organizationId: activeOrganizationId }),
    enabled: !!activeOrganizationId && allowed,
  });
  const change = useMutation({
    mutationFn: (v: { userId: string; kind: "disable" | "enable" }) =>
      api.post(`/v1/accounts/${v.userId}/${v.kind}`, { organizationId: activeOrganizationId, reason: reason.trim() }),
    onSuccess: async (_r, v) => {
      setDone(v.kind === "disable" ? "Account disabled. The person can no longer sign in." : "Account enabled. The person can sign in again.");
      setActing(null);
      setReason("");
      await qc.invalidateQueries({ queryKey: ["aws-accounts"] });
    },
  });

  if (!allowed) return <Card><p className="text-sm text-slate-700">Only an administrator can manage sign-in accounts.</p></Card>;
  return (
    <div className="mx-auto max-w-3xl space-y-2">
      <div>
        <h1 className="text-xl font-semibold text-slate-950">Accounts</h1>
        <HelpLine details="You can enable a person again. Passwords are never shown here.">See who can sign in. Disabling stops sign-in; records, shifts and visit history are kept. People, their types and their roles are in Staff; this page is only about sign-in.</HelpLine>
      </div>
      {done ? <p role="status" className="rounded-md bg-emerald-50 px-3 py-1.5 text-sm text-emerald-900">{done}</p> : null}
      {accounts.isLoading ? <p className="text-sm text-slate-500" role="status">Loading…</p> : null}
      {accounts.isError ? <p role="alert" className="text-sm text-red-700">{message(accounts.error, "The accounts could not be loaded.")}</p> : null}
      <ul className="space-y-1" aria-label="Sign-in accounts">
        {(accounts.data?.accounts ?? []).map((a) => {
          const status = isAccountStatus(a.accountStatus) ? a.accountStatus : null;
          const key = a.userId ?? a.caregiverRecordId ?? a.displayName ?? "";
          const open = acting && a.userId && acting.userId === a.userId ? acting : null;
          return (
            <li key={key} className="rounded-lg border border-slate-200 bg-og-card px-3 py-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 break-words font-semibold text-slate-950">
                  {a.displayName ?? "Name not set"}{a.caregiverCode ? ` (${a.caregiverCode})` : ""}{a.isSelf ? " — you" : ""}
                </p>
                {a.workStatus
                  ? <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${WORK_STATUS_BADGE[a.workStatus]}`}>{WORK_STATUS_LABEL[a.workStatus]}</span>
                  : <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${status ? ACCOUNT_STATUS_BADGE[status] : "bg-slate-100 text-slate-800"}`}>{status ? ACCOUNT_STATUS_LABEL[status] : a.accountStatus}</span>}
              </div>
              <p className="text-xs text-slate-700">{roleLabel(a.role)}{status && ACCOUNT_STATUS_HELP[status] ? ` · ${ACCOUNT_STATUS_HELP[status]}` : ""}{a.workStatus === "not_ready" && a.readinessTotal ? ` · ${a.readinessMet ?? 0} of ${a.readinessTotal} done` : ""}</p>
              {a.workStatus ? <p className="text-xs text-slate-600">Sign-in account: <span>{status ? ACCOUNT_STATUS_LABEL[status] : a.accountStatus}</span></p> : null}
              {a.caregiverRecordId && (status === "invitation_pending" || status === "setup_required") ? (
                <SendSignInLink caregiverRecordId={a.caregiverRecordId} hasContact={!!a.hasContact} canManage={hasPermission("caregivers.manage")} lastSentAt={null} />
              ) : null}
              {status === "setup_required" && a.caregiverRecordId ? <Link className="mt-1 inline-flex min-h-[44px] items-center text-sm font-medium underline md:min-h-0" to={`/care-team/${a.caregiverRecordId}`}>Open in Care Team</Link> : null}
              {a.userId && !a.isSelf && (status === "active" || status === "invitation_pending") && !open ? (
                <Button type="button" variant="secondary" className="mt-1" onClick={() => { setActing({ userId: a.userId!, kind: "disable" }); setDone(null); change.reset(); }}>Disable account…</Button>
              ) : null}
              {a.userId && status === "disabled" && !open ? (
                <Button type="button" variant="secondary" className="mt-1" onClick={() => { setActing({ userId: a.userId!, kind: "enable" }); setDone(null); change.reset(); }}>Enable account…</Button>
              ) : null}
              {open ? (
                <div role="group" aria-label={open.kind === "disable" ? "Disable account" : "Enable account"} className="mt-1 space-y-1.5">
                  <label className="block text-sm font-medium text-slate-800">Reason
                    <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} className="mt-0.5 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
                  </label>
                  {change.isError ? <p role="alert" className="text-sm text-red-700">{message(change.error, "The change could not be made.")}</p> : null}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" disabled={change.isPending || reason.trim().length < 3} onClick={() => change.mutate({ userId: open.userId, kind: open.kind })}>
                      {change.isPending ? "Saving…" : open.kind === "disable" ? "Disable account" : "Enable account"}
                    </Button>
                    <Button type="button" variant="secondary" onClick={() => { setActing(null); setReason(""); change.reset(); }}>Cancel</Button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
