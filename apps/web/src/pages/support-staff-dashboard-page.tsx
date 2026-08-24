import { useState } from "react";
import { Card } from "@carelik/ui";
import { useSupportRequestsForStaff, type StaffSupportRequest } from "@/hooks/use-support-access";
import { ProposeAccessModal } from "@/components/propose-access-modal";
import { StaffActiveGrants } from "@/components/staff-active-grants";

export function SupportStaffDashboardPage() {
  const { data: requests, isLoading: requestsLoading } = useSupportRequestsForStaff();
  const [selectedRequest, setSelectedRequest] = useState<StaffSupportRequest | null>(null);
  const [showProposeModal, setShowProposeModal] = useState(false);

  const handleProposeClick = (request: StaffSupportRequest) => {
    setSelectedRequest(request);
    setShowProposeModal(true);
  };

  const handleModalClose = () => {
    setShowProposeModal(false);
    setSelectedRequest(null);
  };

  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Support</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950">
          Support Staff Dashboard
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Review support requests and propose access to help diagnose and fix issues.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <h2 className="text-lg font-semibold text-slate-900 mb-3">
            Support Request Queue
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
                    className="p-4 border-b border-slate-200 dark:border-slate-700 last:border-b-0 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-slate-900 dark:text-slate-50">
                          {request.organization_name}
                        </div>
                        <div className="text-sm font-medium text-slate-700 dark:text-slate-300 mt-1">
                          {request.subject}
                        </div>
                        {request.description && (
                          <div className="text-sm text-slate-600 dark:text-slate-400 mt-1 line-clamp-2">
                            {request.description}
                          </div>
                        )}
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                          <span>{new Date(request.created_at).toLocaleString()}</span>
                          <span className="mx-1">•</span>
                          <span>{request.created_by_email}</span>
                        </div>
                      </div>
                      <button
                        onClick={() => handleProposeClick(request)}
                        className="shrink-0 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
                      >
                        Propose Access
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ) : (
            <Card>
              <p className="text-sm text-slate-500">
                No open support requests at this time.
              </p>
            </Card>
          )}
        </div>

        <div className="lg:col-span-1">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50 mb-3">
            Your Access
          </h2>
          <StaffActiveGrants />
        </div>
      </div>

      {selectedRequest && (
        <ProposeAccessModal
          request={selectedRequest}
          isOpen={showProposeModal}
          onClose={handleModalClose}
        />
      )}
    </section>
  );
}
