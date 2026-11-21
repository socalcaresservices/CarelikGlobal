import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { newIdempotencyKey } from "@/lib/sv-backend";
import { formatClockTime, formatNumericDate } from "@/lib/service-verification";
import { useOrganization } from "@/providers/organization-provider";
import { useAwsApi } from "./aws-workspace";
import { TONE } from "./attention";
import { HelpLine } from "./ui/help-line";
import { notificationLabel, useNotifications } from "./notifications";

/** The header's notifications: unread count by word and number, and a short list. Opening an item's page is done from Action needed; nothing here changes an issue. */
export function NotificationsBell() {
  const api = useAwsApi();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useOrganization();
  const q = useNotifications();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!q.data && !q.isError) return null;
  const unread = q.data?.unread ?? 0;
  async function markAll() {
    setError(null);
    try {
      await api.post("/v1/notifications/read", { organizationId: activeOrganizationId }, { idempotencyKey: newIdempotencyKey() });
    } catch {
      setError("Could not mark them as read. Nothing changed; try again.");
    }
    await queryClient.invalidateQueries({ queryKey: ["notifications"] });
  }
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="notifications-panel"
        aria-label={q.isError ? "Notifications unavailable" : `Notifications: ${unread} unread`}
        data-testid="notifications-button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-og-line px-3 text-sm font-semibold text-og-ink hover:bg-og-page md:min-h-[40px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-link"
      >
        Notifications{q.isError ? " unavailable" : <span className="font-og-mono tabular-nums">{unread}</span>}
      </button>
      {open ? (
        <section id="notifications-panel" aria-label="Notifications" className="fixed left-3 right-3 z-30 mt-1 rounded-lg border border-og-line bg-og-card p-2 shadow-lg md:absolute md:left-0 md:right-auto md:w-[22rem]" data-testid="notifications-panel">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-og-ink">{unread > 0 ? `${unread} unread` : "All read"}</p>
            {unread > 0 ? <button type="button" className="inline-flex min-h-[44px] items-center text-sm font-semibold underline md:min-h-[28px]" onClick={() => void markAll()}>Mark all read</button> : null}
          </div>
          {q.isError ? <p role="alert" className="text-sm text-red-700">Notifications could not be loaded. Open Action needed to see everything.</p> : null}
          {q.data && q.data.items.length === 0 ? <p className="text-sm text-og-sub">Nothing new.</p> : null}
          <ul className="max-h-80 divide-y divide-og-line overflow-y-auto">
            {q.data?.items.map((n) => {
              const tone = TONE[n.severity === "critical" ? "red" : "amber"];
              return (
                <li key={n.id} className={`py-1 ${n.state === "unread" ? "" : "text-og-sub"}`} data-testid="notification">
                  <p className="text-sm"><span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${tone.badge}`}>{tone.icon} {tone.word}</span> {notificationLabel(n.reason)}</p>
                  <p className="text-xs text-og-sub">
                    {n.clientCode ? `Client ${n.clientCode} · ` : ""}{formatNumericDate(n.createdAt)} {formatClockTime(n.createdAt)} · {n.state === "resolved" ? "Resolved" : n.state === "read" ? "Read" : "New"}
                  </p>
                </li>
              );
            })}
          </ul>
          {error ? <p role="alert" className="mt-1 text-sm text-red-700">{error}</p> : null}
          <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 border-t border-og-line pt-0.5">
            <Link className="inline-flex min-h-[44px] items-center text-sm font-semibold underline md:min-h-[28px]" to="/action-needed" onClick={() => setOpen(false)}>Open Action needed</Link>
            <HelpLine details="Critical items always notify the staff who can see them. Urgent items follow your agency's setting. Routine items are listed in Action needed and never notify. Nothing is sent by email, text or push.">Urgent items follow your agency&rsquo;s setting.</HelpLine>
          </div>
        </section>
      ) : null}
    </div>
  );
}
