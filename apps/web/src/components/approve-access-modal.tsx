import { useState } from "react";
import { Button } from "@carelik/ui";
import { useApproveSupportAccess, useRejectSupportAccess, type SupportAccessGrant } from "@/hooks/use-support-access";

interface ApproveAccessModalProps {
  organizationId: string;
  grant: SupportAccessGrant;
  isOpen: boolean;
  onClose: () => void;
}

const accessLevelDescriptions = {
  read_only:
    "Support staff can view your organization's data (clients, caregivers, schedules, settings). They cannot make any changes.",
  edit: "Support staff can view and modify your data to fix issues. This is for specific data corrections only.",
};

const defaultDurations = {
  read_only: 120,
  edit: 30,
};

export function ApproveAccessModal({
  organizationId,
  grant,
  isOpen,
  onClose,
}: ApproveAccessModalProps) {
  const [expiresInMinutes, setExpiresInMinutes] = useState(
    defaultDurations[grant.access_level]
  );
  const approve = useApproveSupportAccess(organizationId);
  const reject = useRejectSupportAccess(organizationId);

  if (!isOpen) return null;

  const handleApprove = async () => {
    try {
      await approve.mutateAsync({
        grantId: grant.id,
        expiresInMinutes,
      });
      onClose();
    } catch (error) {
      console.error("Error approving access:", error);
    }
  };

  const handleReject = async () => {
    try {
      await reject.mutateAsync(grant.id);
      onClose();
    } catch (error) {
      console.error("Error rejecting access:", error);
    }
  };

  const accessLevel = grant.access_level as "read_only" | "edit";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-lg max-w-2xl w-full mx-4 p-6">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-2">
          Approve Support Access Request
        </h2>

        <div className="mb-6">
          <div className="text-sm text-slate-600 dark:text-slate-400">
            From: <span className="font-mono text-slate-900 dark:text-slate-50">{grant.grantee_email}</span>
          </div>
          <div className="text-sm text-slate-600 dark:text-slate-400">
            Requested: {new Date(grant.requested_at).toLocaleString()}
          </div>
        </div>

        <div className="space-y-4">
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
            <h3 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">
              {accessLevel === "read_only" ? "📖 Read-Only Access" : "✏️ Edit Access"}
            </h3>
            <p className="text-sm text-blue-800 dark:text-blue-200 mb-3">
              {accessLevelDescriptions[accessLevel]}
            </p>
            <p className="text-sm text-blue-800 dark:text-blue-200">
              <strong>Reason:</strong> {grant.reason}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
              Access Duration
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="15"
                max="480"
                value={expiresInMinutes}
                onChange={(e) => setExpiresInMinutes(Math.max(15, parseInt(e.target.value) || 0))}
                className="w-24 px-3 py-2 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-50"
              />
              <span className="text-slate-600 dark:text-slate-400">minutes</span>
            </div>
            <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Access will expire at {new Date(Date.now() + expiresInMinutes * 60000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} UTC
            </div>
          </div>

          <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-sm text-amber-800 dark:text-amber-200">
            <strong>Important:</strong> You can revoke this access anytime. All actions taken by support staff while they have access will be logged for your records.
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={handleReject}
            disabled={reject.isPending}
            className="px-4 py-2 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
          >
            Reject Request
          </button>
          <Button
            onClick={handleApprove}
            loading={approve.isPending}
          >
            Approve Access
          </Button>
        </div>

        {(approve.isError || reject.isError) && (
          <div className="mt-4 text-sm text-red-600 dark:text-red-400">
            Error: {((approve.error || reject.error) as Error)?.message}
          </div>
        )}
      </div>
    </div>
  );
}
