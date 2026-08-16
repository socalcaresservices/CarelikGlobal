import { Link } from "react-router-dom";
import { CalendarClock, PenLine } from "lucide-react";
import { Card } from "@carelik/ui";

export function StaffVisitsPage() {
  return (
    <section className="mx-auto max-w-xl space-y-5 px-4 py-6 pb-24">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-accent,#4f46e5)]">
          My visits
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950">Scheduled visits</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Your agency manages visit scheduling. Contact an administrator when a visit needs to be added or changed.
        </p>
      </div>

      <Card className="rounded-2xl p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100">
            <CalendarClock className="h-5 w-5 text-slate-700" />
          </span>
          <div>
            <h2 className="font-semibold text-slate-950">Ready for your scheduled visit?</h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Open Shift Verification, enter the client code, and Ogevia will show the scheduled service available to you today.
            </p>
          </div>
        </div>
      </Card>

      <Link
        to="/service-verification"
        className="flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-[var(--color-accent,#4f46e5)] px-4 text-base font-semibold text-white shadow-sm hover:opacity-95"
      >
        <PenLine className="h-5 w-5" />
        Open Shift Verification
      </Link>
    </section>
  );
}
