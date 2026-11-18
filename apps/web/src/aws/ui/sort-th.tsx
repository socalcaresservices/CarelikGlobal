// The sortable column heading for useSortedRows (table-sort.ts).
import { ChevronDown, ChevronsUpDown, ChevronUp } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@carelik/ui";
import type { SortDir, SortKind, Sorting } from "./table-sort";

const describe = (kind: SortKind | undefined, dir: SortDir) =>
  kind === "date" ? (dir === "desc" ? "newest first" : "oldest first") : kind === "number" ? (dir === "asc" ? "smallest first" : "largest first") : dir === "asc" ? "A to Z" : "Z to A";

/** A sortable column heading. `aria-sort` tells a screen reader the current order; the button says what a click does. */
export function SortTh<K extends string>({ sort, column, kind, children, className, align = "left" }: { sort: Sorting<K>; column: K; kind?: SortKind; children: ReactNode; className?: string; align?: "left" | "right" }) {
  const active = sort.key === column;
  const Icon = active ? (sort.dir === "asc" ? ChevronUp : ChevronDown) : ChevronsUpDown;
  const nextDir: SortDir = active ? (sort.dir === "asc" ? "desc" : "asc") : kind === "date" ? "desc" : "asc";
  return (
    <th scope="col" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={className}>
      <button
        type="button"
        onClick={() => sort.toggle(column)}
        title={`Sort ${describe(kind, nextDir)}`}
        className={cn("inline-flex min-h-[32px] items-center gap-1 font-semibold uppercase tracking-wide hover:text-og-ink [@media(pointer:coarse)]:min-h-[44px]", align === "right" && "flex-row-reverse")}
      >
        {children}
        <Icon aria-hidden="true" className={cn("h-3.5 w-3.5", active ? "text-og-ink" : "opacity-40")} />
        {active ? <span className="sr-only">, sorted {describe(kind, sort.dir)}</span> : null}
      </button>
    </th>
  );
}

/** A sort control for a heading that holds more than one sortable field (for example Document and Caregiver in one column). */
export function SortButton<K extends string>({ sort, column, kind, children }: { sort: Sorting<K>; column: K; kind?: SortKind; children: ReactNode }) {
  const active = sort.key === column;
  const Icon = active ? (sort.dir === "asc" ? ChevronUp : ChevronDown) : ChevronsUpDown;
  const nextDir: SortDir = active ? (sort.dir === "asc" ? "desc" : "asc") : kind === "date" ? "desc" : "asc";
  return (
    <button type="button" onClick={() => sort.toggle(column)} title={`Sort ${describe(kind, nextDir)}`} aria-pressed={active}
      className="inline-flex min-h-[32px] items-center gap-1 font-semibold uppercase tracking-wide hover:text-og-ink [@media(pointer:coarse)]:min-h-[44px]">
      {children}
      <Icon aria-hidden="true" className={cn("h-3.5 w-3.5", active ? "text-og-ink" : "opacity-40")} />
      {active ? <span className="sr-only">, sorted {describe(kind, sort.dir)}</span> : null}
    </button>
  );
}
