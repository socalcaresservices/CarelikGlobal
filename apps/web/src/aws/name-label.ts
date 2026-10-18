// Administrator screens show people by NAME. The existing code is added beside a name only where the server says the name is
// shared by another record in the same agency (duplicateName). A record with no name visible to this role keeps its code.
// Caregiver screens and outgoing messages never use this: they keep client codes.
export function nameWithCode(name: string | null | undefined, code: string | null | undefined, duplicate?: boolean | null, missing = "Name not set"): string {
  if (!name) return code ? `${missing} (${code})` : missing;
  return duplicate && code ? `${name} (${code})` : name;
}
