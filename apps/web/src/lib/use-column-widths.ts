import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";

// Persists per-table column widths (in pixels) to localStorage, keyed by
// a caller-supplied storage key so each table's widths are independent
// and don't collide with each other. This is purely a per-browser
// display preference - there's no server-side concept of "my preferred
// column width" for this app, so localStorage (rather than a database
// column) is the right place for it.
export type ColumnWidths = Record<string, number>;

const MIN_COLUMN_WIDTH = 60;

function readStoredWidths(storageKey: string, defaults: ColumnWidths): ColumnWidths {
  if (typeof window === "undefined") return defaults;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as ColumnWidths;
    return { ...defaults, ...parsed };
  } catch {
    // Corrupt or inaccessible storage (private browsing, quota, a stale
    // shape from an older version) - fall back to defaults rather than
    // breaking the table over a display preference.
    return defaults;
  }
}

export interface ColumnWidthsControls {
  widths: ColumnWidths;
  startResize: (columnKey: string) => (event: ReactMouseEvent<HTMLDivElement>) => void;
}

export function useColumnWidths(storageKey: string, defaults: ColumnWidths): ColumnWidthsControls {
  const [widths, setWidths] = useState<ColumnWidths>(() => readStoredWidths(storageKey, defaults));

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(widths));
    } catch {
      // Same reasoning as above - resizing still works for this session,
      // it just won't be remembered next time.
    }
  }, [storageKey, widths]);

  function startResize(columnKey: string) {
    return (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = widths[columnKey] ?? defaults[columnKey] ?? 120;

      function handleMouseMove(moveEvent: MouseEvent) {
        const nextWidth = Math.max(MIN_COLUMN_WIDTH, startWidth + (moveEvent.clientX - startX));
        setWidths((current) => ({ ...current, [columnKey]: nextWidth }));
      }
      function handleMouseUp() {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      }
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    };
  }

  return { widths, startResize };
}
