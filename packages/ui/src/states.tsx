import type { ReactNode } from "react";
import { cn } from "./cn";

// The three "nothing to render yet" states every query-backed list/page
// needs, previously each page wrote its own `<p className="text-sm
// text-slate-500">Loading…</p>` / `text-slate-400">No X yet.</p>` /
// `text-red-700">Could not load X.</p>` text inline (team-page.tsx,
// credentials-page.tsx, etc all do this slightly differently). One
// definition keeps the wording pattern and spacing consistent, and
// gives EmptyState room for an action (e.g. "Add a client") without
// every page reinventing that too.

export interface LoadingStateProps {
  label?: string;
  className?: string;
}

export function LoadingState({ label = "Loading…", className }: LoadingStateProps) {
  return <p className={cn("text-sm text-slate-500", className)}>{label}</p>;
}

export interface ErrorStateProps {
  message?: string;
  className?: string;
}

export function ErrorState({ message = "Something went wrong. Try again.", className }: ErrorStateProps) {
  return <p className={cn("text-sm text-red-700", className)}>{message}</p>;
}

export interface EmptyStateProps {
  message: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ message, action, className }: EmptyStateProps) {
  return (
    <div className={cn("py-4 text-center", className)}>
      <p className="text-sm text-slate-400">{message}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
