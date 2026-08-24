import { useState } from "react";
import { Button } from "@carelik/ui";
import { useRequestSupportAccess, type StaffSupportRequest } from "@/hooks/use-support-access";

interface ProposeAccessModalProps {
  request: StaffSupportRequest;
  isOpen: boolean;
  onClose: () => void;
}

export function ProposeAccessModal({ request, isOpen, onClose }: ProposeAccessModalProps) {
  const [accessLevel, setAccessLevel] = useState<"read_only" | "edit">("read_only");
  const [reason, setReason] = useState(request.subject);
  const requestAccess = useRequestSupportAccess();

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      await requestAccess.mutateAsync({
        requestId: request.id,
        organizationId: request.organization_id,
        accessLevel,
        reason,
      });

      onClose();
    } catch (error) {
      console.error("Error proposing access:", error);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-lg max-w-2xl w-full mx-4 p-6">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-4">
          Propose Support Access
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
            <div className="text-sm text-slate-600 dark:text-slate-400">
              Organization
            </div>
            <div className="text-lg font-semibold text-slate-900 dark:text-slate-50">
              {request.organization_name}
            </div>
            <div className="mt-3 text-sm text-slate-600 dark:text-slate-400">
              Request
            </div>
            <div className="text-slate-900 dark:text-slate-50">
              {request.subject}
            </div>
            {request.description && (
              <>
                <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  {request.description}
                </div>
              </>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
              Access Level
            </label>
            <div className="space-y-2">
              <label className="flex items-center">
                <input
                  type="radio"
                  name="access-level"
                  value="read_only"
                  checked={accessLevel === "read_only"}
                  onChange={() => setAccessLevel("read_only")}
                  className="mr-2"
                />
                <span className="text-sm text-slate-700 dark:text-slate-300">
                  <strong>Read-Only</strong> - View data to diagnose issue
                </span>
              </label>
              <label className="flex items-center">
                <input
                  type="radio"
                  name="access-level"
                  value="edit"
                  checked={accessLevel === "edit"}
                  onChange={() => setAccessLevel("edit")}
                  className="mr-2"
                />
                <span className="text-sm text-slate-700 dark:text-slate-300">
                  <strong>Edit</strong> - View and modify data to fix issue
                </span>
              </label>
            </div>
            <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {accessLevel === "read_only"
                ? "Default duration: 2 hours. Org owner can adjust up to 8 hours."
                : "Default duration: 30 minutes. Requires org owner approval. All changes logged."}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              Reason for Access
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-50"
              required
            />
          </div>

          <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-sm text-amber-800 dark:text-amber-200">
            <strong>Note:</strong> The organization owner will review and approve your access request. They can adjust the duration or deny the request.
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
              loading={requestAccess.isPending}
              disabled={!reason.trim()}
            >
              Propose Access
            </Button>
          </div>

          {requestAccess.isError && (
            <div className="text-sm text-red-600 dark:text-red-400">
              Error: {(requestAccess.error as Error).message}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
