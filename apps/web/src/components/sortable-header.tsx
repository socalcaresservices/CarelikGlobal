import { ChevronDown, ChevronsUpDown, ChevronUp } from "lucide-react";
import type { SortDirection } from "@/lib/use-table-controls";

interface SortableHeaderProps {
  label: string;
  active: boolean;
  direction: SortDirection;
  onClick: () => void;
}

export function SortableHeader({ label, active, direction, onClick }: SortableHeaderProps) {
  const Icon = active ? (direction === "asc" ? ChevronUp : ChevronDown) : ChevronsUpDown;
  return (
    <th className="pb-2 font-medium">
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-slate-500 hover:text-slate-800"
      >
        {label}
        <Icon className={active ? "h-3.5 w-3.5 text-slate-700" : "h-3.5 w-3.5 text-slate-300"} />
      </button>
    </th>
  );
}
