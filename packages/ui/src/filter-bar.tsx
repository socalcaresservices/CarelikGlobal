import type { ReactNode } from "react";
import { cn } from "./cn";

// FilterChip: one removable "active filter" pill (e.g. "Status: active
// (x)"). Exported standalone too, for pages that want to render their
// own chip row without the rest of FilterBar.
export interface FilterChipProps {
  label: string;
  onRemove: () => void;
}

export function FilterChip({ label, onRemove }: FilterChipProps) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-1 pl-2.5 pr-1.5 text-xs font-medium text-slate-700">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter: ${label}`}
        className="rounded-full p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
      >
        ×
      </button>
    </span>
  );
}

export interface ActiveFilter {
  key: string;
  label: string;
  onRemove: () => void;
}

// One reusable shell for "controls row + active-filter chips + clear
// all", meant to be the single filtering pattern every operational list
// page (Clients, Team, Schedule, Credentials) uses, instead of each
// page inventing its own filter layout. The actual controls (a search
// input, a status <select>, a date range, whatever a given page needs)
// are passed as children - this component only owns the shared
// chip row and layout, not any particular filter's logic.
export interface FilterBarProps {
  children: ReactNode;
  activeFilters?: ActiveFilter[];
  onClearAll?: () => void;
  className?: string;
}

export function FilterBar({ children, activeFilters = [], onClearAll, className }: FilterBarProps) {
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-end gap-2">{children}</div>
      {activeFilters.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {activeFilters.map((filter) => (
            <FilterChip key={filter.key} label={filter.label} onRemove={filter.onRemove} />
          ))}
          {onClearAll ? (
            <button
              type="button"
              onClick={onClearAll}
              className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline"
            >
              Clear all
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
