import { useOrganization } from "@/providers/organization-provider";
import { useActiveSupportGrant } from "@/hooks/use-support-access";
import { useState } from "react";

interface GrantDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  grant: {
    grantee_email: string;
    access_level: "read_only" | "edit";
    expires_at: string | null;
    reason: string;
  };
}

function GrantDetailsModal({ isOpen, onClose, grant }: GrantDetailsModalProps) {
  if (!isOpen) return null;

  const expiresAt = grant.expires_at ? new Date(grant.expires_at) : null;
  const now = new Date();
  const minutesUntilExpiry = expiresAt ? Math.round((expiresAt.getTime() - now.getTime()) / 60000) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-lg max-w-md w-full mx-4 p-6">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-4">Support Mode Details</h2>

        <div className="space-y-3 text-sm mb-6">
          <div>
            <div className="text-slate-500 dark:text-slate-400">Support Staff</div>
            <div className="text-slate-900 dark:text-slate-50 font-mono">{grant.grantee_email}</div>
          </div>

          <div>
            <div className="text-slate-500 dark:text-slate-400">Access Level</div>
            <div className="text-slate-900 dark:text-slate-50 capitalize">
              {grant.access_level === "read_only" ? "Read-Only" : "Edit"}
            </div>
          </div>

          <div>
            <div className="text-slate-500 dark:text-slate-400">Reason</div>
            <div className="text-slate-900 dark:text-slate-50">{grant.reason}</div>
          </div>

          <div>
            <div className="text-slate-500 dark:text-slate-400">Expires</div>
            <div className="text-slate-900 dark:text-slate-50">
              {expiresAt ? (
                <>
                  {expiresAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} UTC
                  {minutesUntilExpiry > 0 && (
                    <span className="ml-2 text-amber-600 dark:text-amber-400">
                      ({minutesUntilExpiry} min remaining)
                    </span>
                  )}
                </>
              ) : (
                "Unknown"
              )}
            </div>
          </div>
        </div>

        <button
          onClick={onClose}
          className="w-full px-4 py-2 bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-50 rounded hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  );
}

export function SupportModeIndicator() {
  const { activeOrganizationId } = useOrganization();
  const { grant } = useActiveSupportGrant(activeOrganizationId);
  const [showDetails, setShowDetails] = useState(false);

  if (!grant) return null;

  const expiresAt = grant.expires_at ? new Date(grant.expires_at) : null;
  const now = new Date();
  const minutesUntilExpiry = expiresAt ? Math.round((expiresAt.getTime() - now.getTime()) / 60000) : 0;
  const isExpiringSoon = minutesUntilExpiry > 0 && minutesUntilExpiry <= 15;

  return (
    <>
      <div className={`px-4 py-3 border-b text-sm flex items-center justify-between ${
        isExpiringSoon
          ? "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800"
          : "bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800"
      }`}>
        <div className={`flex items-center gap-2 ${isExpiringSoon ? "text-amber-700 dark:text-amber-300" : "text-blue-700 dark:text-blue-300"}`}>
          <span className="text-lg">🔒</span>
          <div>
            <div className="font-semibold">Supporting this organization</div>
            <div className="text-xs opacity-75">
              {grant.access_level === "read_only" ? "Read-Only" : "Edit"} access
              {isExpiringSoon && minutesUntilExpiry > 0 && (
                <span className={isExpiringSoon ? "text-amber-600 dark:text-amber-400 font-bold ml-1" : ""}>
                  — expires in {minutesUntilExpiry} min
                </span>
              )}
            </div>
          </div>
        </div>

        <button
          onClick={() => setShowDetails(true)}
          className={`text-xs font-medium px-3 py-1.5 rounded hover:opacity-80 transition-opacity ${
            isExpiringSoon
              ? "bg-amber-100 dark:bg-amber-800 text-amber-900 dark:text-amber-50"
              : "bg-blue-100 dark:bg-blue-800 text-blue-900 dark:text-blue-50"
          }`}
        >
          Details
        </button>
      </div>

      <GrantDetailsModal
        isOpen={showDetails}
        onClose={() => setShowDetails(false)}
        grant={grant}
      />
    </>
  );
}
