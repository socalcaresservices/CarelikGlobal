import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { formatDateTime } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "../aws-workspace";

/**
 * "Send sign-in link" for the Caregivers list and the Staff list (anyone who has not signed in). Email only, through the Cognito
 * invitation; the temporary password never passes through the browser. With no email on file it offers "Add email" first.
 * The server rate-limits resends and writes the audit entry; this only shows its answer.
 */
export function SendSignInLink({ caregiverRecordId, hasContact, canManage, lastSentAt }: { caregiverRecordId: string; hasContact: boolean; canManage: boolean; lastSentAt: string | null }) {
  const api = useAwsApi();
  const qc = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({ busy: false, error: null, done: false });
  if (!canManage) return null;
  async function send() {
    setState({ busy: true, error: null, done: false });
    try {
      await api.post(`/v1/caregivers/${encodeURIComponent(caregiverRecordId)}/signin-link`, { organizationId: activeOrganizationId });
      for (const k of ["aws-caregivers", "aws-accounts", "caregiver-readiness"]) await qc.invalidateQueries({ queryKey: [k] });
      setState({ busy: false, error: null, done: true });
    } catch (cause) {
      setState({ busy: false, error: cause instanceof Error ? cause.message : "The sign-in link was not sent.", done: false });
    }
  }
  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0 text-xs">
      {hasContact
        ? <button type="button" disabled={state.busy} onClick={() => void send()} className="inline-flex min-h-[44px] items-center font-semibold text-slate-900 underline disabled:opacity-50 md:min-h-[28px]">{state.busy ? "Sending…" : lastSentAt ? "Resend sign-in link" : "Send sign-in link"}</button>
        : <Link to={`/care-team/${caregiverRecordId}`} className="inline-flex min-h-[44px] items-center font-semibold text-slate-900 underline md:min-h-[28px]">Add email</Link>}
      {lastSentAt ? <span className="text-slate-600">Last sent {formatDateTime(lastSentAt)}</span> : null}
      {state.done ? <span role="status" className="text-emerald-800">Sent. Ask the caregiver to check their inbox and spam folder, then sign in once.</span> : null}
      {state.error ? <span role="alert" className="text-red-700">{state.error}</span> : null}
    </span>
  );
}
