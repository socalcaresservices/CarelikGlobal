// Client directory view: List or Cards. The choice is remembered per signed-in person (on this device), never shared with
// anyone else; with no saved choice the page opens as List on a wide screen and Cards on a phone. Storage can be blocked
// or full: every access is guarded and the page works without it. Pure helpers so they can be tested without rendering.
import type { AdminClient, ClientStatus } from "./client-admin";
import { clientName } from "./client-admin";

export type ClientView = "list" | "cards";
export type ClientSort = "name" | "status" | "authorization";
export type AuthorizationFilter = "all" | "current" | "none";

export const VIEW_KEY_PREFIX = "ogevia.clients.view.";
export const WIDE_SCREEN_QUERY = "(min-width: 768px)";

export const viewStorageKey = (userId: string) => `${VIEW_KEY_PREFIX}${userId}`;
const isView = (value: unknown): value is ClientView => value === "list" || value === "cards";

export function readViewPreference(userId: string | null | undefined, storage: Pick<Storage, "getItem"> | null): ClientView | null {
  if (!userId || !storage) return null;
  try {
    const value = storage.getItem(viewStorageKey(userId));
    return isView(value) ? value : null;
  } catch {
    return null;
  }
}

/** Returns true when the choice was saved. */
export function writeViewPreference(userId: string | null | undefined, view: ClientView, storage: Pick<Storage, "setItem"> | null): boolean {
  if (!userId || !storage) return false;
  try {
    storage.setItem(viewStorageKey(userId), view);
    return true;
  } catch {
    return false;
  }
}

export const defaultView = (wideScreen: boolean): ClientView => (wideScreen ? "list" : "cards");

export const hasCurrentAuthorization = (c: Pick<AdminClient, "currentAuthorizations">) => c.currentAuthorizations > 0;

const STATUS_ORDER: Record<ClientStatus, number> = { active: 0, inactive: 1, discharged: 2 };
const byName = (a: AdminClient, b: AdminClient) =>
  (clientName(a) ?? `~${a.clientCode}`).localeCompare(clientName(b) ?? `~${b.clientCode}`, undefined, { sensitivity: "base" }) || a.clientCode.localeCompare(b.clientCode);

/** Same rows, same rules in both views. Clients with no current authorization come first when sorting by authorization (they need attention). */
export function sortClients(clients: AdminClient[], sort: ClientSort): AdminClient[] {
  const list = [...clients];
  if (sort === "status") return list.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || byName(a, b));
  if (sort === "authorization") return list.sort((a, b) => Number(hasCurrentAuthorization(a)) - Number(hasCurrentAuthorization(b)) || byName(a, b));
  return list.sort(byName);
}

export function filterClients(clients: AdminClient[], o: { search: string; status: ClientStatus | "all"; authorization: AuthorizationFilter }): AdminClient[] {
  const s = o.search.trim().toLowerCase();
  return clients.filter((c) =>
    (o.status === "all" || c.status === o.status)
    && (o.authorization === "all" || (o.authorization === "current") === hasCurrentAuthorization(c))
    && (!s || [clientName(c), c.clientCode, c.caregiverDisplayCode, c.city, c.clientTypeName].some((v) => v?.toLowerCase().includes(s))));
}
