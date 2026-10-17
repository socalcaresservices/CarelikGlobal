// Appearance preferences (migration 0054): the choices, their labels, and how a chart type is resolved for a kind of data.
// The server stores the choices (agency default, then each person's own); this file only names them and applies them.

export const BACKGROUNDS = ["light", "white", "gray", "dark"] as const;
export const ACCENTS = ["teal", "blue", "indigo", "plum", "rust"] as const;
export const DENSITIES = ["comfortable", "compact"] as const;
export const TEXT_SIZES = ["standard", "large"] as const;
export const CHART_TYPES = ["bar", "line", "donut"] as const;
export const LAYOUTS = ["standard", "minimal"] as const;

export type Background = (typeof BACKGROUNDS)[number];
export type Accent = (typeof ACCENTS)[number];
export type Density = (typeof DENSITIES)[number];
export type TextSize = (typeof TEXT_SIZES)[number];
export type ChartType = (typeof CHART_TYPES)[number];
export type Layout = (typeof LAYOUTS)[number];

export interface AppearanceChoices<T = string> {
  background: Background | T;
  accent: Accent | T;
  density: Density | T;
  textSize: TextSize | T;
  chartType: ChartType | T;
  /** Presentation only: the same information, actions and alerts, with flatter surfaces. */
  layout: Layout | T;
}
/** What is stored at one level: a missing choice means "follow the next level". */
export type PartialAppearance = AppearanceChoices<null>;
export type EffectiveAppearance = AppearanceChoices<never>;

export interface AppearanceState {
  system: EffectiveAppearance;
  organization: PartialAppearance;
  mine: PartialAppearance;
  effective: EffectiveAppearance;
  canSetOrganizationDefaults: boolean;
}

export const SYSTEM_DEFAULTS: EffectiveAppearance = { background: "light", accent: "teal", density: "comfortable", textSize: "standard", chartType: "bar", layout: "standard" };

export const BACKGROUND_LABEL: Record<Background, string> = { light: "Light", white: "White", gray: "Soft gray", dark: "Dark" };
export const ACCENT_LABEL: Record<Accent, string> = { teal: "Teal", blue: "Blue", indigo: "Indigo", plum: "Plum", rust: "Rust" };
export const DENSITY_LABEL: Record<Density, string> = { comfortable: "Comfortable", compact: "Compact" };
export const TEXT_LABEL: Record<TextSize, string> = { standard: "Standard", large: "Large" };
export const CHART_LABEL: Record<ChartType, string> = { bar: "Bar", line: "Line", donut: "Donut" };
export const LAYOUT_LABEL: Record<Layout, string> = { standard: "Standard", minimal: "Minimal" };

/** Swatches for the settings screen only (the live values are CSS variables in styles/theme.css; a test keeps the two in step). */
export const ACCENT_RGB: Record<Accent, { light: [number, number, number]; dark: [number, number, number] }> = {
  teal: { light: [11, 94, 91], dark: [94, 209, 200] },
  blue: { light: [29, 78, 216], dark: [147, 187, 253] },
  indigo: { light: [67, 56, 202], dark: [165, 180, 252] },
  plum: { light: [134, 25, 143], dark: [232, 160, 240] },
  rust: { light: [160, 72, 7], dark: [253, 186, 116] },
};
export const BACKGROUND_SWATCH: Record<Background, string> = { light: "#F4F7F7", white: "#FFFFFF", gray: "#ECEFF3", dark: "#0D141A" };

export const rgbCss = (c: readonly [number, number, number]) => `rgb(${c[0]} ${c[1]} ${c[2]})`;

/**
 * The kinds of data a chart can show, and which chart types are honest for each:
 *   categories  separate groups (hours by service): bar, or donut when the parts make up a whole worth comparing; never line
 *   series      the same measure over time: line or bar; never donut
 * A saved choice that does not fit the data falls back to bar, and the chart says so (see resolveChart).
 */
export type DataShape = "categories" | "parts-of-whole" | "series";

export function allowedChartTypes(shape: DataShape): ChartType[] {
  if (shape === "series") return ["line", "bar"];
  if (shape === "parts-of-whole") return ["donut", "bar"];
  return ["bar"];
}

export function resolveChart(preferred: ChartType, shape: DataShape): { kind: ChartType; note: string | null } {
  const allowed = allowedChartTypes(shape);
  if (allowed.includes(preferred)) return { kind: preferred, note: null };
  const why = preferred === "line" ? "Line charts show change over time, so this data is shown as bars."
    : preferred === "donut" ? "A donut needs parts of one whole, so this data is shown as bars."
    : "This data is shown as bars.";
  return { kind: "bar", note: why };
}

export function toEffective(state: AppearanceState | undefined): EffectiveAppearance {
  return state?.effective ?? SYSTEM_DEFAULTS;
}

/** Puts the effective choices on <html>. Cleared when the shell unmounts so a public page is never themed by a leftover. */
export function applyAppearance(root: HTMLElement, a: EffectiveAppearance) {
  root.setAttribute("data-og-bg", a.background);
  root.setAttribute("data-og-accent", a.accent);
  root.setAttribute("data-og-density", a.density);
  root.setAttribute("data-og-text", a.textSize);
  root.setAttribute("data-og-layout", a.layout);
}
export function clearAppearance(root: HTMLElement) {
  for (const k of ["data-og-bg", "data-og-accent", "data-og-density", "data-og-text", "data-og-layout"]) root.removeAttribute(k);
}

const CACHE_PREFIX = "ogevia.appearance.";
/** The last effective choices, kept per person and agency so the first paint is not a flash of the default. The server is the record. */
export function readCachedAppearance(userId: string | undefined, orgId: string | null): EffectiveAppearance | null {
  if (!userId || !orgId) return null;
  try {
    const raw = window.localStorage.getItem(`${CACHE_PREFIX}${userId}.${orgId}`);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<EffectiveAppearance>;
    return BACKGROUNDS.includes(v.background as Background) && ACCENTS.includes(v.accent as Accent) && DENSITIES.includes(v.density as Density)
      && TEXT_SIZES.includes(v.textSize as TextSize) && CHART_TYPES.includes(v.chartType as ChartType) && LAYOUTS.includes(v.layout as Layout) ? (v as EffectiveAppearance) : null;
  } catch {
    return null; // storage blocked or damaged: the server value still applies
  }
}
export function writeCachedAppearance(userId: string | undefined, orgId: string | null, a: EffectiveAppearance) {
  if (!userId || !orgId) return;
  try {
    window.localStorage.setItem(`${CACHE_PREFIX}${userId}.${orgId}`, JSON.stringify(a));
  } catch {
    /* the choice still applies for this session */
  }
}
