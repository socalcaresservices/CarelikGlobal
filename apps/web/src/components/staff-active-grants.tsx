import { useState } from "react";
import { Card, StatusBadge } from "@carelik/ui";
import { useStaffActiveGrants, useSupportAccessAudit, type StaffSupportGrant } from "@/hooks/use-support-access";

function GrantAuditModal({
  isOpen,
  onClose,
  grant,
}: {
  isOpen: boolean;
  onClose: () => void;
  grant: StaffSupportGrant;
}) {
  const { data: auditEntries } = useSupportAccessAudit(isOpen ? grant.id : null);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-lg max-w-3xl w-full mx-4 p-6 max-h-[80vh] overflow-y-auto">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-4">
          Audit Log: {grant.organization_name}
        </h2>

        <div className="mb-6 pb-4 border-b border-slate-200 dark:border-slate-700">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-slate-500 dark:text-slate-400">Organization</div>
              <div className="text-slate-900 dark:text-slate-50 font-medium">
                {grant.organization_name}
              </div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">Access Level</div>
              <div className="text-slate-900 dark:text-slate-50 font-medium">
                {grant.access_level === "read_only" ? "Read-Only" : "Edit"}
              </div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">Status</div>
              <div className="text-slate-900 dark:text-slate-50 font-medium">
                {grant.status}
              </div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">Approved At</div>
              <div className="text-slate-900 dark:text-slate-50 font-medium">
                {grant.approved_at
                  ? new Date(grant.approved_at).toLocaleString()
                  : "Pending"}
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <h3 className="font-semibold text-slate-900 dark:text-slate-50 mb-3">
            Activity
          </h3>
          {auditEntries && auditEntries.length > 0 ? (
            <div className="space-y-2">
              {auditEntries.map((entry) => (
                <div
                  key={entry.id}
                  className="p-3 bg-slate-50 dark:bg-slate-800 rounded text-sm"
                >
                  <div className="flex items-start justify-between mb-1">
                    <div className="font-medium text-slate-900 dark:text-slate-50">
                      {entry.event_type}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {new Date(entry.created_at).toLocaleString()}
                    </div>
                  </div>
                  {entry.resource_type && (
                    <div className="text-xs text-slate-600 dark:text-slate-400">
                      {entry.resource_type}
                      {entry.action && ` · ${entry.action}`}
                    </div>
                  )}
                  {entry.reason && (
                    <div className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                      Reason: {entry.reason}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-slate-500 dark:text-slate-400">
              No audit entries yet
            </div>
          )}
        </div>

        <button
          onClick={onClose}
          className="mt-6 px-4 py-2 bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-50 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  );
}

export function StaffActiveGrants() {
  const { data: grants, isLoading } = useStaffActiveGrants();
  const [selectedGrantId, setSelectedGrantId] = useState<string | null>(null);

  const selectedGrant = grants?.find((g) => g.id === selectedGrantId);

  if (isLoading) {
    return (
      <Card>
        <p className="text-sm text-slate-500">Loading active grants...</p>
      </Card>
    );
  }

  if (!grants || grants.length === 0) {
    return (
      <Card>
        <p className="text-sm text-slate-500">
          No active grants. Submit an access request from the queue above.
        </p>
      </Card>
    );
  }

  const activeGrants = grants.filter((g) => g.status === "active");
  const pendingGrants = grants.filter((g) => g.status === "pending_approval");

  return (
    <div className="space-y-6">
      {pendingGrants.length > 0 && (
        <div>
          <h3 className="font-semibold text-slate-900 dark:text-slate-50 mb-3">
            Pending Approval ({pendingGrants.length})
          </h3>
          <Card className="border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20">
            <div className="space-y-2">
              {pendingGrants.map((grant) => (
                <div
                  key={grant.id}
                  className="flex items-center justify-between p-3 bg-white dark:bg-slate-800 rounded"
                >
                  <div className="flex-1">
                    <div className="font-medium text-slate-900 dark:text-slate-50">
                      {grant.organization_name}
                    </div>
                    <div className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                      <StatusBadge
                        label={grant.access_level === "read_only" ? "Read-Only" : "Edit"}
                        tone={grant.access_level === "edit" ? "warning" : "neutral"}
                      />
                      <span className="ml-2 text-slate-500 dark:text-slate-400">
                        Awaiting org owner approval
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {activeGrants.length > 0 && (
        <div>
          <h3 className="font-semibold text-slate-900 dark:text-slate-50 mb-3">
            Active Access ({activeGrants.length})
          </h3>
          <Card>
            <div className="space-y-3">
              {activeGrants.map((grant) => {
                const expiresAt = grant.expires_at ? new Date(grant.expires_at) : null;
                const now = new Date();
                const minutesUntilExpiry = expiresAt
                  ? Math.round((expiresAt.getTime() - now.getTime()) / 60000)
                  : 0;
                const isExpiringSoon = minutesUntilExpiry > 0 && minutesUntilExpiry <= 15;

                return (
                  <div
                    key={grant.id}
                    className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800 rounded"
                  >
                    <div className="flex-1">
                      <div className="font-medium text-slate-900 dark:text-slate-50">
                        {grant.organization_name}
                      </div>
                      <div className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                        <StatusBadge
                          label={grant.access_level === "read_only" ? "Read-Only" : "Edit"}
                          tone={grant.access_level === "edit" ? "warning" : "neutral"}
                        />
                        <span className={`ml-2 ${isExpiringSoon ? "text-amber-600 dark:text-amber-400 font-bold" : ""}`}>
                          Expires in {minutesUntilExpiry} min
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => setSelectedGrantId(grant.id)}
                      className="px-3 py-1.5 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 rounded transition-colors"
                    >
                      Audit Log
                    </button>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      )}

      {selectedGrant && (
        <GrantAuditModal
          isOpen={!!selectedGrantId}
          onClose={() => setSelectedGrantId(null)}
          grant={selectedGrant}
        />
      )}
    </div>
  );
}
