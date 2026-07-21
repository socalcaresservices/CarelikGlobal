import type { ReactNode } from "react";
import { cn } from "./cn";

// A labeled group of fields within a larger form - the building block
// the client-form redesign uses to break one long form into named
// sections (Basic Information, Contact Information, Services
// Requested, ...) instead of one continuous column of fields. Columns
// default to a compact 2-up grid on wider screens per the "reduce
// excessive vertical space" goal, collapsing to 1 column on narrow
// ones; pass columns={1} for sections that only make sense full-width
// (e.g. Notes).
export interface FormSectionProps {
  title: string;
  description?: string;
  columns?: 1 | 2 | 3;
  children: ReactNode;
  className?: string;
}

const columnClasses: Record<1 | 2 | 3, string> = {
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
};

export function FormSection({ title, description, columns = 2, children, className }: FormSectionProps) {
  return (
    <fieldset className={cn("border-t border-slate-100 pt-5 first:border-0 first:pt-0", className)}>
      <legend className="w-full pb-3">
        <span className="text-sm font-semibold text-slate-950">{title}</span>
        {description ? <p className="mt-0.5 text-xs text-slate-500">{description}</p> : null}
      </legend>
      <div className={cn("grid gap-3", columnClasses[columns])}>{children}</div>
    </fieldset>
  );
}
