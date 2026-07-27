import type { HTMLAttributes } from "react";
import { cn } from "./cn";

// Formalizes the heading/body text classNames every page has been
// hand-writing slightly differently (PageHeader's title is
// `text-2xl font-semibold tracking-tight text-slate-950`, SectionCard's
// title is `font-semibold text-slate-950` with no size class at all,
// MetricCard's value is `text-3xl font-semibold tracking-tight`, ...).
// These wrap the named sizes tailwind.config.ts's `fontSize` scale adds
// (display/page-title/section-title/card-title/metric/body/caption) so
// new UI reaches for one of these instead of re-guessing a text-* class.
// Existing components (PageHeader, SectionCard, MetricCard, ...) are
// deliberately left as-is here - retrofitting every existing heading is
// the "refactor everything" pass this build is not doing; these are for
// new work (and any page opting in as it's touched).

type HeadingProps = HTMLAttributes<HTMLHeadingElement>;
type ParagraphProps = HTMLAttributes<HTMLParagraphElement>;
type SpanProps = HTMLAttributes<HTMLSpanElement>;

export function PageTitle({ className, ...props }: HeadingProps) {
  return <h1 className={cn("text-page-title text-slate-950", className)} {...props} />;
}

export function SectionTitle({ className, ...props }: HeadingProps) {
  return <h2 className={cn("text-section-title text-slate-950", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HeadingProps) {
  return <h3 className={cn("text-card-title text-slate-950", className)} {...props} />;
}

export function MetricText({ className, ...props }: SpanProps) {
  return <span className={cn("text-metric tabular-nums text-slate-950", className)} {...props} />;
}

export function BodyText({ className, ...props }: ParagraphProps) {
  return <p className={cn("text-body text-slate-700", className)} {...props} />;
}

export function Caption({ className, ...props }: ParagraphProps) {
  return <p className={cn("text-caption text-slate-500", className)} {...props} />;
}

export function HelperText({ className, ...props }: ParagraphProps) {
  return <p className={cn("text-caption text-slate-400", className)} {...props} />;
}

export function ValidationText({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p role="alert" className={cn("text-caption font-medium text-red-600", className)} {...props} />;
}
