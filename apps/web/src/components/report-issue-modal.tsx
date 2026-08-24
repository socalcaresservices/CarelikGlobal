import { useState } from "react";
import { Button } from "@carelik/ui";
import { useCreateSupportRequest } from "@/hooks/use-support-access";

interface ReportIssueModalProps {
  organizationId: string;
  isOpen: boolean;
  onClose: () => void;
}

export function ReportIssueModal({ organizationId, isOpen, onClose }: ReportIssueModalProps) {
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const createRequest = useCreateSupportRequest(organizationId);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      await createRequest.mutateAsync({
        subject: subject.trim(),
        description: description.trim(),
      });

      setSubject("");
      setDescription("");
      onClose();
    } catch (error) {
      console.error("Error creating support request:", error);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-lg max-w-2xl w-full mx-4 p-6">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-4">Report an Issue</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              Subject
            </label>
            <input
              type="text"
              required
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g., Can't add new caregiver record"
              className="w-full px-3 py-2 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-50 placeholder-slate-400 dark:placeholder-slate-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the issue, what you expected to happen, and any error messages you see."
              rows={5}
              className="w-full px-3 py-2 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-50 placeholder-slate-400 dark:placeholder-slate-500"
            />
          </div>

          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded p-3 text-sm text-blue-800 dark:text-blue-200">
            <strong>What happens next:</strong> Ogevia support will review your issue and may request access to diagnose it. You'll be asked to approve any access before they can view your organization's data.
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
              loading={createRequest.isPending}
              disabled={!subject.trim()}
            >
              Submit Report
            </Button>
          </div>

          {createRequest.isError && (
            <div className="text-sm text-red-600 dark:text-red-400">
              Error creating report: {(createRequest.error as Error).message}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
