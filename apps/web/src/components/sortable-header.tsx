import { ChevronDown, ChevronsUpDown, ChevronUp } from "lucide-react";
import type { MouseEvent } from "react";
import type { SortDirection } from "@/lib/use-table-controls";
import { ColumnResizeHandle } from "@/components/resizable-th";

interface SortableHeaderProps {
  label: string;
  active: boolean;
  direction: SortDirection;
  onClick: () => void;
  width?: number | undefined;
  onResizeStart?: (event: MouseEvent<HTMLDivElement>) => void;
}

export function SortableHeader({
  label,
  active,
  direction,
  onClick,
  width,
  onResizeStart
}: SortableHeaderProps) {
  const Icon = active ? (direction === "asc" ? ChevronUp : ChevronDown) : ChevronsUpDown;
  return (
    <th
      className="relative pb-2 pr-3 font-medium"
      style={width ? { width, minWidth: width, maxWidth: width } : undefined}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-slate-500 hover:text-slate-800"
      >
        {label}
        <Icon className={active ? "h-3.5 w-3.5 text-slate-700" : "h-3.5 w-3.5 text-slate-300"} />
      </button>
      {onResizeStart ? <ColumnResizeHandle label={label} onMouseDown={onResizeStart} /> : null}
    </th>
  );
}
