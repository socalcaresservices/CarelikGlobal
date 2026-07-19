import type { MouseEvent } from "react";

// Shared drag handle used by both SortableHeader and PlainHeader below -
// a thin strip on the right edge of a <th> that resizes the column when
// dragged. Only rendered when the caller passes onResizeStart, so
// non-resizable header cells (rare, but there are a couple of unlabeled
// action columns) are unaffected.
export function ColumnResizeHandle({
  label,
  onMouseDown
}: {
  label: string;
  onMouseDown: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column`}
      onMouseDown={onMouseDown}
      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize touch-none select-none hover:bg-slate-300"
    />
  );
}

interface PlainHeaderProps {
  label: string;
  width?: number | undefined;
  onResizeStart?: (event: MouseEvent<HTMLDivElement>) => void;
  align?: "left" | "right";
}

// A header cell for a column that isn't sortable but should still be
// resizable, matching SortableHeader's sizing/handle behavior.
export function PlainHeader({ label, width, onResizeStart, align = "left" }: PlainHeaderProps) {
  return (
    <th
      className={`relative pb-2 text-xs font-medium uppercase tracking-wide text-slate-500 ${
        align === "right" ? "text-right" : "text-left"
      }`}
      style={width ? { width, minWidth: width, maxWidth: width } : undefined}
    >
      {label}
      {onResizeStart ? <ColumnResizeHandle label={label} onMouseDown={onResizeStart} /> : null}
    </th>
  );
}
