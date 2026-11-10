// PREVIEW ONLY (never part of the product build). Answers the app's API calls from responses RECORDED on the local harness (synthetic data), so the real
// screens can run inside one HTML file with no server. Nothing is saved: a change you make is not kept, except the caregiver visit flow, which is a small
// state machine (Start, End, Confirm) so it can be walked from Start to Submitted.
export interface Recorded { status: number; body: unknown }
export interface PersonaData {
  me: unknown;
  /** "GET /v1/path?sorted=query" -> response */
  exact: Record<string, Recorded>;
  /** "GET /v1/path/:id" (ids and queries removed) -> the last response */
  byPath: Record<string, Recorded>;
  /** The visit as the server returned it while it was running, and after End while it waits for the confirmation (for the caregiver flow). */
  runningVisit?: { visit: Record<string, unknown> } | null;
  awaitingVisit?: { visit: Record<string, unknown> } | null;
}
export interface PreviewData {
  meta: { sha: string; builtAt: string; recordedAt: string; changes: string[]; personas: string[] };
  personas: Record<string, PersonaData>;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const canonicalPath = (pathname: string) => pathname.replace(/^\/api/, "");
export const canonicalQuery = (params: URLSearchParams) => [...params].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");
export const normalisePath = (path: string) => path.replace(UUID, ":id");

/** Moves every timestamp by the time between recording and now, so "a visit starting in two hours" is still two hours away when the file is opened later. */
export function shiftTimes(value: unknown, deltaMs: number): unknown {
  if (typeof value === "string") {
    if (ISO_DATETIME.test(value)) return new Date(Date.parse(value) + deltaMs).toISOString();
    if (ISO_DATE.test(value)) return new Date(Date.parse(`${value}T12:00:00Z`) + Math.round(deltaMs / 864e5) * 864e5).toISOString().slice(0, 10);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => shiftTimes(v, deltaMs));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shiftTimes(v, deltaMs)]));
  return value;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function createPreviewFetch(data: PreviewData, persona: string, now: () => number = Date.now): typeof fetch {
  const p = data.personas[persona];
  if (!p) throw new Error(`The preview has no data for "${persona}".`);
  const deltaMs = now() - Date.parse(data.meta.recordedAt);
  let phase: "idle" | "active" | "ended" = "idle";
  let startedAt = 0;
  let endedAt = 0;
  const stamp = (body: unknown): unknown => {
    // The recorded visit carried the times of the recording; the walk-through uses the real Start and End times instead.
    const visit = (p.runningVisit?.visit ?? p.awaitingVisit?.visit) as Record<string, unknown> | undefined;
    let text = JSON.stringify(shiftTimes(body, deltaMs));
    const recordedIn = String(p.awaitingVisit?.visit.timeIn ?? visit?.timeIn ?? "");
    const recordedOut = String(p.awaitingVisit?.visit.timeOut ?? "");
    if (recordedIn && startedAt) text = text.split(new Date(Date.parse(recordedIn) + deltaMs).toISOString()).join(new Date(startedAt).toISOString());
    if (recordedOut && endedAt) text = text.split(new Date(Date.parse(recordedOut) + deltaMs).toISOString()).join(new Date(endedAt).toISOString());
    return JSON.parse(text);
  };
  const out = (r: Recorded) => json(r.status, stamp(r.body));
  let merged = false;
  return async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, "https://preview.invalid");
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    const path = canonicalPath(url.pathname);
    if (method === "GET" && path === "/v1/me") return json(200, shiftTimes(p.me, deltaMs));
    if (method === "GET" && path === "/v1/visits/active") {
      if (phase === "active" && p.runningVisit) return json(200, stamp(p.runningVisit));
      if (phase === "ended" && p.awaitingVisit) {
        const v = stamp(p.awaitingVisit) as { visit: Record<string, unknown> };
        v.visit.workedMinutes = Math.max(1, Math.round((endedAt - startedAt) / 60000));
        return json(200, v);
      }
      return json(200, { visit: null });
    }
    // Preview-only stand-ins for two actions whose result depends on what the person picks. The import check reads the chosen CSV in the browser (an .xlsx gets a sample result);
    // a merge is accepted and the duplicates list is then empty. Nothing is stored anywhere.
    if (method === "POST" && /^\/v1\/imports\/(people|clients)$/.test(path)) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { confirm?: boolean; contentBase64?: string; fileName?: string };
      const kind = path.endsWith("clients") ? "clients" : "people";
      let total = 3, dup = 1; const bad: Array<{ row: number; status: "invalid" | "duplicate"; message: string }> = [];
      if (body.fileName?.toLowerCase().endsWith(".csv") && body.contentBase64) {
        const lines = atob(body.contentBase64).split(/\r?\n/).filter((l) => l.trim() !== "");
        total = Math.max(lines.length - 1, 0); dup = 0; const seen = new Set<string>();
        lines.slice(1).forEach((l, i) => {
          const [f = "", la = ""] = l.split(",");
          if (!f.trim() || !la.trim()) bad.push({ row: i + 2, status: "invalid", message: "First name and last name are required" });
          else if (seen.has(`${f}|${la}`.toLowerCase())) { dup++; bad.push({ row: i + 2, status: "duplicate", message: "Repeated in the file" }); } else seen.add(`${f}|${la}`.toLowerCase());
        });
      }
      const invalid = bad.filter((b) => b.status === "invalid").length;
      const fresh = Math.max(total - dup - invalid, 0);
      return json(200, { import: { mode: body.confirm ? "applied" : "preview", kind, created: body.confirm ? fresh : 0, counts: { total, new: fresh, duplicate: dup, invalid }, rows: bad }, ignoredColumns: [] });
    }
    if (method === "POST" && /^\/v1\/staff\/[^/]+\/merge$/.test(path)) { merged = true; return json(200, { result: "merged" }); }
    if (method === "GET" && path === "/v1/staff/duplicates" && merged) return json(200, { duplicates: [] });
    if (method === "POST" && path === "/v1/visits") { phase = "active"; startedAt = now(); endedAt = 0; }
    if (method === "POST" && /^\/v1\/visits\/[^/]+\/end$/.test(path)) { phase = "ended"; endedAt = now(); }
    if (method === "POST" && /^\/v1\/visits\/[^/]+\/confirm$/.test(path)) phase = "idle";
    const key = `${method} ${path}${canonicalQuery(url.searchParams) ? `?${canonicalQuery(url.searchParams)}` : ""}`;
    const exact = p.exact[key];
    if (exact) return out(exact);
    const byPath = p.byPath[`${method} ${normalisePath(path)}`];
    if (byPath) return out(byPath);
    if (method === "POST") return json(200, {});   // a change that was not recorded: accepted, not kept
    return json(404, { error: { code: "not_found", message: "This screen's data is not part of the preview." } });
  };
}
