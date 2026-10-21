// One control system for the administrator screens (TEST-findings cleanup, items 3 and 4). Built from the existing og-* tokens only, so density, text size,
// background and dark settings keep working. Use these instead of one-off class strings:
//   actionBtn / actionBtnPrimary : every ACTION (Review, Approve, Replace, Save ...). Primary only for the one main action of a row or form.
//   linkClass                    : every NAVIGATION link and every Details/"View all" link (one look: semibold, underlined, link colour).
// Equivalent actions are buttons; navigation is a link. Touch targets are 44 px on coarse pointers and compact on desktop.
const focus = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-accent";
export const linkClass = `inline-flex min-h-[44px] items-center font-semibold text-og-link underline md:min-h-[32px] ${focus}`;
export const actionBtn = `inline-flex min-h-[44px] items-center justify-center rounded-lg border border-og-line px-3 text-sm font-medium text-og-ink hover:bg-og-page disabled:opacity-60 md:min-h-[36px] ${focus}`;
export const actionBtnPrimary = `inline-flex min-h-[44px] items-center justify-center rounded-lg border border-transparent bg-og-accent px-3 text-sm font-medium text-og-on-accent hover:opacity-90 disabled:opacity-60 md:min-h-[36px] ${focus}`;
