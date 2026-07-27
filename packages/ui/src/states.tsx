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
  /** Optional icon shown above the message - kept optional so every
   * existing text-only EmptyState call site renders unchanged. */
  icon?: ReactNode;
  className?: string;
}

export function EmptyState({ message, action, icon, className }: EmptyStateProps) {
  return (
    <div className={cn("py-4 text-center", className)}>
      {icon ? <div className="mb-2 flex justify-center text-slate-300">{icon}</div> : null}
      <p className="text-sm text-slate-400">{message}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

// Shimmer placeholders for the "we know the shape of the data, we're
// just waiting on it" case - a step up from LoadingState's plain
// "Loading…" text for record headers/lists/cards where a skeleton of
// the eventual layout reads faster than a line of text. Purely
// additive: LoadingState/ErrorState/EmptyState above are untouched, and
// no existing page is switched over to these in this build - they're
// available for the pages this pass touches (and future ones) to opt
// into.
export interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return <div className={cn("animate-pulse rounded-md bg-slate-100", className)} />;
}

export interface SkeletonCardProps {
  lines?: number;
  className?: string;
}

export function SkeletonCard({ lines = 3, className }: SkeletonCardProps) {
  return (
    <div className={cn("rounded-xl border border-slate-200 bg-white p-5", className)} aria-hidden="true">
      <Skeleton className="h-4 w-1/3" />
      <div className="mt-4 space-y-2">
        {Array.from({ length: lines }).map((_, index) => (
          <Skeleton key={index} className="h-3 w-full last:w-2/3" />
        ))}
      </div>
    </div>
  );
}
