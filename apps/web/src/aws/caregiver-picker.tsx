// One caregiver chooser for every place a person picks a caregiver (reassign a shift, add or edit an assignment, record an outage visit, add a shift).
// Options are listed A-Z by last then first name (case-insensitive, numbers natural), a name shared by another record carries its code, and a list longer than
// FILTER_AFTER gets a "Find a caregiver" box that narrows the options by name or code. It is still a native <select>: it works with a phone's own picker.
import { useMemo, useState } from "react";
import { caregiverName } from "./care-team-admin";
import { nameWithCode } from "./name-label";
import { FILTER_AFTER, sortCaregivers, type PickableCaregiver } from "./caregiver-order";

export function CaregiverPicker<T extends PickableCaregiver>({ id, label, value, onChange, caregivers, placeholder, suffix, className, labelClassName }: {
  id: string;
  label: string;
  value: string;
  onChange: (caregiverRecordId: string) => void;
  caregivers: readonly T[];
  /** The empty choice, e.g. "Choose a caregiver" or "Open shift - fill later". */
  placeholder: string;
  /** Extra text after a caregiver's name, e.g. " - planned: no sign-in yet". */
  suffix?: (caregiver: T) => string;
  className?: string;
  labelClassName?: string;
}) {
  const [query, setQuery] = useState("");
  const sorted = useMemo(() => sortCaregivers(caregivers), [caregivers]);
  const text = (c: T) => `${nameWithCode(caregiverName(c), c.caregiverCode, c.duplicateName)}${suffix ? suffix(c) : ""}`;
  const q = query.trim().toLowerCase();
  const shown = q ? sorted.filter((c) => c.caregiverRecordId === value || `${caregiverName(c)} ${c.caregiverCode ?? ""}`.toLowerCase().includes(q)) : sorted;
  return (
    <div>
      <label htmlFor={id} className={labelClassName ?? "block text-sm font-medium text-slate-700"}>{label}</label>
      {sorted.length > FILTER_AFTER ? (
        <input type="search" aria-label="Find a caregiver" placeholder="Find a caregiver" value={query} onChange={(e) => setQuery(e.target.value)} className={`${className ?? ""} mb-1`} />
      ) : null}
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
        <option value="">{placeholder}</option>
        {shown.map((c) => <option key={c.caregiverRecordId} value={c.caregiverRecordId}>{text(c)}</option>)}
      </select>
      {q && shown.length === 0 ? <p role="status" className="mt-1 text-xs text-slate-600">No caregiver matches that search.</p> : null}
    </div>
  );
}
