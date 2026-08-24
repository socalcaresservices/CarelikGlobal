import { useState } from "react";
import { Button } from "@carelik/ui";
import { useAuth } from "@carelik/auth";
import { useGrantEmergencyAccess, type Organization } from "@/hooks/use-support-access";

interface GrantEmergencyAccessModalProps {
  organization: Organization;
  isOpen: boolean;
  onClose: () => void;
}

export function GrantEmergencyAccessModal({
  organization,
  isOpen,
  onClose,
}: GrantEmergencyAccessModalProps) {
  const { user } = useAuth();
  const [reason, setReason] = useState("");
  const grantAccess = useGrantEmergencyAccess();

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!user?.id) {
      console.error("User not authenticated");
      return;
    }

    try {
      await grantAccess.mutateAsync({
        organizationId: organization.id,
        userId: user.id,
        reason,
      });

      setReason("");
      onClose();
    } catch (error) {
      console.error("Error granting emergency access:", error);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-lg max-w-2xl w-full mx-4 p-6">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-4">
          Grant Emergency Access
        </h2>

        <div className="mb-6 pb-4 border-b border-slate-200 dark:border-slate-700">
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
            <div className="text-sm font-semibold text-red-900 dark:text-red-100 mb-2">
              ⚠️ Break-Glass Access
            </div>
            <div className="text-sm text-red-800 dark:text-red-200">
              Emergency access grants immediate read-only access for one hour with no subscriber approval required. Use only for critical system issues.
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
            <div className="text-sm text-slate-600 dark:text-slate-400">
              Organization
            </div>
            <div className="text-lg font-semibold text-slate-900 dark:text-slate-50">
              {organization.display_name}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              {organization.slug}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
              Reason for Emergency Access
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              placeholder="e.g., Critical payment processing failure - subscriber unable to resolve"
              className="w-full px-3 py-2 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-50 placeholder-slate-400 dark:placeholder-slate-500"
              required
            />
            <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Detailed reason required - will be logged for audit purposes
            </div>
          </div>

          <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-sm text-amber-800 dark:text-amber-200 space-y-2">
            <div>
              <strong>Duration:</strong> 1 hour (non-renewable)
            </div>
            <div>
              <strong>Access Level:</strong> Read-only (no writes)
            </div>
            <div>
              <strong>Notification:</strong> Subscriber will be notified immediately
            </div>
            <div>
              <strong>Audit:</strong> All actions will be logged
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <Button
              type="submit"
              loading={grantAccess.isPending}
              disabled={!reason.trim()}
              variant="danger"
            >
              Grant Emergency Access
            </Button>
          </div>

          {grantAccess.isError && (
            <div className="text-sm text-red-600 dark:text-red-400">
              Error: {(grantAccess.error as Error).message}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
