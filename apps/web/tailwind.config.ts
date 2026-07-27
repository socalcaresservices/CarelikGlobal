import type { Config } from "tailwindcss";
import colors from "tailwindcss/colors";

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
        xl: "0.875rem"
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
        info: colors.sky
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
