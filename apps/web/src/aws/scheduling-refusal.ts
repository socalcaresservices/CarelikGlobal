// When the server refuses a scheduling change, the person sees its sentence (written for display, never an identifier) plus one plain next step, so a refusal
// is never a dead end. The server's sentence is kept word for word; only a "What to do" line is added, and only for refusals we recognise. An unrecognised message
// is shown unchanged. A request that never reached the server says that nothing was saved. Used by every scheduling form (add shift, assign, change time, make-up,
// call-out, cancel, pick up).

const NEXT_STEPS: Array<[RegExp, string]> = [
  [/already has a shift at that time/i, "Pick another time, or choose a different caregiver."],
  [/already on this shift/i, "Choose a different caregiver, or close this form if the shift is already covered."],
  [/called out of this shift/i, "Choose someone else for this shift."],
  [/was just filled|no longer scheduled/i, "Refresh the schedule to see the current state before trying again."],
  [/Not enough authorized time remains/i, "Shorten the shift, move it to another month, or ask an administrator to review the authorization."],
  [/No (current|active) authorization covers/i, "Add or renew the authorization for this client and service first (Authorizations)."],
  [/Only caregivers who are Ready to work or Active/i, "Finish the caregiver's onboarding and documents first, or choose a caregiver who is ready."],
  [/has a visit in progress/i, "End or close that visit first, then try again."],
  [/shift is already over|shift has started|visit has already started|visit is linked to this shift/i, "Record what happened as a visit instead of changing the shift."],
  [/Give a reason/i, "Type a short reason and save again."],
  [/must be between 15 minutes and 24 hours/i, "Enter a start and end time that make a shift of 15 minutes to 24 hours."],
  [/not assigned to you|do not have permission|Forbidden/i, "Ask an administrator to make this change."],
  [/changed while saving|try again/i, "Wait a moment and try again; nothing was lost."],
];

const NETWORK = /failed to fetch|network ?error|load failed|networkerror/i;

/** The sentence to show for a failed scheduling change. */
export function schedulingRefusal(cause: unknown, fallback: string): string {
  const raw = cause instanceof Error ? cause.message.trim() : "";
  if (!raw) return fallback;
  if (cause instanceof TypeError || NETWORK.test(raw)) return "The request did not reach the server, so nothing was saved. Check your connection and try again.";
  const step = NEXT_STEPS.find(([pattern]) => pattern.test(raw))?.[1];
  if (!step || /what to do:/i.test(raw)) return raw;
  return `${raw.replace(/[.\s]+$/, "")}. What to do: ${step}`;
}
