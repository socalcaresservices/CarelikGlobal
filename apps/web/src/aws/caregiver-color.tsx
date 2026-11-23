// Caregiver Color: one named colour per caregiver (0111), chosen by an administrator, shown as a small swatch beside the name. It identifies a person on a list, the schedule and a chart; it never replaces the name,
// never replaces a shift's status colour, and is independent of office and county. Yellow has a dark outline so it stays visible on a light background.
import { CAREGIVER_COLORS, caregiverColor } from "./caregiver-colors";

/** A small outlined swatch. Renders nothing when the caregiver has no colour. The colour name is its accessible label (the name beside it is always shown too). */
export function ColorSwatch({ color, className = "" }: { color: string | null | undefined; className?: string }) {
  const c = caregiverColor(color);
  if (!c) return null;
  return <span role="img" aria-label={`Caregiver Color: ${c.label}`} title={`Caregiver Color: ${c.label}`} data-testid="caregiver-swatch" data-color={c.key}
    className={`inline-block h-3.5 w-3.5 shrink-0 rounded-full align-middle ${className}`} style={{ backgroundColor: c.fill, border: `2px solid ${c.line}` }} />;
}

/** The picker: a radio group of named swatches plus "No color". Saves through `onChange`. */
export function CaregiverColorPicker({ value, onChange, disabled }: { value: string | null; onChange: (key: string | null) => void; disabled?: boolean }) {
  return (
    <fieldset className="space-y-1" disabled={disabled}>
      <legend className="text-sm font-medium text-slate-700">Caregiver Color</legend>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Caregiver Color">
        {CAREGIVER_COLORS.map((c) => (
          <label key={c.key} className={`inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm md:min-h-[32px] ${value === c.key ? "border-slate-900 bg-slate-100 font-semibold" : "border-slate-200"}`}>
            <input type="radio" name="caregiver-color" value={c.key} checked={value === c.key} onChange={() => onChange(c.key)} className="sr-only" />
            <ColorSwatch color={c.key} /> {c.label}
          </label>
        ))}
        <label className={`inline-flex min-h-[44px] cursor-pointer items-center rounded-lg border px-3 text-sm md:min-h-[32px] ${value === null ? "border-slate-900 bg-slate-100 font-semibold" : "border-slate-200"}`}>
          <input type="radio" name="caregiver-color" value="" checked={value === null} onChange={() => onChange(null)} className="sr-only" /> No color
        </label>
      </div>
    </fieldset>
  );
}

