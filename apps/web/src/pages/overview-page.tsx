import { Card } from "@carelik/ui";

const foundationItems = [
  ["Authentication", "Supabase session lifecycle and protected routes"],
  ["Multi-tenancy", "Organization membership and tenant isolation"],
  ["RBAC", "Role and permission primitives with RLS enforcement"],
  ["Audit", "Immutable operational audit trail"],
  ["Events", "Transactional outbox for asynchronous workflows"],
  ["Storage", "Tenant-scoped document metadata and storage policies"]
];

export function OverviewPage() {
  return (
    <section className="mx-auto max-w-6xl space-y-6">
      <div>
        <p className="text-sm font-medium text-slate-500">Platform status</p>
        <h2 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">
          Foundation control plane
        </h2>
        <p className="mt-2 max-w-3xl text-slate-600">
          The first build establishes the security, tenancy, configuration, and event
          infrastructure required by every operational module.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {foundationItems.map(([title, description]) => (
          <Card key={title}>
            <h3 className="font-semibold text-slate-950">{title}</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>
          </Card>
        ))}
      </div>
    </section>
  );
}
