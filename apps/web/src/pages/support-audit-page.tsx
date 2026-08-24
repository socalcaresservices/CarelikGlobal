import { useState } from "react";
import { Card, StatusBadge } from "@carelik/ui";
import { useSupportRequestsForStaff, useStaffActiveGrants, type Organization } from "@/hooks/use-support-access";
import { GrantEmergencyAccessModal } from "@/components/grant-emergency-access-modal";

export function SupportAuditPage() {
  const { data: requests, isLoading: requestsLoading } = useSupportRequestsForStaff();
  const { data: grants, isLoading: grantsLoading } = useStaffActiveGrants();
  const [showEmergencyModal, setShowEmergencyModal] = useState(false);
  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(null);

  const openRequests = requests?.filter((r) => r.status === "open") ?? [];
  const inReviewRequests = requests?.filter((r) => r.status === "in_review") ?? [];
  const activeGrants = grants?.filter((g) => g.status === "active") ?? [];
  const pendingGrants = grants?.filter((g) => g.status === "pending_approval") ?? [];

  const handleEmergencyAccess = (org: Organization) => {
    setSelectedOrg(org);
    setShowEmergencyModal(true);
  };

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Support Admin</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950">
          Support Audit Dashboard
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Monitor support requests, access grants, and grant emergency access when needed.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/20 dark:to-blue-800/20">
          <div className="text-sm text-blue-700 dark:text-blue-300">Open Requests</div>
          <div className="text-3xl font-bold text-blue-900 dark:text-blue-100 mt-1">
            {openRequests.length}
          </div>
        </Card>

        <Card className="bg-gradient-to-br from-amber-50 to-amber-100 dark:from-amber-900/20 dark:to-amber-800/20">
          <div className="text-sm text-amber-700 dark:text-amber-300">In Review</div>
          <div className="text-3xl font-bold text-amber-900 dark:text-amber-100 mt-1">
            {inReviewRequests.length}
          </div>
        </Card>

        <Card className="bg-gradient-to-br from-green-50 to-green-100 dark:from-green-900/20 dark:to-green-800/20">
          <div className="text-sm text-green-700 dark:text-green-300">Active Grants</div>
          <div className="text-3xl font-bold text-green-900 dark:text-green-100 mt-1">
            {activeGrants.length}
          </div>
        </Card>

        <Card className="bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-800/20">
          <div className="text-sm text-purple-700 dark:text-purple-300">Pending Approval</div>
          <div className="text-3xl font-bold text-purple-900 dark:text-purple-100 mt-1">
            {pendingGrants.length}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-3">
            Support Requests
          </h2>

          {requestsLoading ? (
            <Card>
              <p className="text-sm text-slate-500">Loading requests...</p>
            </Card>
          ) : requests && requests.length > 0 ? (
            <Card>
              <div className="space-y-3">
                {requests.map((request) => (
                  <div
                    key={request.id}
                    className="p-3 border-b border-slate-200 dark:border-slate-700 last:border-b-0"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-slate-900 dark:text-slate-50">
                          {request.organization_name}
                        </div>
                        <div className="text-sm text-slate-700 dark:text-slate-300 mt-1">
                          {request.subject}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                          {new Date(request.created_at).toLocaleString()}
                        </div>
                      </div>
                      <StatusBadge
                        label={request.status}
                        tone={
                          request.status === "open"
                            ? "neutral"
                            : request.status === "in_review"
                              ? "warning"
                              : "success"
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ) : (
            <Card>
              <p className="text-sm text-slate-500">No support requests</p>
            </Card>
          )}
        </div>

        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-3">
            Access Grants
          </h2>

          {grantsLoading ? (
            <Card>
              <p className="text-sm text-slate-500">Loading grants...</p>
            </Card>
          ) : grants && grants.length > 0 ? (
            <Card>
              <div className="space-y-3">
                {grants.slice(0, 10).map((grant) => {
                  const expiresAt = grant.expires_at ? new Date(grant.expires_at) : null;
                  const now = new Date();
                  const minutesUntilExpiry = expiresAt
                    ? Math.round((expiresAt.getTime() - now.getTime()) / 60000)
                    : 0;

                  return (
                    <div
                      key={grant.id}
                      className="p-3 border-b border-slate-200 dark:border-slate-700 last:border-b-0"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-slate-900 dark:text-slate-50">
                            {grant.organization_name}
                          </div>
                          <div className="text-xs text-slate-600 dark:text-slate-400 mt-1">
                            <StatusBadge
                              label={grant.access_level === "read_only" ? "Read-Only" : "Edit"}
                              tone={grant.access_level === "edit" ? "warning" : "neutral"}
                            />
                            {grant.status === "active" && minutesUntilExpiry > 0 && (
                              <span className="ml-2 text-slate-500">
                                Expires in {minutesUntilExpiry} min
                              </span>
                            )}
                          </div>
                        </div>
                        <StatusBadge
                          label={grant.status}
                          tone={
                            grant.status === "active"
                              ? "success"
                              : grant.status === "pending_approval"
                                ? "warning"
                                : "neutral"
                          }
                        />
                      </div>
                    </div>
                  );
                })}
                {grants.length > 10 && (
                  <div className="text-xs text-slate-500 dark:text-slate-400 pt-2 border-t border-slate-200 dark:border-slate-700">
                    Showing 10 of {grants.length} grants
                  </div>
                )}
              </div>
            </Card>
          ) : (
            <Card>
              <p className="text-sm text-slate-500">No access grants</p>
            </Card>
          )}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-3">
          Emergency Access
        </h2>
        <Card className="border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20">
          <div className="space-y-4">
            <div>
              <h3 className="font-semibold text-red-900 dark:text-red-100 mb-2">
                ⚠️ Break-Glass Access
              </h3>
              <p className="text-sm text-red-800 dark:text-red-200 mb-4">
                Grant immediate read-only access for one hour without subscriber approval. Use only for critical system issues. All actions are logged.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                Search Organization
              </label>
              <input
                type="text"
                placeholder="Enter organization name or slug..."
                className="w-full px-3 py-2 border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-50 placeholder-slate-400 dark:placeholder-slate-500"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    // In a real implementation, this would search and show results
                    const value = e.currentTarget.value;
                    const org = requests?.find((r) =>
                      r.organization_name.toLowerCase().includes(value.toLowerCase())
                    );
                    if (org) {
                      handleEmergencyAccess({
                        id: org.organization_id,
                        display_name: org.organization_name,
                        slug: "",
                      });
                    }
                  }
                }}
              />
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Press Enter to search
              </div>
            </div>

            <div className="bg-slate-100 dark:bg-slate-800 rounded p-3">
              <div className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">
                Recent Organizations:
              </div>
              <div className="space-y-1">
                {requests
                  ?.slice(0, 3)
                  .map((r) => (
                    <button
                      key={r.organization_id}
                      onClick={() =>
                        handleEmergencyAccess({
                          id: r.organization_id,
                          display_name: r.organization_name,
                          slug: "",
                        })
                      }
                      className="block w-full text-left text-sm px-2 py-1 text-blue-600 dark:text-blue-400 hover:bg-slate-200 dark:hover:bg-slate-700 rounded"
                    >
                      {r.organization_name}
                    </button>
                  ))}
              </div>
            </div>
          </div>
        </Card>
      </div>

      {selectedOrg && (
        <GrantEmergencyAccessModal
          organization={selectedOrg}
          isOpen={showEmergencyModal}
          onClose={() => {
            setShowEmergencyModal(false);
            setSelectedOrg(null);
          }}
        />
      )}
    </section>
  );
}
