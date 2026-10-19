import { hoursLeftLine } from "@/lib/hours-accounting";
import { useMonthlyBalances } from "./client-admin";

/**
 * The shift's authorization context, kept visible while a shift is scheduled or a caregiver is assigned
 * (Schedule -> Shift -> Caregiver -> Eligibility -> Assign): the service and the Hours left for the shift's
 * month. Both come from the server's monthly summary (the figure the client page shows); nothing is recomputed here.
 * Someone who may not read visits gets no figure (the query is off), never a false zero.
 */
export function ShiftAuthorizationContext({ clientId, serviceId, date }: { clientId?: string | null; serviceId?: string | null; date?: string | null }) {
  const month = /^\d{4}-\d{2}/.test(date ?? "") ? `${date!.slice(0, 7)}-01` : null;
  const balances = useMonthlyBalances(month && clientId ? clientId : undefined, month ?? "");
  if (!clientId || !serviceId || !month || !balances.data) return null;
  const rows = balances.data.filter((b) => b.serviceId === serviceId);
  if (rows.length === 0) return <p data-testid="shift-authorization" className="text-sm text-amber-900">Authorization: no authorization covers this service in {month.slice(0, 7)}.</p>;
  return (
    <ul data-testid="shift-authorization" aria-label="Authorization for this shift" className="space-y-0.5 text-sm text-slate-800">
      {rows.map((b) => {
        const left = b.hoursLeftMinutes ?? b.remainingMinutes;
        return (
          <li key={b.authorizationLineageId}>
            <span className="font-medium">{b.serviceName}</span> · <span data-testid="hours-left-figure">{hoursLeftLine(left).text}</span>
          </li>
        );
      })}
    </ul>
  );
}
