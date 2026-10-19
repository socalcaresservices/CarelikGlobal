// The four alert destinations (migration 0056): Needs attention now | Upcoming staffing | Documents & compliance (documents-page.tsx) | Visit review.
// Each page reads the same server classification as the Home tiles, so a number on a tile is the number of rows here.
import { Link } from "react-router-dom";
import { formatClockTime, formatDuration, formatNumericDate } from "@/lib/service-verification";
import { itemTone, rankedItems, REASON_LABEL, TONE, URGENT_WINDOW_HOURS, useAttentionOverview, type Tone, type UpcomingShift, type UrgentItem } from "./attention";
import { Disclosure } from "./ui/disclosure";
import { PageHeader } from "./ui/page-header";
import { StatusChip } from "./ui/status-chip";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const COMPLIANCE_REASONS = new Set(["compliance_hold", "documents_not_current", "in_progress_on_hold"]);
const UPCOMING_REASON: Record<UpcomingShift["reason"], string> = {
  open: "No caregiver", called_out: "Called out", compliance_hold: "Caregiver on a compliance hold", documents_not_current: "A required document is not current",
};
const weekday = (iso: string) => new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "America/Los_Angeles" }).format(new Date(iso));

function Loading({ q }: { q: { isLoading: boolean; isError: boolean; error: unknown } }) {
  if (q.isLoading) return <p className="text-sm text-og-sub">Loading…</p>;
  if (q.isError) return <p role="alert" className="text-sm text-red-700">This list could not be loaded. Reload the page to try again.</p>;
  return null;
}

function UrgentRow({ item, asOf }: { item: UrgentItem; asOf: number }) {
  const tone = itemTone(item, asOf);
  const t = TONE[tone];
  const what = item.kind === "shift" ? "Shift" : "Visit";
  const who = [item.clientCode, item.serviceCode].filter(Boolean).join(" · ");
  const compliance = item.reasons.some((r) => COMPLIANCE_REASONS.has(r));
  const link = "inline-flex min-h-[44px] items-center font-semibold text-og-link underline md:min-h-[32px]";
  return (
    <li className={`rounded-og border border-og-line border-l-4 bg-og-card px-3 py-2 ${tone === "red" ? "border-l-red-700" : "border-l-amber-600"}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <StatusChip tone={tone}>{t.word}</StatusChip>
        <p className="text-sm font-semibold text-og-ink">{what}{who ? ` · ${who}` : ""}</p>
        <p className="text-sm text-og-sub">{item.inProgress ? "Running now" : `${formatNumericDate(item.startsAt)} ${formatClockTime(item.startsAt)}`}</p>
      </div>
      <p className="mt-0.5 text-sm text-og-ink">
        {item.reasons.map((r, n) => <span key={r}>{n > 0 ? " · " : ""}<span>{REASON_LABEL[r] ?? r}</span></span>)}
      </p>
      <p className="flex flex-wrap gap-x-4 text-sm">
        <Link className={link} to={item.kind === "visit" ? `/visits/${item.id}` : "/schedule"}>
          {item.kind === "visit" ? "Open visit" : "Open schedule"}
        </Link>
        {compliance ? (
          <Link className={link} to={item.caregiverRecordId ? `/care-team/${item.caregiverRecordId}` : "/compliance"}>
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
      <PageHeader title="Needs attention now" lead={`Care that starts or is running within ${hours} hours and is blocked or at risk.`} action={<Link className="inline-flex min-h-[44px] items-center font-semibold text-og-link underline md:min-h-[32px]" to="/action-needed" data-testid="all-actions-link">Everything that needs action</Link>} />
      <Loading q={q} />
      {q.data && !u ? <p className="text-sm text-og-sub">Your role does not include this list.</p> : null}
      {u ? (
        <>
          <p className="text-sm text-og-ink" data-testid="urgent-summary">
            <span className="font-semibold">{plural(u.itemCount, "item")}</span>
            {u.issueCount !== u.itemCount ? <span className="text-og-sub"> · {plural(u.issueCount, "issue")} in total</span> : null}
          </p>
          {u.items.length === 0 ? <p className="rounded-og border border-og-line bg-og-card p-4 text-sm text-og-sub">Nothing starting in the next {hours} hours is at risk.</p> : (
            <ul className="space-y-2">{rankedItems(u.items, Date.parse(q.data!.asOf)).map((i) => <UrgentRow key={`${i.kind}-${i.id}`} item={i} asOf={Date.parse(q.data!.asOf)} />)}</ul>
          )}
        </>
      ) : null}
      <Disclosure summary="How this list is chosen">
        <p>An item is a shift or a visit, counted once even when it has several issues. Critical means care is blocked or at risk now (an uncovered shift is Critical once it has started); Urgent means a risk within the next {hours} hours. Shifts after the first {hours} hours are under Upcoming staffing. The {hours}-hour window is the owner's decision D10.</p>
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
      <PageHeader title="Upcoming staffing" lead={`Shifts more than ${q.data?.urgentWindowHours ?? URGENT_WINDOW_HOURS} hours away that need a caregiver or have a blocked one.`}
        action={<Link className="inline-flex min-h-[44px] items-center rounded-lg bg-og-accent px-4 text-sm font-semibold text-og-on-accent hover:opacity-90 md:min-h-[40px]" to="/schedule">Open schedule</Link>} />
      <Loading q={q} />
      {q.data?.pickups && q.data.pickups.count > 0 ? (
        <p data-testid="pickup-requests-link" className="rounded-og border border-og-line bg-og-card p-3 text-sm text-og-ink">
          {plural(q.data.pickups.count, "caregiver request")} for open shifts {q.data.pickups.count === 1 ? "is" : "are"} waiting for you to confirm. Nobody is assigned until you do.{" "}
          <Link className="font-semibold underline" to="/schedule">Review requests</Link>
        </p>
      ) : null}
      {q.data?.reconciliation && q.data.reconciliation.count > 0 ? (
        <p data-testid="reconcile-link" className="rounded-og border border-og-line bg-og-card p-3 text-sm text-og-ink">
          {plural(q.data.reconciliation.count, "shift")} ended with no visit record and {q.data.reconciliation.count === 1 ? "still holds" : "still hold"} {formatDuration(q.data.reconciliation.minutes)} of authorization. Nothing is released until you decide.{" "}
          <Link className="font-semibold underline" to="/schedule">Reconcile shifts</Link>
        </p>
      ) : null}
      {q.data?.amendmentImpacts && q.data.amendmentImpacts.count > 0 ? (
        <p data-testid="amendment-impacts-link" className="rounded-og border border-og-line bg-og-card p-3 text-sm text-og-ink">
          {plural(q.data.amendmentImpacts.count, "item")} affected by an authorization change {q.data.amendmentImpacts.count === 1 ? "needs" : "need"} your review.{" "}
          <Link className="font-semibold underline" to="/authorization-impacts">Review changes</Link>
        </p>
      ) : null}
      {q.data && !u ? <p className="text-sm text-og-sub">Your role does not include this list.</p> : null}
      {u ? (
        u.shifts.length === 0 ? <p className="rounded-og border border-og-line bg-og-card p-4 text-sm text-og-sub">Every upcoming shift has a caregiver who may work it.</p> : (
          <div className="space-y-4">
            <p className="text-sm font-semibold text-og-ink" data-testid="staffing-summary">{plural(u.count, "shift")}</p>
            {byDay(u.shifts).map(([day, items]) => (
              <section key={day} aria-label={day}>
                <h2 className="text-sm font-bold text-og-ink">{weekday(items[0]!.startsAt)} {day}</h2>
                <ul className="mt-1 divide-y divide-og-line rounded-og border border-og-line bg-og-card">
                  {items.map((s) => (
                    <li key={s.shiftId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
                      <span className="text-og-ink">{formatClockTime(s.startsAt)}–{formatClockTime(s.endsAt)} · {[s.clientCode, s.serviceName ?? s.serviceCode].filter(Boolean).join(" · ")}</span>
                      <StatusChip tone="neutral">{UPCOMING_REASON[s.reason] ?? s.reason}</StatusChip>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {u.count > u.shifts.length ? <p className="text-xs text-og-sub">Showing the next {u.shifts.length} of {u.count}. Open the schedule for the rest.</p> : null}
          </div>
        )
      ) : null}
      <Disclosure summary="About this list">
        <p>Shifts {q.data?.urgentWindowHours ?? URGENT_WINDOW_HOURS} hours away or less are under Needs attention now.</p>
      </Disclosure>
    </div>
  );
}

/**
 * Visit review. "Needs a decision" is what the tile counts: administrator review (from the moment it starts, Urgent after 24 hours), a late answer, and
 * a client confirmation more than 48 hours overdue. Pending Confirmation (inside 48 hours) and Ready for Approval are routine: listed apart, never added.
 */
export function VisitQueuePage() {
  const q = useAttentionOverview();
  const v = q.data?.visitReview;
  const exceptions = "/service-verification/reports?view=exceptions";
  type Row = { label: string; count: number; to: string; chip?: { tone: Tone; word: string } | undefined };
  const decide: Row[] = v ? [
    { label: "In review", count: v.needsReview, to: exceptions },
    ...((v.reviewOverdue ?? 0) > 0 ? [{ label: "Review waiting 24 hours or more", count: v.reviewOverdue ?? 0, to: exceptions, chip: { tone: "amber" as Tone, word: "Urgent" } }] : []),
    // A late answer is a visit in administrator review (visits.read counts it), so it opens the exceptions list that lists it. /billing-review needs billing.visits.read,
    // which the people who see this count may not have, and it lists only a date range of billing states.
    { label: "Late answers to accept or reject", count: v.lateResponses, to: exceptions },
    { label: "Client confirmation overdue (over 48 hours)", count: v.confirmationOverdue ?? 0, to: exceptions, chip: (v.confirmationOverdue ?? 0) > 0 ? { tone: "amber" as Tone, word: "Overdue" } : undefined },
  ] : [];
  const routine: Row[] = v ? [
    { label: "Pending client confirmation (under 48 hours)", count: v.pendingConfirmation ?? Math.max(v.awaitingConfirmation - (v.confirmationOverdue ?? 0), 0), to: exceptions },
    ...(v.readyForApproval !== null ? [{ label: "Ready for billing approval", count: v.readyForApproval, to: "/billing-review" }] : []),
  ] : [];
  const list = (rows: Row[]) => (
    <ul className="divide-y divide-og-line rounded-og border border-og-line bg-og-card">
      {rows.map((r) => (
        <li key={r.label}>
          <Link to={r.to} className="flex min-h-[48px] items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-og-page focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-og-link">
            <span className="text-og-ink">{r.label}</span>
            <span className="flex items-center gap-2">
              {r.chip && r.count > 0 ? <StatusChip tone={r.chip.tone}>{r.chip.word}</StatusChip> : null}
              <span className="font-og-mono text-lg font-semibold tabular-nums text-og-ink">{r.count}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="space-y-4">
      <PageHeader title="Visit review" lead="Visits waiting for a person's decision, and routine follow-up kept apart." />
      <Loading q={q} />
      {q.data && !v ? <p className="text-sm text-og-sub">Your role does not include this list.</p> : null}
      {v ? (
        <>
          <p className="text-sm text-og-ink" data-testid="visit-summary">
            <span className="font-semibold">Visits needing attention: {v.visitsNeedingAttention}</span>
            {v.reviewIssues > 0 ? <span className="text-og-sub"> · Issues: {v.reviewIssues}</span> : null}
          </p>
          <section aria-label="Needs a decision" className="space-y-1.5">
            <h2 className="text-sm font-bold text-og-ink">Needs a decision</h2>
            {list(decide)}
          </section>
          <section aria-label="Routine follow-up" className="space-y-1.5">
            <h2 className="text-sm font-bold text-og-ink">Routine follow-up <span className="font-normal text-og-sub">(not counted above)</span></h2>
            {list(routine)}
          </section>
          <Disclosure summary="About these counts">
            <p>Each visit is counted once. "Needs a decision" is a visit in administrator review, a late answer, or a confirmation more than 48 hours overdue; review waiting 24 hours or more is marked Urgent. Pending confirmation and Ready for billing approval are routine follow-up and are never added to that number or to Needs attention now. "Issues" counts every reason on a visit that needs review, so it can be larger than the number of visits. {v.awaitingResponse > 0 ? `${plural(v.awaitingResponse, "visit")} in review ${v.awaitingResponse === 1 ? "has" : "have"} a request sent to the client and ${v.awaitingResponse === 1 ? "is" : "are"} shown as a reminder, not counted. ` : ""}Approval is not submission.</p>
          </Disclosure>
        </>
      ) : null}
    </div>
  );
}
