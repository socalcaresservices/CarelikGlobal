import {
  correctedTimeValue,
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

function describe(value: Date | string) {
  return `${formatVisitDate(value)}, ${formatClockTime(value)}`;
}

function minutesBetween(start: Date | string, end: Date | string) {
  return Math.floor((new Date(end).getTime() - new Date(start).getTime()) / 60_000);
}

/** The parsed instant of an entry, or null while it is incomplete or impossible. */
function instantOf(value: PacificWallTime) {
  const parsed = pacificWallTimeToDate(value);
  return parsed.ok ? parsed.value : null;
}

// One Pacific-time entry: date, hour, minute and an explicit AM/PM. Every
// control is named "<label> date/hour/minute" so two entries on one form
// (Time In and Time Out) stay distinguishable to screen readers and tests.
export function PacificDateTimeInputs({
  label,
  value,
  onChange,
}: {
  label: string;
  value: PacificWallTime;
  onChange: (next: PacificWallTime) => void;
}) {
  const selectClass =
    "mt-1 block min-h-11 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-900";
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium text-slate-700">
        {label} (Pacific time)
      </legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="col-span-2 block text-xs text-slate-600 sm:col-span-1">
          Date
          <input
            type="date"
            aria-label={`${label} date`}
            value={value.date}
            onChange={(event) => onChange({ ...value, date: event.target.value })}
            className={selectClass}
          />
        </label>
        <label className="block text-xs text-slate-600">
          Hour
          <select
            aria-label={`${label} hour`}
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
            aria-label={`${label} minute`}
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
          aria-label={`${label} AM or PM`}
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
    </fieldset>
  );
}

// Manager entry of an actual Time Out (missed clock-out), with the resulting
// Time In → Time Out and worked duration spelled out before saving.
// Validation messages are the caller's.
export function PacificTimeOutField({
  timeIn,
  value,
  onChange,
}: {
  timeIn: string;
  value: PacificWallTime;
  onChange: (next: PacificWallTime) => void;
}) {
  const timeOut = instantOf(value);
  const workedMinutes = timeOut ? minutesBetween(timeIn, timeOut) : null;
  return (
    <div className="space-y-2">
      <PacificDateTimeInputs label="Time Out" value={value} onChange={onChange} />
      <dl
        aria-label="Time Out summary"
        className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-white p-2 text-xs text-slate-700"
      >
        <dt className="text-slate-500">Time In</dt>
        <dd>{describe(timeIn)}</dd>
        <dt className="text-slate-500">Time Out</dt>
        <dd>{timeOut ? describe(timeOut) : "—"}</dd>
        <dt className="text-slate-500">Duration</dt>
        <dd className="font-semibold">
          {workedMinutes !== null && workedMinutes > 0 ? formatDuration(workedMinutes) : "—"}
        </dd>
      </dl>
    </div>
  );
}

// Manager correction of a signed or reviewed visit: corrected Time In and
// Time Out in Pacific time, shown next to the original record.
export function PacificCorrectionFields({
  originalTimeIn,
  originalTimeOut,
  timeIn,
  timeOut,
  onTimeInChange,
  onTimeOutChange,
}: {
  originalTimeIn: string;
  originalTimeOut: string | null;
  timeIn: PacificWallTime;
  timeOut: PacificWallTime;
  onTimeInChange: (next: PacificWallTime) => void;
  onTimeOutChange: (next: PacificWallTime) => void;
}) {
  // Same rule as saving: a time left as it was keeps its stored instant
  // (with seconds), so an unchanged form previews the original duration.
  const resolvedIn = correctedTimeValue(timeIn, originalTimeIn);
  const resolvedOut = correctedTimeValue(timeOut, originalTimeOut);
  const newIn = resolvedIn.ok ? resolvedIn.value : instantOf(timeIn);
  const newOut = resolvedOut.ok ? resolvedOut.value : instantOf(timeOut);
  const newMinutes = newIn && newOut ? minutesBetween(newIn, newOut) : null;
  const originalMinutes = originalTimeOut ? minutesBetween(originalTimeIn, originalTimeOut) : null;
  const changedTime = (resolvedIn.ok && resolvedIn.iso !== originalTimeIn) || (resolvedOut.ok && resolvedOut.iso !== originalTimeOut);
  const hasSeconds = (iso: string | null) => !!iso && new Date(iso).getTime() % 60_000 !== 0;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <PacificDateTimeInputs label="Corrected Time In" value={timeIn} onChange={onTimeInChange} />
        <PacificDateTimeInputs label="Corrected Time Out" value={timeOut} onChange={onTimeOutChange} />
      </div>
      <dl
        aria-label="Correction summary"
        className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-white p-2 text-xs text-slate-700"
      >
        <dt className="text-slate-500">Original</dt>
        <dd>
          {describe(originalTimeIn)} → {originalTimeOut ? describe(originalTimeOut) : "—"}
          {originalTimeOut ? ` (${formatDuration(minutesBetween(originalTimeIn, originalTimeOut))})` : ""}
        </dd>
        <dt className="text-slate-500">Corrected</dt>
        <dd className="font-semibold">
          {newIn ? describe(newIn) : "—"} → {newOut ? describe(newOut) : "—"}
          {newMinutes !== null && newMinutes > 0 ? ` (${formatDuration(newMinutes)})` : ""}
          {!changedTime ? " · unchanged" : ""}
        </dd>
      </dl>
      {changedTime && (hasSeconds(originalTimeIn) || hasSeconds(originalTimeOut)) && newMinutes !== null && originalMinutes !== null ? (
        <p className="text-xs text-slate-600">
          The original times were recorded to the second; a time you change is saved at the exact minute
          you choose, and a time you leave alone keeps its seconds. Durations count whole minutes, so the
          corrected duration can differ by a minute from the clock times shown.
        </p>
      ) : null}
    </div>
  );
}
