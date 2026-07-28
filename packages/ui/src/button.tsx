import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "./cn";

// Every actionable button in this app was previously a one-off className
// string per call site (compare applicant-detail-page.tsx's "Convert to
// caregiver" button and caregiver-detail-page.tsx's tab buttons - same
// intent, different padding/radius/weight). `buttonVariants` is exported
// separately from `Button` so a caller that needs button *styling* on a
// non-<button> element (e.g. a `<Link>` acting as a button - this
// package deliberately doesn't depend on react-router-dom, see
// metric-card.tsx's comment) can apply the same classes without wrapping
// a real button in a link.
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

// primary reads --color-accent/--color-accent-foreground instead of a
// fixed slate-900 - these CSS custom properties are unset (falling back
// to the slate default baked into the var() call) on any page that
// hasn't opted into branding, and set by app-shell.tsx from the active
// organization's primary_color everywhere an org context exists. Every
// other variant intentionally stays a fixed neutral/semantic color -
// secondary/ghost are chrome, not brand surfaces, and danger is a safety
// color that should read the same regardless of which org's page you're
// on.
const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--color-accent,#0f172a)] text-[var(--color-accent-foreground,#ffffff)] hover:opacity-90 disabled:opacity-40",
  secondary: "border border-slate-200 bg-white text-slate-900 hover:bg-slate-50 disabled:text-slate-400",
  ghost: "text-slate-600 hover:bg-slate-100 disabled:text-slate-300",
  danger: "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300"
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1.5 text-xs",
  md: "px-3.5 py-2 text-body"
};

export interface ButtonVariantOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string | undefined;
}

export function buttonVariants({ variant = "primary", size = "md", className }: ButtonVariantOptions = {}) {
  return cn(
    "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed",
    variantClasses[variant],
    sizeClasses[size],
    className
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner in place of `icon` and disables the button. */
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, icon, className, children, disabled, type = "button", ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonVariants({ variant, size, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
      ) : (
        icon
      )}
      {children}
    </button>
  );
});
