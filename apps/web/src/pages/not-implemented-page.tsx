import { Card } from "@carelik/ui";

export function NotImplementedPage({ title }: { title: string }) {
  return (
    <section className="mx-auto max-w-4xl">
      <Card>
        <p className="text-sm font-medium text-slate-500">Foundation module</p>
        <h2 className="mt-1 text-2xl font-semibold text-slate-950">{title}</h2>
        <p className="mt-3 text-slate-600">
          The database and security primitives are included in this build. The operational
          management interface is scheduled for the next foundation increment.
        </p>
      </Card>
    </section>
  );
}
