import { PageHeader } from "@carelik/ui";
import { useOrganization } from "@/providers/organization-provider";
import { ActionCenter } from "@/components/action-center";
import { OperationalSnapshot } from "@/components/operational-snapshot";
import { OwnerInsights } from "@/components/owner-insights";

// The Command Center replaces the old "Overview" page. Same route (/),
// same data, same permission gating - what changed is the read order
// and the framing: "what needs attention" leads, followed by one
// compact snapshot row, instead of three stacked card grids (several of
// which were all-zero on a quiet day) under a generic "Overview" label
// and engineering-phase copy in the header above it (see app-shell.tsx).
// See docs/design-system.md for why nothing new is fabricated here -
// this build only reorganizes what already existed.
//
// OwnerInsights was formerly its own page at /owner-dashboard
// ("Workforce Insights" in the sidebar) - folded in here so an owner
// gets the full money/coverage/compliance/growth picture in one place
// instead of navigating between two separate dashboard pages. It
// internally returns null for anyone who isn't organization_owner/
// platform_owner, same gate the old page used, so this is a no-op for
// every other role.
export function CommandCenterPage() {
  const { activeOrganization } = useOrganization();

  return (
    <section className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        eyebrow="Command Center"
        title={activeOrganization?.displayName ?? "Ogevia"}
        description="What needs attention, and how things stand right now."
      />

      <ActionCenter />

      <OperationalSnapshot />

      <OwnerInsights />
    </section>
  );
}
