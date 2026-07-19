// Monday-start week boundaries in the browser's local time zone. Shared
// between the caregiver hours widget and the Action Center's over-target
// signal so both agree on what "this week" means.
export function getWeekStart(date: Date): Date {
  const day = date.getDay(); // 0 = Sunday, 1 = Monday, ... 6 = Saturday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(date);
  monday.setDate(date.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

export function getWeekEnd(weekStart: Date): Date {
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 7);
  return end;
}
