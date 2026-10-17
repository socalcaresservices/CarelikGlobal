// The four alert destinations (migration 0054): Needs attention now | Upcoming staffing | Documents & compliance (documents-page.tsx) | Visit review.
// Each page reads the same server classification as the Home tiles, so a number on a tile is the number of rows here.
import { Link } from "react-router-dom";
import { formatClockTime, formatNumericDate } from "@/lib/service-verification";
import { REASON_LABEL, TONE, URGENT_WINDOW_HOURS, useAttentionOverview, type UpcomingShift, type UrgentItem } from "./attention";
import { Disclosure } from "./ui/disclosure";
import { PageHeader } from "./ui/page-header";
import { StatusChip } from "./ui/status-chip";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const COMPLIANCE_REASONS = new Set(["compliance_hold", "documents_not_current", "in_progress_on_hold"]);
const weekday = (iso: string) => new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "America/Los_Angeles" }).format(new Date(iso));

function Loading({ q }: { q: { isLoading: boolean; isError: boolean; error: unknown } }) {
  if (q.isLoading) return <p className="text-sm text-og-sub">Loading…</p>;
  if (q.isError) return <p role="alert" className="text-sm text-red-700">{(q.error as Error).message}</p>;
  return null;
}

function UrgentRow({ item }: { item: UrgentItem }) {
  const tone = item.severity;
  const t = TONE[tone];
  const what = item.kind === "shift" ? "Shift" : "Visit";
  const who = [item.clientCode, item.serviceCode].filter(Boolean).join(" · ");
  const compliance = item.reasons.some((r) => COMPLIANCE_REASONS.has(r));
  return (
    <li className={`rounded-og border border-og-line border-l-4 bg-og-card p-3 ${tone === "red" ? "border-l-red-700" : "border-l-amber-600"}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusChip tone={tone}>{t.word}</StatusChip>
        <p className="text-sm font-semibold text-og-ink">{what}{who ? ` · ${who}` : ""}</p>
        <p className="text-sm text-og-sub">{item.inProgress ? "Running now" : `${formatNumericDate(item.startsAt)} ${formatClockTime(item.startsAt)}`}</p>
      </div>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-sm text-og-ink">
        {item.reasons.map((r) => <li key={r}>{REASON_LABEL[r] ?? r}</li>)}
      </ul>
      <p className="mt-1.5 flex flex-wrap gap-x-4 text-sm">
        <Link className="inline-flex min-h-[44px] items-center font-semibold text-og-link underline md:min-h-[32px]" to={item.kind === "visit" ? `/visits/${item.id}` : "/schedule"}>
          {item.kind === "visit" ? "Open visit" : "Open schedule"}
        </Link>
        {compliance ? (
          <Link className="inline-flex min-h-[44px] items-center font-semibold text-og-link underline md:min-h-[32px]" to={item.caregiverRecordId ? `/care-team/${item.caregiverRecordId}` : "/compliance"}>
            Review compliance record
          </Link>
        ) : null}
      </p>
    </li>
  );
}

/** Starting or running within the urgent window. One row per shift or visit, however many issues it has. */
export function NeedsAttentionPage() {
  const q = useAttentionOverview();
  const u = q.data?.urgent;
  const hours = q.data?.urgentWindowHours ?? URGENT_WINDOW_HOURS;
  return (
    <div className="space-y-4">
      <PageHeader title="Needs attention now" lead={`Care that starts or is running within ${hours} hours and is blocked or at risk.`} />
      <Loading q={q} />
      {q.data && !u ? <p className="text-sm text-og-sub">Your role does not include this list.</p> : null}
      {u ? (
        <>
          <p className="text-sm text-og-ink" data-testid="urgent-summary">
            <span className="font-semibold">{plural(u.itemCount, "item")}</span>
            {u.issueCount !== u.itemCount ? <span className="text-og-sub"> · {plural(u.issueCount, "issue")} in total</span> : null}
          </p>
          {u.items.length === 0 ? <p className="rounded-og border border-og-line bg-og-card p-4 text-sm text-og-sub">Nothing starting in the next {hours} hours is at risk.</p> : (
            <ul className="space-y-2">{u.items.map((i) => <UrgentRow key={`${i.kind}-${i.id}`} item={i} />)}</ul>
          )}
        </>
      ) : null}
      <Disclosure summary="How this list is chosen">
        <p>An item is a shift or a visit, counted once even when it has several issues. Red means care is blocked or at risk now; amber means a risk is approaching. Shifts after the first {hours} hours are under Upcoming staffing. The {hours}-hour window is a provisional setting awaiting owner review.</p>
      </Disclosure>
    </div>
  );
}

function byDay(shifts: UpcomingShift[]) {
  const days = new Map<string, UpcomingShift[]>();
  for (const s of shifts) {
    const key = formatNumericDate(s.startsAt);
    days.set(key, [...(days.get(key) ?? []), s]);
  }
  return [...days.entries()];
}

/** Uncovered shifts later than the urgent window, by date. */
export function UpcomingStaffingPage() {
  const q = useAttentionOverview();
  const u = q.data?.upcoming;
  return (
    <div className="space-y-4">
      <PageHeader title="Upcoming staffing" lead={`Shifts after the next ${q.data?.urgentWindowHours ?? URGENT_WINDOW_HOURS} hours that still need a caregiver.`}
        action={<Link className="inline-flex min-h-[44px] items-center rounded-lg bg-og-accent px-4 text-sm font-semibold text-white hover:opacity-90 md:min-h-[40px]" to="/schedule">Open schedule</Link>} />
      <Loading q={q} />
      {q.data && !u ? <p className="text-sm text-og-sub">Your role does not include this list.</p> : null}
      {u ? (
        u.shifts.length === 0 ? <p className="rounded-og border border-og-line bg-og-card p-4 text-sm text-og-sub">Every upcoming shift has a caregiver.</p> : (
          <div className="space-y-4">
            <p className="text-sm font-semibold text-og-ink" data-testid="staffing-summary">{plural(u.count, "uncovered shift")}</p>
            {byDay(u.shifts).map(([day, items]) => (
              <section key={day} aria-label={day}>
                <h2 className="text-sm font-bold text-og-ink">{weekday(items[0]!.startsAt)} {day}</h2>
                <ul className="mt-1 divide-y divide-og-line rounded-og border border-og-line bg-og-card">
                  {items.map((s) => (
                    <li key={s.shiftId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
                      <span className="text-og-ink">{formatClockTime(s.startsAt)}–{formatClockTime(s.endsAt)} · {[s.clientCode, s.serviceName ?? s.serviceCode].filter(Boolean).join(" · ")}</span>
                      <StatusChip tone="neutral">{s.reason === "called_out" ? "Called out" : "No caregiver"}</StatusChip>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {u.count > u.shifts.length ? <p className="text-xs text-og-sub">Showing the next {u.shifts.length} of {u.count}. Open the schedule for the rest.</p> : null}
          </div>
        )
      ) : null}
    </div>
  );
}

/** Visits waiting for confirmation or for a person's decision. Every row is a unique visit; issues are counted apart. */
export function VisitQueuePage() {
  const q = useAttentionOverview();
  const v = q.data?.visitReview;
  const exceptions = "/service-verification/reports?view=exceptions";
  const rows: { label: string; count: number; to: string }[] = v ? [
    { label: "Awaiting client confirmation", count: v.awaitingConfirmation, to: exceptions },
    { label: "Needs review", count: v.needsReview, to: exceptions },
    { label: "Late answers to accept or reject", count: v.lateResponses, to: "/billing-review" },
    ...(v.readyForApproval !== null ? [{ label: "Ready for billing approval", count: v.readyForApproval, to: "/billing-review" }] : []),
  ] : [];
  return (
    <div className="space-y-4">
      <PageHeader title="Visit review" lead="Visits waiting for a confirmation or a person's decision." />
      <Loading q={q} />
      {q.data && !v ? <p className="text-sm text-og-sub">Your role does not include this list.</p> : null}
      {v ? (
        <>
          <p className="text-sm text-og-ink" data-testid="visit-summary">
            <span className="font-semibold">Visits needing attention: {v.visitsNeedingAttention}</span>
            {v.reviewIssues > 0 ? <span className="text-og-sub"> · Issues: {v.reviewIssues}</span> : null}
          </p>
          <ul className="divide-y divide-og-line rounded-og border border-og-line bg-og-card">
            {rows.map((r) => (
              <li key={r.label}>
                <Link to={r.to} className="flex min-h-[48px] items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-og-page focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-og-link">
                  <span className="text-og-ink">{r.label}</span>
                  <span className="font-og-mono text-lg font-semibold tabular-nums text-og-ink">{r.count}</span>
                </Link>
              </li>
            ))}
          </ul>
          <Disclosure summary="About these counts">
            <p>Each visit is counted once, in the one group that matches its status. "Issues" counts every reason on a visit that needs review, so it can be larger than the number of visits. {v.awaitingResponse > 0 ? `${plural(v.awaitingResponse, "visit")} already ${v.awaitingResponse === 1 ? "has" : "have"} a confirmation request out and ${v.awaitingResponse === 1 ? "is" : "are"} waiting for the answer. ` : ""}Ready for billing approval is not billed or submitted.</p>
          </Disclosure>
        </>
      ) : null}
    </div>
  );
}
