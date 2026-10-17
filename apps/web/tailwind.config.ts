import type { Config } from "tailwindcss";
import colors from "tailwindcss/colors";

// Colour scales read CSS variables (src/styles/theme-scales.css, theme.css) so the saved appearance (background, accent) can change them.
// Light + teal reproduces Tailwind's own values, so nothing changes until someone picks something else.
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
const scale = (family: string) => Object.fromEntries(STEPS.map((s) => [s, `rgb(var(--${family}-${s}) / <alpha-value>)`]));
const token = (name: string) => `rgb(var(--og-${name}) / <alpha-value>)`;

// Spacing: Tailwind's default scale (1=4px, 2=8px, 3=12px, 4=16px,
// 6=24px, 8=32px, ...) is already the 8-point grid docs/design-system.md
// asks for (every step is a multiple of 4px, with the 8px step as the
// base unit) - there's nothing to add here. The convention going forward
// is to stick to that default scale (4/8/12/16/24/32...) instead of
// arbitrary values like `py-[5px]` or `gap-[10px]`, not to invent a
// parallel spacing system.
export default {
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      borderRadius: {
        xl: "0.875rem",
        og: "14px"
      },
      // Light-teal Administrator Home / sidebar palette (owner-approved
      // screenshot). Muted greys that failed 4.5:1 on white were darkened:
      // see docs/product/UX_RESTYLE_HOME_SIDEBAR.md.
      fontFamily: {
        og: ['"Plus Jakarta Sans Variable"', "ui-sans-serif", "system-ui", "-apple-system", '"Segoe UI"', "sans-serif"],
        "og-mono": ['"IBM Plex Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"]
      },
      // Semantic color aliases (BUILD 001.5 foundation layer) for
      // docs/design-system.md's five status tones. These point at the
      // exact same Tailwind families StatusBadge/ProgressBar already
      // hand-pick per tone (emerald/amber/red/sky), so `bg-success-50
      // text-success-700` and `bg-emerald-50 text-emerald-700` render
      // identically - this is additive (existing classNames keep
      // working unchanged), it just gives new components a semantic
      // name instead of a color-family guess.
      colors: {
        success: colors.emerald,
        warning: colors.amber,
        danger: colors.red,
        info: colors.sky,
        slate: scale("slate"),
        red: scale("red"),
        amber: scale("amber"),
        emerald: scale("emerald"),
        sky: scale("sky"),
        indigo: scale("indigo"),
        violet: scale("violet"),
        rose: scale("rose"),
        og: {
          page: token("page"),
          card: token("card"),
          line: token("line"),
          side: token("side"),
          ink: token("ink"),
          sub: token("sub"),
          link: token("accent"),
          accent: token("accent"),
          "on-accent": token("accent-fg"),
          active: "rgb(var(--og-accent) / 0.16)",
          "active-ink": token("accent"),
          worked: token("worked"),
          billable: token("billable"),
          review: token("review"),
          approved: token("approved"),
          ahead: token("ahead"),
          "warn-bg": token("warn-bg"),
          warn: token("warn"),
          zero: token("zero"),
          na: token("zero")
        }
      },
      // Typography scale (BUILD 001.5 foundation layer). Named sizes for
      // the handful of text roles that repeat on every page (see
      // packages/ui/src/typography.tsx) instead of each component
      // re-picking text-2xl/text-3xl/text-sm by feel. Values match what
      // was already in use (PageHeader's title was text-2xl, MetricCard's
      // value was text-3xl, etc) - this names the existing scale, it
      // doesn't change it.
      fontSize: {
        "display": ["1.875rem", { lineHeight: "2.25rem", letterSpacing: "-0.02em", fontWeight: "600" }],
        "page-title": ["1.5rem", { lineHeight: "2rem", letterSpacing: "-0.01em", fontWeight: "600" }],
        "section-title": ["1rem", { lineHeight: "1.5rem", fontWeight: "600" }],
        "card-title": ["0.875rem", { lineHeight: "1.25rem", fontWeight: "600" }],
        "metric": ["1.875rem", { lineHeight: "2.25rem", letterSpacing: "-0.02em", fontWeight: "600" }],
        "body": ["0.875rem", { lineHeight: "1.375rem" }],
        "caption": ["0.75rem", { lineHeight: "1rem" }]
      }
    }
  },
  plugins: []
} satisfies Config;
