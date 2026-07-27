import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge doesn't know about tailwind.config.ts's custom fontSize
// scale (display/page-title/section-title/card-title/metric/body/
// caption, added in BUILD 001.5 - see typography.tsx) out of the box: by
// default it buckets any unrecognized `text-*` suffix into the
// "text-color" group as a safe fallback, which meant `cn("text-page-
// title text-slate-950")` silently dropped the size class as a false
// "conflict" with the color class. Registering the scale here as its own
// "font-size" group entries fixes that - the two now merge independently
// (a later size wins over an earlier size, a later color wins over an
// earlier color) the way every other Tailwind size/color pair already does.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": ["text-display", "text-page-title", "text-section-title", "text-card-title", "text-metric", "text-body", "text-caption"]
    }
  }
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
