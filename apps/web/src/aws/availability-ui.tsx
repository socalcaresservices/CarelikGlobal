// Shared availability display for the caregiver request page and the administrator review card.
import { describeWindows, type AvailUnavailable, type AvailWindow } from "./availability-format";

export function AvailabilitySummary({ windows, unavailable, empty = "None recorded" }: { windows: AvailWindow[]; unavailable: AvailUnavailable[]; empty?: string }) {
  const lines = describeWindows(windows);
  return (
    <div className="text-sm text-slate-800">
      {lines.length ? <ul className="space-y-0.5">{lines.map((l) => <li key={l}>{l}</li>)}</ul> : <p className="text-slate-500">{empty}</p>}
      {unavailable.length ? <p className="mt-1 text-xs text-slate-600">Not available: {unavailable.map((u) => u.date).join(", ")}</p> : null}
    </div>
  );
}
