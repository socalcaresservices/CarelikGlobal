import { useState } from "react";
import { Card, StatusBadge } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import {
  useSupportRequests,
  useSupportAccessGrants,
  useRevokeSupportAccess,
} from "@/hooks/use-support-access";
import { ReportIssueModal } from "@/components/report-issue-modal";
import { ApproveAccessModal } from "@/components/approve-access-modal";

export function SupportRequestsPage() {
  const { activeOrganizationId, activeOrganization } = useOrganization();
  const { data: requests, isLoading: requestsLoading } = useSupportRequests(activeOrganizationId);
  const { data: grants } = useSupportAccessGrants(activeOrganizationId);
  const revoke = useRevokeSupportAccess(activeOrganizationId);

  const [showReportModal, setShowReportModal] = useState(false);
  const [selectedGrantForApproval, setSelectedGrantForApproval] = useState<string | null>(null);

  if (!activeOrganizationId) {
    return (
      <Card>
        <p className="text-sm text-slate-600">No organization selected.</p>
      </Card>
    );
  }

  const pendingGrant = grants?.find((g) => g.status === "pending_approval");
  const selectedGrant = grants?.find((g) => g.id === selectedGrantForApproval);

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Support</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950">
          {activeOrganization?.displayName ?? "Support Requests"}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Report issues to Ogevia support and manage access to your organization's data.
        </p>
      </div>

      {/* Pending approval section */}
      {pendingGrant && (
        <Card className="border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="font-semibold text-amber-900 dark:text-amber-100">
                Support Access Pending Review
              </h2>
              <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">
                {pendingGrant.grantee_email} has requested{" "}
                <strong>
                  {pendingGrant.access_level === "read_only" ? "Read-Only" : "Edit"}
                </strong>{" "}
                access to help with: "{pendingGrant.reason}"
              </p>
            </div>
            <button
              onClick={() => setSelectedGrantForApproval(pendingGrant.id)}
              className="ml-4 px-3 py-1.5 bg-amber-100 dark:bg-amber-800 text-amber-900 dark:text-amber-50 text-sm font-medium rounded hover:opacity-80 transition-opacity"
            >
              Review
            </button>
          </div>
        </Card>
      )}

      {/* Active grants section */}
      {grants && grants.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-3">
            Active Support Access
          </h2>
          <Card>
            <div className="space-y-3">
              {grants
                .filter((g) => g.status === "active")
                .map((grant) => {
                  const expiresAt = grant.expires_at ? new Date(grant.expires_at) : null;
                  const now = new Date();
                  const minutesUntilExpiry = expiresAt
                    ? Math.round((expiresAt.getTime() - now.getTime()) / 60000)
                    : 0;

                  return (
                    <div
                      key={grant.id}
                      className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800 rounded"
                    >
                      <div className="flex-1">
                        <div className="text-sm font-medium text-slate-900 dark:text-slate-50">
                          {grant.grantee_email}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                          <StatusBadge
                            label={grant.access_level === "read_only" ? "Read-Only" : "Edit"}
                            tone={grant.access_level === "edit" ? "warning" : "neutral"}
                          />
                          <span className="ml-2">
                            Expires in {minutesUntilExpiry} min
                            {minutesUntilExpiry <= 15 && (
                              <span className="text-amber-600 dark:text-amber-400 ml-1 font-bold">
                                (expiring soon)
                              </span>
                            )}
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => revoke.mutate(grant.id)}
                        disabled={revoke.isPending}
                        className="ml-4 px-3 py-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 text-sm font-medium rounded transition-colors"
                      >
                        Revoke
                      </button>
                    </div>
                  );
                })}
            </div>
          </Card>
        </div>
      )}

      {/* Support requests section */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
            Support Requests
          </h2>
          <button
            onClick={() => setShowReportModal(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
          >
            + Report Issue
          </button>
        </div>

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
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                        {request.subject}
                      </div>
                      {request.description && (
                        <div className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                          {request.description}
                        </div>
                      )}
                      <div className="mt-2 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                        <span>{new Date(request.created_at).toLocaleString()}</span>
                        <span>•</span>
                        <span>{request.created_by_email}</span>
                      </div>
                    </div>
                    <StatusBadge
                      label={request.status.replace(/_/g, " ")}
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
            <p className="text-sm text-slate-500">
              No support requests yet. Report an issue to get help from Ogevia support.
            </p>
          </Card>
        )}
      </div>

      {/* Modals */}
      <ReportIssueModal
        organizationId={activeOrganizationId}
        isOpen={showReportModal}
        onClose={() => setShowReportModal(false)}
      />

      {selectedGrant && (
        <ApproveAccessModal
          organizationId={activeOrganizationId}
          grant={selectedGrant}
          isOpen={!!selectedGrantForApproval}
          onClose={() => setSelectedGrantForApproval(null)}
        />
      )}
    </section>
  );
}
