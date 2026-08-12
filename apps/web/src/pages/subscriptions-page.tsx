import { Card, PageHeader } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { PlatformPlanManager } from "@/components/platform-plan-manager";

// Platform-only plan catalog editor. Split out of OrganizationsPage
// (OGEVIA SaaS structure refactor, increment 2) - PlatformPlanManager
// has no per-organization dependency at all (it manages the global
// plan_definitions catalog, not any one tenant's row), so it never
// belonged embedded inside the organization registry in the first
// place. This is exactly the "Subscriptions / Plans" platform nav
// destination the spec calls for, distinct from "Organizations".
export function SubscriptionsPage() {
  const { isPlatformOwner } = useOrganization();

  if (!isPlatformOwner) {
    return (
      <section className="mx-auto max-w-4xl">
        <Card>
          <p className="text-sm font-medium text-slate-500">Platform Administration</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-950">Not available</h2>
          <p className="mt-3 text-slate-600">Only the platform owner can manage subscription plans.</p>
        </Card>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-6xl space-y-6 pb-12">
      <PageHeader
        eyebrow="Platform Administration"
        title="Subscriptions & plans"
        description="The plan catalog every organization subscribes from - versioned, never edited in place. An organization's own current plan and billing status are on its row in Organizations."
      />

      <PlatformPlanManager />
    </section>
  );
}
