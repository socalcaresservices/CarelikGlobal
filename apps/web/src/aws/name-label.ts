// Administrator screens show people by NAME. The existing code is added beside a name only where the server says the name is
// shared by another record in the same agency (duplicateName). A record with no name visible to this role keeps its code.
// Caregiver screens and outgoing messages never use this: they keep client codes.
export function nameWithCode(name: string | null | undefined, code: string | null | undefined, duplicate?: boolean | null, missing = "Name not set"): string {
  if (!name) return code ? `${missing} (${code})` : missing;
  return duplicate && code ? `${name} (${code})` : name;
}

/** An administrator row's client: the name (code beside it only when the name is shared); with no name visible to this role, the code ("Client CODE" when prefixed). */
export function clientLabel(r: { clientName?: string | null; clientCode?: string | null; duplicateName?: boolean | null }, prefixCode = false): string | null {
  if (r.clientName) return nameWithCode(r.clientName, r.clientCode, r.duplicateName);
  return r.clientCode ? (prefixCode ? `Client ${r.clientCode}` : r.clientCode) : null;
}
