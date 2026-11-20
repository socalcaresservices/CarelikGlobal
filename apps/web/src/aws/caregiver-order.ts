import type { Caregiver } from "./care-team-admin";

// Order and size rules for the shared caregiver picker (caregiver-picker.tsx).
export const FILTER_AFTER = 8;
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export type PickableCaregiver = Pick<Caregiver, "caregiverRecordId" | "firstName" | "lastName" | "preferredName" | "caregiverCode" | "duplicateName">;

export function sortCaregivers<T extends Pick<Caregiver, "firstName" | "lastName">>(rows: readonly T[]): T[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => collator.compare(a.row.lastName ?? "", b.row.lastName ?? "") || collator.compare(a.row.firstName ?? "", b.row.firstName ?? "") || a.i - b.i)
    .map((x) => x.row);
}

