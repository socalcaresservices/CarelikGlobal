import {
  formatClockTime,
  formatDuration,
  formatVisitDate,
  pacificWallTimeToDate,
  type Meridiem,
  type PacificWallTime,
} from "@/lib/service-verification";
import { cn } from "@carelik/ui";

const HOURS = Array.from({ length: 12 }, (_, index) => index + 1);
const MINUTES = Array.from({ length: 60 }, (_, index) => index);

// Manager entry of an actual Time Out, in Pacific time: date, hour, minute
// and an explicit AM/PM, with the resulting Time In → Time Out and worked
// duration spelled out before saving. Validation messages are the caller's.
export function PacificTimeOutField({
  idPrefix,
  timeIn,
  value,
  onChange,
}: {
  idPrefix: string;
  timeIn: string;
  value: PacificWallTime;
  onChange: (next: PacificWallTime) => void;
}) {
  const parsed = pacificWallTimeToDate(value);
  const workedMinutes = parsed.ok
    ? Math.floor((parsed.value.getTime() - new Date(timeIn).getTime()) / 60_000)
    : null;
  const selectClass =
    "mt-1 block min-h-11 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-900";

  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium text-slate-700">
        Actual Time Out (Pacific time)
      </legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="col-span-2 block text-xs text-slate-600 sm:col-span-1">
          Date
          <input
            id={`${idPrefix}-date`}
            type="date"
            value={value.date}
            onChange={(event) => onChange({ ...value, date: event.target.value })}
            className={selectClass}
          />
        </label>
        <label className="block text-xs text-slate-600">
          Hour
          <select
            value={value.hour ?? ""}
            onChange={(event) =>
              onChange({ ...value, hour: event.target.value ? Number(event.target.value) : null })
            }
            className={selectClass}
          >
            <option value="">--</option>
            {HOURS.map((hour) => (
              <option key={hour} value={hour}>
                {hour}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-slate-600">
          Minute
          <select
            value={value.minute ?? ""}
            onChange={(event) =>
              onChange({ ...value, minute: event.target.value ? Number(event.target.value) : null })
            }
            className={selectClass}
          >
            <option value="">--</option>
            {MINUTES.map((minute) => (
              <option key={minute} value={minute}>
                {String(minute).padStart(2, "0")}
              </option>
            ))}
          </select>
        </label>
        <div
          role="radiogroup"
          aria-label="AM or PM"
          className="col-span-2 flex items-end gap-1 sm:col-span-4"
        >
          {(["AM", "PM"] as Meridiem[]).map((meridiem) => (
            <button
              key={meridiem}
              type="button"
              role="radio"
              aria-checked={value.meridiem === meridiem}
              onClick={() => onChange({ ...value, meridiem })}
              className={cn(
                "min-h-11 flex-1 rounded-lg border text-sm font-semibold",
                value.meridiem === meridiem
                  ? "border-indigo-600 bg-indigo-600 text-white"
                  : "border-slate-300 bg-white text-slate-700",
              )}
            >
              {meridiem}
            </button>
          ))}
        </div>
      </div>
      <dl
        aria-label="Time Out summary"
        className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-white p-2 text-xs text-slate-700"
      >
        <dt className="text-slate-500">Time In</dt>
        <dd>
          {formatVisitDate(timeIn)}, {formatClockTime(timeIn)}
        </dd>
        <dt className="text-slate-500">Time Out</dt>
        <dd>
          {parsed.ok
            ? `${formatVisitDate(parsed.value)}, ${formatClockTime(parsed.value)}`
            : "—"}
        </dd>
        <dt className="text-slate-500">Duration</dt>
        <dd className="font-semibold">
          {workedMinutes !== null && workedMinutes > 0 ? formatDuration(workedMinutes) : "—"}
        </dd>
      </dl>
    </fieldset>
  );
}
