// Availability display helpers (pure).
export interface AvailWindow { weekday: number | null; specificDate: string | null; startLocal: string; endLocal: string }
export interface AvailUnavailable { date: string; reason?: string | null }

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function clock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? ":" + String(m).padStart(2, "0") : ""} ${h < 12 ? "AM" : "PM"}`;
}

/** "Mon, Wed 8 AM–5 PM", "Sat 10 PM–6 AM (overnight)"; one line per distinct time range, dated windows last. */
export function describeWindows(windows: AvailWindow[]): string[] {
  const byRange = new Map<string, number[]>();
  const dated: string[] = [];
  for (const w of windows) {
    const range = `${clock(w.startLocal)}–${clock(w.endLocal)}${w.endLocal <= w.startLocal ? " (overnight)" : ""}`;
    if (w.weekday !== null && w.weekday !== undefined) byRange.set(range, [...(byRange.get(range) ?? []), w.weekday]);
    else if (w.specificDate) dated.push(`${w.specificDate} ${range}`);
  }
  const lines = [...byRange.entries()].map(([range, days]) => `${[...new Set(days)].sort((a, b) => a - b).map((d) => DAYS[d]).join(", ")} ${range}`);
  return [...lines, ...dated];
}

export const WEEKDAYS = DAYS;
