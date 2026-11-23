// Caregiver Color palette (0111): eight named colours; red, yellow and blue are the ones the owner asked for. The keys match the database check constraint on caregiver_records.profile_color.
export const CAREGIVER_COLORS = [
  { key: "red", label: "Red", fill: "#dc2626", line: "#7f1d1d" },
  { key: "yellow", label: "Yellow", fill: "#facc15", line: "#854d0e" },
  { key: "blue", label: "Blue", fill: "#2563eb", line: "#1e3a8a" },
  { key: "green", label: "Green", fill: "#16a34a", line: "#14532d" },
  { key: "purple", label: "Purple", fill: "#7c3aed", line: "#4c1d95" },
  { key: "orange", label: "Orange", fill: "#ea580c", line: "#7c2d12" },
  { key: "teal", label: "Teal", fill: "#0d9488", line: "#134e4a" },
  { key: "gray", label: "Gray", fill: "#6b7280", line: "#1f2937" },
] as const;
export type CaregiverColorKey = (typeof CAREGIVER_COLORS)[number]["key"];
const BY_KEY = new Map<string, (typeof CAREGIVER_COLORS)[number]>(CAREGIVER_COLORS.map((c) => [c.key, c]));
export const caregiverColor = (key: string | null | undefined) => (key ? BY_KEY.get(key) ?? null : null);

