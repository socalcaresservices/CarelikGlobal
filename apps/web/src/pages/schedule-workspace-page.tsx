import { VisitVerificationShareCard } from "@/components/visit-verification-share-card";
import { useOrganization } from "@/providers/organization-provider";
import { SchedulePage } from "./schedule-page";

export function ScheduleWorkspacePage() {
  const { hasPermission } = useOrganization();

  return (
    <>
      {hasPermission("visits.manage") ? (
        <section className="mx-auto mb-6 max-w-4xl">
          <VisitVerificationShareCard />
        </section>
      ) : null}
      <SchedulePage />
    </>
  );
}
