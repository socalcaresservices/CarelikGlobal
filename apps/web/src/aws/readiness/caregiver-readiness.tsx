import { useState } from "react";
import { Button, Card } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { actionError } from "./format";
import { AvailabilityRequestForm, CurrentAvailability, RequestHistory } from "./availability-section";
import { useAvailability } from "./queries";
import { AvailabilityReview } from "./availability-review";
import { CaregiverDocuments } from "./documents-readiness";
import { CaregiverServices } from "./service-approvals";
import { CaregiverExperience, MatchingLocation } from "./matching-inputs";
import { MyExperience } from "./my-experience";

/**
 * The caregiver record's readiness sections, each kept separate: Availability, Approved services, Documents.
 * Approved hours are shown apart from pending changes; an administrator can review a request or edit directly
 * (a reason is required and the edit is audited).
 */
export function CaregiverReadiness({ caregiverRecordId }: { caregiverRecordId: string }) {
  const { hasPermission } = useOrganization();
  const q = useAvailability(caregiverRecordId);
  const [editing, setEditing] = useState(false);
  const canSee = hasPermission("availability.read");
  return (
    <>
      {canSee ? (
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-slate-950">Availability</h2>
            {hasPermission("availability.review") ? <Button type="button" variant="secondary" aria-expanded={editing} onClick={() => setEditing((e) => !e)}>{editing ? "Close" : "Edit availability"}</Button> : null}
          </div>
          {q.isLoading ? <p className="mt-2 text-sm text-slate-500">Loading…</p> : null}
          {q.isError ? <p role="alert" className="mt-2 text-sm text-red-700">{actionError(q.error, "Availability could not be loaded.")}</p> : null}
          {q.data ? (
            <div className="mt-2 space-y-4">
              <section aria-label="Approved hours"><h3 className="text-sm font-semibold text-slate-900">Approved</h3><div className="mt-1"><CurrentAvailability state={q.data} /></div></section>
              <section aria-label="Pending changes"><h3 className="text-sm font-semibold text-slate-900">Pending</h3><div className="mt-1"><RequestHistory rows={q.data.pending} /></div></section>
              {editing ? <div className="border-t border-slate-200 pt-3"><p className="mb-2 text-xs text-slate-600">An administrator edit takes effect immediately and is recorded with your reason.</p><AvailabilityRequestForm state={q.data} mode="administrator" /></div> : null}
            </div>
          ) : null}
        </Card>
      ) : null}
      <AvailabilityReview caregiverRecordId={caregiverRecordId} />
      {hasPermission("caregiver_services.read") ? <CaregiverServices caregiverRecordId={caregiverRecordId} /> : null}
      {hasPermission("documents.read") ? <CaregiverDocuments caregiverRecordId={caregiverRecordId} /> : null}
      {hasPermission("matching.read") ? <CaregiverExperience caregiverRecordId={caregiverRecordId} /> : null}
      {hasPermission("matching.manage") ? <MatchingLocation caregiverRecordId={caregiverRecordId} /> : null}
    </>
  );
}

/** A caregiver's own profile sections (read-only): Approved services and Documents. Availability has its own page. */
export function MyReadiness() {
  const { hasPermission } = useOrganization();
  return (
    <>
      {hasPermission("caregiver_services.read_own") ? <CaregiverServices own /> : null}
      {hasPermission("documents.manage_own") ? <CaregiverDocuments /> : null}
      <MyExperience />
    </>
  );
}
