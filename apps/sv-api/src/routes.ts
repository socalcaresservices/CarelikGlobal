import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { Queryable } from "@carelik/auth/server";
import { ApiError } from "./errors";
import { signatureObjectKey, validateSignaturePng, type EvidenceStore } from "./evidence";
import { documentObjectKey, logoObjectKey, MAX_DOCUMENT_BYTES, MAX_LOGO_BYTES, validateDocumentFile, validateLogoFile } from "./documents";
import type { HttpApiEvent } from "./http";
import type { IdentityAdmin } from "./identity";
import {
  date,
  idempotencyKey,
  oneOf,
  optionalDate,
  optionalUuid,
  parseBody,
  text,
  timestamp,
  uuid,
} from "./validate";

export interface RouteContext {
  readonly event: HttpApiEvent;
  /** Runs work in ONE transaction bound to the verified caller (begin_request(sub)). */
  tx<T>(work: (db: Queryable) => Promise<T>): Promise<T>;
  readonly evidence: EvidenceStore;
  /** Creates caregiver sign-ins and resends invitations (0025); database checks run first. */
  readonly identity: IdentityAdmin;
}

export interface Route {
  readonly status?: number;
  /** Public routes are protected by a 256-bit opaque portal/offer token instead of Cognito. */
  readonly public?: boolean;
  /** Mutating routes require an Idempotency-Key header when the route handler consumes one. */
  readonly mutating: boolean;
  handle(ctx: RouteContext): Promise<unknown>;
}

const SIGNER_ROLES = ["client", "parent", "guardian", "authorized_representative"] as const;
const METHODS = ["draw", "assisted_mark", "typed", "verbal", "unable_to_confirm"] as const;
const VISIT_STATUSES = ["draft", "awaiting_signature", "signed", "administrator_review", "corrected", "voided"] as const;
const CARE_REQUEST_STATUSES = ["requested", "offering", "accepted_pending_assignment", "assigned", "coverage_needed", "client_cancelled", "filled", "closed"] as const;
const OPAQUE_TOKEN = /^[0-9a-f]{64}$/i;
const opaqueToken = (value: unknown, name = "token") => {
  if (typeof value !== "string" || !OPAQUE_TOKEN.test(value)) throw new ApiError(400, "bad_request", `${name} is invalid.`);
  return value.toLowerCase();
};
const booleanValue = (value: unknown, name: string) => {
  if (typeof value !== "boolean") throw new ApiError(400, "bad_request", `${name} must be true or false.`);
  return value;
};
/** Wave 1 (0050): the wording the caregiver attests to is versioned; the server, not the browser, names the version. */
const ATTESTATION_VERSION = "attest-v1";
const newOpaqueToken = () => randomBytes(32).toString("hex");
const hashOpaqueToken = (token: string) => createHash("sha256").update(token, "hex").digest("hex");

/** The one-time code is bound to its link: SHA-256 of "<token hash>:<6 digits>". */
const confirmationCodeHash = (tokenHash: string, code: string) => createHash("sha256").update(`${tokenHash}:${code}`).digest("hex");
const confirmationCode = (value: unknown) => {
  if (typeof value !== "string" || !/^\d{6}$/.test(value)) throw new ApiError(400, "bad_request", "Enter the 6-digit code you were given by phone.");
  return value;
};
/** A UUID derived from a string, so a retried request reuses the same ids and object keys. */
const stableUuid = (seed: string) => {
  const h = createHash("sha256").update(seed).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
};
/** Maps a public confirmation status to the response the recipient sees; 'ok' passes through. */
const publicConfirmationOrThrow = (row: Record<string, unknown> | undefined) => {
  switch (row?.status) {
    case "ok":
      return row;
    case "wrong_code":
      throw new ApiError(422, "wrong_code", `That code is not correct. ${row.attemptsLeft ?? 0} attempts left.`);
    case "locked":
      throw new ApiError(423, "locked", "This link is locked after too many wrong codes. Ask the agency for a new link.");
    default:
      throw new ApiError(404, "not_found", "This link is not valid any more. Ask the agency for a new link.");
  }
};

const BACKGROUNDS = ["light", "white", "gray", "dark"] as const;
const ACCENTS = ["teal", "blue", "indigo", "plum", "rust"] as const;
const DENSITIES = ["comfortable", "compact"] as const;
const TEXT_SIZES = ["standard", "large"] as const;
const CHART_TYPES = ["bar", "line", "donut"] as const;
const LAYOUTS = ["standard", "minimal"] as const;
/** organizationId plus the six appearance choices; an absent or null choice means "follow the next level". */
function appearanceArgs(body: Record<string, unknown>) {
  const pick = <T extends string>(value: unknown, name: string, allowed: readonly T[]) => (value === undefined || value === null ? null : oneOf(value, name, allowed));
  return [
    uuid(body.organizationId, "organizationId"),
    pick(body.background, "background", BACKGROUNDS), pick(body.accent, "accent", ACCENTS), pick(body.density, "density", DENSITIES),
    pick(body.textSize, "textSize", TEXT_SIZES), pick(body.chartType, "chartType", CHART_TYPES), pick(body.layout, "layout", LAYOUTS),
  ];
}

const camel = (key: string) => key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
/** snake_case DB row -> camelCase JSON. Values are passed through unchanged. */
export function toCamel(row: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([k, v]) => [camel(k), v]));
}

/** The Wave 1 outcome fields (confirmed/billable minutes, authorization left, method, review reasons, rule used) added to a confirm result. */
async function withOutcome(db: Queryable, visit: string, result: Record<string, unknown> | undefined) {
  if (!result) return result;
  const [outcome] = await rows(db, "select * from ogevia_api.get_visit_outcome($1)", [visit]);
  return outcome ? { ...result, outcome } : result;
}

async function rows(db: Queryable, sql: string, params: unknown[]) {
  return (await db.query(sql, params)).rows.map(toCamel);
}

/** The first row of a one-row result (a jsonb or uuid scalar), typed loosely because the database already shaped it. */
async function first(db: Queryable, sql: string, params: unknown[]): Promise<Record<string, any>> {
  return (await db.query(sql, params)).rows[0] as Record<string, any>;
}

const CLIENT_STATUSES = ["active", "inactive", "discharged"] as const;
/** 0054: Applicant, Interview, Offer, Onboarding, Pending documents, Approved ("ready"), Active, Inactive. */
const CAREGIVER_STATUSES = ["applicant", "interview", "offer", "onboarding", "pending_documents", "ready", "active", "inactive"] as const;
const NEW_CAREGIVER_STATUSES = ["applicant", "onboarding", "ready", "active"] as const;
function caregiverNames(body: Record<string, unknown>) {
  return {
    first: text(body.firstName, "firstName", 80, { required: true }),
    last: text(body.lastName, "lastName", 80, { required: true }),
    preferred: text(body.preferredName, "preferredName", 80),
  };
}
function wholeNumber(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(400, "bad_request", `${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}
function clientDetails(body: Record<string, unknown>) {
  return {
    org: uuid(body.organizationId, "organizationId"),
    first: text(body.firstName, "firstName", 80, { required: true }),
    last: text(body.lastName, "lastName", 80, { required: true }),
    city: text(body.city, "city", 80),
    type: optionalUuid(body.clientTypeId, "clientTypeId"),
    label: text(body.caregiverLabel, "caregiverLabel", 40),
  };
}
function authorizationTerms(body: Record<string, unknown>) {
  return {
    payer: text(body.payer, "payer", 120, { required: true }),
    minutes: wholeNumber(body.monthlyAuthorizedMinutes, "monthlyAuthorizedMinutes", 1, 44640),
    start: date(body.periodStart, "periodStart"),
    end: date(body.periodEnd, "periodEnd"),
    number: text(body.authorizationNumber, "authorizationNumber", 80),
    received: optionalDate(body.receivedDate, "receivedDate"),
    source: text(body.sourceReference, "sourceReference", 200),
  };
}
function outageNumber(value: unknown): number {
  const n = typeof value === "string" ? Number(value.replace(/^OUT-/i, "")) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 99_999_999) {
    throw new ApiError(400, "bad_request", "outageNumber must be the number printed on the outage visit record.");
  }
  return n;
}

function clockTime(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new ApiError(400, "bad_request", `${name} must be a time like 09:30.`);
  return value;
}
const q = (event: HttpApiEvent) => event.queryStringParameters ?? {};

/** CSV for the full-chain report. Text cells that start with = + - @ or a control character get a leading apostrophe so a spreadsheet never runs them as a formula. */
const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  let t = String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return `"${t.replace(/"/g, '""')}"`;
};
const CHAIN_COLUMNS: Array<[string, string]> = [
  ["Client code", "clientCode"], ["Service", "serviceCode"], ["Authorization version", "authorizationVersion"], ["Period start", "periodStart"], ["Period end", "periodEnd"],
  ["Authorized (min)", "authorizedMinutes"], ["Scheduled (min)", "scheduledMinutes"], ["Held for review (min)", "heldReviewMinutes"], ["Needs reconciliation (min)", "needsReconciliationMinutes"],
  ["Reserved total (min)", "reservedMinutes"], ["Worked (min)", "workedMinutes"], ["Confirmed (min)", "confirmedMinutes"], ["Billable (min)", "billableMinutes"],
  ["Needs correction (min)", "needsCorrectionMinutes"], ["Waiting for client (min)", "waitingMinutes"], ["Ready for review (min)", "readyForReviewMinutes"],
  ["Approved for billing (min)", "approvedForBillingMinutes"], ["Reviewed - not billable (min)", "reviewedNotBillableMinutes"], ["Approved by a person (min)", "humanApprovedMinutes"],
  ["Needs correction (visits)", "needsCorrectionVisits"], ["Waiting (visits)", "waitingVisits"], ["Ready for review (visits)", "readyForReviewVisits"], ["Approved (visits)", "approvedVisits"], ["Voided approvals", "voidedApprovals"],
  ["Rounding adjustments (min)", "adjustmentMinutes"], ["Committed (min)", "committedMinutes"], ["Remaining (min, signed)", "remainingMinutes"], ["Over limit (min)", "overLimitMinutes"],
  ["Reserved adds up", "reservedOk"], ["Visits add up", "visitsOk"], ["Authorization adds up", "balanceOk"], ["Difference (min)", "differenceMinutes"],
];
export function chainCsv(data: Array<Record<string, unknown>>): string {
  const lines = [CHAIN_COLUMNS.map(([h]) => csvCell(h)).join(",")];
  for (const r of data) lines.push(CHAIN_COLUMNS.map(([, k]) => csvCell(r[k])).join(","));
  lines.push(csvCell("Submitted / billed is not part of this report: approval is not submission or payment."));
  return lines.join("\r\n");
}
const p = (event: HttpApiEvent) => event.pathParameters ?? {};
const orgParam = (event: HttpApiEvent) => uuid(q(event).organizationId, "organizationId");

/**
 * Route table keyed by the API Gateway routeKey. Every route here MUST also be
 * declared (with the JWT authorizer) in infra/aws/lib/service-verification-api-stack.ts;
 * a test enforces that the two lists are identical.
 */

/** "1,3,5" or [1, 3, 5] → distinct weekdays 0 (Sunday)..6 (Saturday). */
function weekdayList(value: unknown): number[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",").filter((x) => x.trim() !== "").map(Number) : null;
  if (!list || list.length < 1 || list.length > 7 || !list.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6)
      || new Set(list).size !== list.length) {
    throw new ApiError(400, "bad_request", "weekdays must be 1 to 7 different days, 0 (Sunday) to 6 (Saturday).");
  }
  return list as number[];
}

/** A repeat pattern (0053): an object, or a JSON string of one in a query string. PostgreSQL validates every key and value. */
function patternValue(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { throw new ApiError(400, "bad_request", "pattern must be a JSON object."); }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError(400, "bad_request", "pattern must be a JSON object.");
  return JSON.stringify(parsed);
}

export const ROUTES: Record<string, Route> = {
  "GET /v1/me": {
    mutating: false,
    handle: async ({ tx }) =>
      tx(async (db) => {
        // The first successful call after the temporary password was changed marks first sign-in (0025).
        await db.query("select ogevia_api.note_my_sign_in()");
        const memberships = await rows(db, "select * from ogevia_api.get_my_context()", []);
        const [profile] = await rows(db, "select display_name from ogevia_api.get_my_profile()", []);
        // displayName is null when the person has not set one; the UI says so instead of inventing a name.
        return { memberships, profile: { displayName: (profile?.displayName as string | null | undefined) ?? null } };
      }),
  },

  "POST /v1/me/display-name": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const name = text(body.displayName, "displayName", 80, { required: true });
      const displayName = await tx(async (db) => {
        const r = await db.query("select ogevia_api.set_my_display_name($1) as name", [name]);
        return (r.rows[0] as { name: string }).name;
      });
      return { profile: { displayName } };
    },
  },

  // Agency name and accent colour (0020). Read: any member. Change: organization.update (owner).
  "GET /v1/branding": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const org = orgParam(event);
      const [branding] = await tx((db) => rows(db, "select * from ogevia_api.get_organization_branding($1)", [org]));
      if (!branding) throw new ApiError(404, "not_found", "Organization not found.");
      return { branding };
    },
  },

  "POST /v1/branding": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const name = text(body.displayName, "displayName", 120, { required: true });
      const color = body.accentColor === null || body.accentColor === undefined ? null : text(body.accentColor, "accentColor", 7);
      const [branding] = await tx((db) =>
        rows(db, "select * from ogevia_api.set_organization_branding($1, $2, $3, $4)", [org, name, color, key]),
      );
      return { branding };
    },
  },

  // Print letterhead (0038): the agency's own legal name, address, phone and email for printed reports.
  // Read with GET /v1/branding (any member). Change: organization.update (the Administrator) for the agency
  // named in the request, enforced again in the database function. Agency business details only.
  "POST /v1/branding/letterhead": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const legalName = text(body.legalName, "legalName", 120);
      const street = text(body.addressStreet, "addressStreet", 120);
      const city = text(body.addressCity, "addressCity", 80);
      const state = text(body.addressState, "addressState", 2);
      const zip = text(body.addressZip, "addressZip", 10);
      const phone = text(body.contactPhone, "contactPhone", 25);
      const email = text(body.contactEmail, "contactEmail", 254);
      const [letterhead] = await tx((db) =>
        rows(db, "select * from ogevia_api.set_organization_letterhead($1, $2, $3, $4, $5, $6, $7, $8, $9)", [org, legalName, street, city, state, zip, phone, email, key]),
      );
      return { letterhead };
    },
  },

  // Agency logo (0020): owner sets it; any member of the agency reads it.
  "POST /v1/branding/logo": {
    mutating: true,
    handle: async ({ event, tx, evidence }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const file = validateLogoFile(body.fileBase64, body.contentType);
      // Authority before storing: only holders of organization.update.
      const [me] = await tx((db) => rows(db, "select permissions from ogevia_api.get_my_context() where organization_id = $1", [org]));
      if (!me) throw new ApiError(404, "not_found", "Organization not found.");
      if (!(me.permissions as string[]).includes("organization.update")) throw new ApiError(403, "forbidden", "Only the agency Administrator can change the logo.");
      const logoId = randomUUID();
      const objectKey = logoObjectKey(org, logoId);
      let s3VersionId: string | null;
      try {
        ({ versionId: s3VersionId } = await evidence.put(objectKey, file.bytes, file.sha256, file.contentType));
      } catch {
        throw new ApiError(503, "storage_unavailable", "The logo could not be stored. Nothing was changed; please try again.");
      }
      const sha256 = await tx(async (db) => {
        const r = await db.query("select ogevia_api.set_organization_logo($1, $2, $3, $4, $5, $6, $7, $8) as s", [
          org, logoId, objectKey, s3VersionId, file.contentType, file.bytes.length, file.sha256Hex, key,
        ]);
        return (r.rows[0] as { s: string }).s;
      });
      return { logoSha256: sha256 };
    },
  },

  "POST /v1/branding/logo/clear": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const org = uuid(body.organizationId, "organizationId");
      await tx((db) => db.query("select ogevia_api.clear_organization_logo($1)", [org]));
      return { logoSha256: null };
    },
  },

  "GET /v1/branding/logo": {
    mutating: false,
    handle: async ({ event, tx, evidence }) => {
      const org = orgParam(event);
      const [meta] = await tx((db) => rows(db, "select * from ogevia_api.get_organization_logo($1)", [org]));
      if (!meta) throw new ApiError(404, "not_found", "No logo.");
      const stored = await evidence.get(meta.objectKey as string, (meta.s3VersionId as string | null) ?? null, MAX_LOGO_BYTES);
      const digest = createHash("sha256").update(stored.bytes).digest("hex");
      if (digest !== meta.sha256) throw new ApiError(500, "integrity_error", "The stored logo failed its integrity check.");
      return { contentType: meta.contentType, fileBase64: stored.bytes.toString("base64"), sha256: digest };
    },
  },

  // Client directory (0020): codes for visits.read; legal names only with clients.names.read (never caregivers).
  "GET /v1/clients/directory": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      clients: await tx((db) => rows(db, "select * from ogevia_api.list_client_directory($1)", [orgParam(event)])),
    }),
  },

  "POST /v1/clients/{clientId}/legal-name": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const client = uuid(p(event).clientId, "clientId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const first = text(body.firstName, "firstName", 80, { required: true });
      const last = text(body.lastName, "lastName", 80, { required: true });
      await tx((db) => db.query("select ogevia_api.set_client_legal_name($1, $2, $3, $4, $5)", [org, client, first, last, key]));
      return { ok: true };
    },
  },

  // Client and authorization administration (0022). Permissions are enforced in
  // PostgreSQL: clients.manage + clients.names.manage to change clients,
  // authorizations.update to add or amend, authorizations.rates.manage to set a
  // rate; names, city and rates are returned only to the roles that may see them.
  "GET /v1/client-types": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      clientTypes: await tx((db) => rows(db, "select * from ogevia_api.list_client_types($1)", [orgParam(event)])),
    }),
  },

  "POST /v1/client-types": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const name = text(body.name, "name", 60, { required: true });
      const clientTypeId = await tx(async (db) =>
        ((await db.query("select ogevia_api.create_client_type($1, $2, $3) as id", [org, name, key])).rows[0] as { id: string }).id);
      return { clientTypeId };
    },
  },

  "GET /v1/services": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      services: await tx((db) => rows(db, "select * from ogevia_api.list_services($1)", [orgParam(event)])),
    }),
  },

  "GET /v1/clients": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      clients: await tx((db) => rows(db, "select * from ogevia_api.list_clients($1)", [orgParam(event)])),
    }),
  },

  // One client with its current authorizations embedded (client.authorizations[]).
  // Read model only: no new database object. The same two functions the list and
  // history screens use, in one transaction, so permissions are unchanged (names
  // need clients.names.read; rates need billing.read; an actor without
  // authorizations.read gets an empty list). History stays on
  // GET /v1/clients/{clientId}/authorizations.
  "GET /v1/clients/{clientId}": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const clientId = uuid(p(event).clientId, "clientId");
      const org = orgParam(event);
      const client = await tx(async (db) => {
        const found = (await rows(db, "select * from ogevia_api.list_clients($1)", [org])).find((c) => c.clientId === clientId);
        if (!found) return null;
        const versions = await rows(db, "select * from ogevia_api.list_client_authorizations($1, $2)", [org, clientId]);
        return { ...found, authorizations: versions.filter((a) => a.isCurrent === true) };
      });
      if (!client) throw new ApiError(404, "not_found", "Client not found.");
      return { client };
    },
  },

  "POST /v1/clients": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const c = clientDetails(body);
      const [created] = await tx((db) =>
        rows(db, "select * from ogevia_api.create_client($1, $2, $3, $4, $5, $6, $7)", [c.org, c.first, c.last, c.city, c.type, c.label, key]));
      return { client: created };
    },
  },

  "POST /v1/clients/{clientId}/details": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const client = uuid(p(event).clientId, "clientId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const c = clientDetails(body);
      await tx((db) => db.query("select ogevia_api.update_client($1, $2, $3, $4, $5, $6, $7, $8)", [c.org, client, c.first, c.last, c.city, c.type, c.label, key]));
      return { ok: true };
    },
  },

  "POST /v1/clients/{clientId}/status": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const client = uuid(p(event).clientId, "clientId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const status = oneOf(body.status, "status", CLIENT_STATUSES);
      const reason = text(body.reason, "reason", 500, { required: true });
      await tx((db) => db.query("select ogevia_api.set_client_status($1, $2, $3, $4, $5)", [org, client, status, reason, key]));
      return { ok: true };
    },
  },

  "GET /v1/clients/{clientId}/authorizations": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const client = uuid(p(event).clientId, "clientId");
      return {
        authorizations: await tx((db) => rows(db, "select * from ogevia_api.list_client_authorizations($1, $2)", [orgParam(event), client])),
      };
    },
  },

  "POST /v1/clients/{clientId}/authorizations": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const client = uuid(p(event).clientId, "clientId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const service = uuid(body.serviceId, "serviceId");
      const a = authorizationTerms(body);
      const rate = body.hourlyRateCents === undefined || body.hourlyRateCents === null
        ? null : wholeNumber(body.hourlyRateCents, "hourlyRateCents", 0, 100000);
      const authorizationId = await tx(async (db) =>
        ((await db.query(
          "select ogevia_api.create_client_authorization($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) as id",
          [org, client, service, a.payer, a.minutes, a.start, a.end, a.number, a.received, a.source, rate, key],
        )).rows[0] as { id: string }).id);
      return { authorizationId };
    },
  },

  "POST /v1/authorizations/{authorizationId}/amend": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const authorization = uuid(p(event).authorizationId, "authorizationId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const a = authorizationTerms(body);
      const reason = text(body.reason, "reason", 500, { required: true });
      const impact = await tx((db) =>
        rows(db, "select * from ogevia_api.amend_client_authorization($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
          [authorization, a.minutes, a.start, a.end, a.payer, reason, a.number, a.received, a.source, key]));
      const first = impact[0] ?? {};
      return {
        newAuthorizationId: first.newAuthorizationId ?? null,
        newVersionNumber: first.newVersionNumber ?? null,
        affectedVisits: impact.filter((r) => r.affectedVisitId).map((r) => ({
          impactId: r.impactId, visitId: r.affectedVisitId, status: r.affectedVisitStatus, serviceDate: r.affectedServiceDate,
          workedMinutes: r.affectedWorkedMinutes, billableMinutes: r.affectedBillableMinutes, impact: r.impactKind,
        })),
        // 0068: reserved shifts that no longer fit the new terms. Reported and stored; nothing is released or moved.
        affectedShifts: impact.filter((r) => r.affectedShiftId).map((r) => ({
          impactId: r.impactId, shiftId: r.affectedShiftId, serviceDate: r.affectedServiceDate, reservedMinutes: r.impactMinutes, impact: r.impactKind,
        })),
      };
    },
  },

  // Stored amendment impacts (0068): authorizations.update or shifts.manage. Open ones by default.
  "GET /v1/authorization-impacts": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const all = (event.queryStringParameters ?? {}).includeAcknowledged === "true";
      return { impacts: await tx((db) => rows(db, "select * from ogevia_api.list_authorization_amendment_impacts($1, $2)", [orgParam(event), all])) };
    },
  },

  "POST /v1/authorization-impacts/{impactId}/acknowledge": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const impact = uuid(p(event).impactId, "impactId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const org = uuid(body.organizationId, "organizationId");
      const note = text(body.note, "note", 1000, { required: true });
      const result = await tx(async (db) =>
        ((await db.query("select ogevia_api.acknowledge_authorization_amendment_impact($1, $2, $3) as r", [org, impact, note])).rows[0] as { r: unknown }).r);
      return { acknowledgement: result };
    },
  },

  // Care Team and services (0023): caregivers.manage (Administrator, manager);
  // services.manage (Administrator). Enforced in PostgreSQL.
  "GET /v1/caregivers": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      caregivers: await tx((db) => rows(db, "select * from ogevia_api.list_caregivers($1)", [orgParam(event)])),
    }),
  },

  "POST /v1/caregivers": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const n = caregiverNames(body);
      const status = oneOf(body.status ?? "onboarding", "status", NEW_CAREGIVER_STATUSES);
      const [created] = await tx((db) =>
        rows(db, "select * from ogevia_api.create_caregiver($1, $2, $3, $4, $5, $6)", [org, n.first, n.last, n.preferred, status, key]));
      return { caregiver: created };
    },
  },

  "POST /v1/caregivers/{caregiverRecordId}/details": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const record = uuid(p(event).caregiverRecordId, "caregiverRecordId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const n = caregiverNames(body);
      await tx((db) => db.query("select ogevia_api.update_caregiver($1, $2, $3, $4, $5, $6)", [org, record, n.first, n.last, n.preferred, key]));
      return { ok: true };
    },
  },

  "POST /v1/caregivers/{caregiverRecordId}/status": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const record = uuid(p(event).caregiverRecordId, "caregiverRecordId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const status = oneOf(body.status, "status", CAREGIVER_STATUSES);
      const reason = text(body.reason, "reason", 500, { required: true });
      const [result] = await tx((db) =>
        rows(db, "select * from ogevia_api.set_caregiver_status($1, $2, $3, $4, $5)", [org, record, status, reason, key]));
      return { result };
    },
  },

  // Invitations (0025). The database decides first (caregivers.manage, own agency,
  // caregiver role only); then the sign-in is created; then the database links it.
  // The temporary password is generated and emailed by Cognito; it never passes here.
  "POST /v1/caregivers/{caregiverRecordId}/invitation": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx, identity }) => {
      const record = uuid(p(event).caregiverRecordId, "caregiverRecordId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const org = uuid(body.organizationId, "organizationId");
      const email = text(body.email, "email", 254, { required: true })!;
      const normalized = await tx(async (db) =>
        ((await db.query("select ogevia_api.begin_caregiver_invitation($1, $2, $3) as email", [org, record, email])).rows[0] as { email: string }).email);
      const signIn = await identity.invite(normalized);
      const [invitation] = await tx((db) =>
        rows(db, "select * from ogevia_api.complete_caregiver_invitation($1, $2, $3, $4, $5)", [org, record, normalized, signIn.sub, signIn.existingAccount]));
      return { invitation };
    },
  },

  "POST /v1/caregivers/{caregiverRecordId}/invitation/resend": {
    mutating: true,
    handle: async ({ event, tx, identity }) => {
      const record = uuid(p(event).caregiverRecordId, "caregiverRecordId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const org = uuid(body.organizationId, "organizationId");
      const email = await tx(async (db) =>
        ((await db.query("select ogevia_api.begin_invitation_resend($1, $2) as email", [org, record])).rows[0] as { email: string }).email);
      await identity.resend(email);
      const sendCount = await tx(async (db) =>
        ((await db.query("select ogevia_api.record_invitation_resent($1, $2) as n", [org, record])).rows[0] as { n: number }).n);
      return { invitation: { sendCount } };
    },
  },

  // Sign-in accounts (0048): plain-language status, and Admin disable/enable. The database decides first (accounts.manage =
  // organization owner only, own agency only, never yourself); passwords are never read, set or returned; no email or Cognito
  // identifier is returned. DISABLE is database-first (the person is blocked in Ogevia at once; the Cognito switch-off follows and a retry
  // is safe). ENABLE switches the Cognito sign-in on first, then restores access in the database.
  "GET /v1/accounts": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const org = orgParam(event);
      return { accounts: await tx((db) => rows(db, "select * from ogevia_api.list_accounts($1)", [org])) };
    },
  },

  "POST /v1/accounts/{userId}/disable": {
    mutating: true,
    handle: async ({ event, tx, identity }) => {
      const userId = uuid(p(event).userId, "userId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const org = uuid(body.organizationId, "organizationId");
      const reason = text(body.reason, "reason", 500, { required: true })!;
      const [result] = await tx((db) => rows(db, "select * from ogevia_api.disable_account($1, $2, $3)", [org, userId, reason]));
      const signInOff = result?.disableSignIn === true && typeof result.cognitoSub === "string";
      if (signInOff) {
        try {
          await identity.setEnabled(result!.cognitoSub as string, false);
        } catch {
          throw new ApiError(502, "identity_unavailable", "Access is blocked in Ogevia, but the sign-in service did not confirm the change. Choose Disable again to finish it.");
        }
      }
      return { account: { userId, accountStatus: "disabled", signInSwitchedOff: signInOff } };
    },
  },

  "POST /v1/accounts/{userId}/enable": {
    mutating: true,
    handle: async ({ event, tx, identity }) => {
      const userId = uuid(p(event).userId, "userId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const org = uuid(body.organizationId, "organizationId");
      const reason = text(body.reason, "reason", 500, { required: true })!;
      const [prep] = await tx((db) => rows(db, "select * from ogevia_api.prepare_account_enable($1, $2)", [org, userId]));
      // Cognito first: if it cannot be switched on, nothing has changed in Ogevia and the Admin can retry.
      if (prep?.signInDisabled === true && typeof prep.cognitoSub === "string") await identity.setEnabled(prep.cognitoSub, true);
      await tx((db) => db.query("select ogevia_api.enable_account($1, $2, $3)", [org, userId, reason]));
      return { account: { userId, accountStatus: "active" } };
    },
  },

  "POST /v1/services": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const code = text(body.code, "code", 20, { required: true });
      const name = text(body.name, "name", 80, { required: true });
      const serviceId = await tx(async (db) =>
        ((await db.query("select ogevia_api.create_service($1, $2, $3, $4) as id", [org, code, name, key])).rows[0] as { id: string }).id);
      return { serviceId };
    },
  },

  "POST /v1/services/{serviceId}/name": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const service = uuid(p(event).serviceId, "serviceId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const name = text(body.name, "name", 80, { required: true });
      await tx((db) => db.query("select ogevia_api.rename_service($1, $2, $3, $4)", [org, service, name, key]));
      return { ok: true };
    },
  },

  "POST /v1/services/{serviceId}/status": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const service = uuid(p(event).serviceId, "serviceId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const active = booleanValue(body.active, "active");
      const reason = text(body.reason, "reason", 500, { required: true });
      await tx((db) => db.query("select ogevia_api.set_service_active($1, $2, $3, $4, $5)", [org, service, active, reason, key]));
      return { ok: true };
    },
  },

  // Schedule (0026): shifts.manage (Administrator, manager, scheduler); caregivers: own shifts only.
  "GET /v1/shifts": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const query = q(event);
      const from = date(query.from, "from");
      const to = date(query.to, "to");
      const client = optionalUuid(query.clientId, "clientId");
      return { shifts: await tx((db) => rows(db, "select * from ogevia_api.list_shifts($1, $2, $3, $4)", [orgParam(event), from, to, client])) };
    },
  },

  "POST /v1/shifts": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const client = uuid(body.clientId, "clientId");
      const service = uuid(body.serviceId, "serviceId");
      const day = date(body.date, "date");
      const start = clockTime(body.startTime, "startTime");
      const end = clockTime(body.endTime, "endTime");
      const caregiver = optionalUuid(body.caregiverRecordId, "caregiverRecordId");
      const [shift] = await tx((db) =>
        rows(db, "select * from ogevia_api.create_shift($1, $2, $3, $4, $5::time, $6::time, $7, $8)", [org, client, service, day, start, end, caregiver, key]));
      return { shift };
    },
  },

  // Recruiting and onboarding (0054). Every rule (the checklist, the approval gate, the assignment gate) runs in PostgreSQL.
  "GET /v1/onboarding/overview": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      caregivers: await tx((db) => rows(db, "select *, next_expiry::text as next_expiry from ogevia_api.list_onboarding_overview($1)", [orgParam(event)])),
    }),
  },

  "GET /v1/onboarding/requirements": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      requirements: await tx((db) => rows(db, "select * from ogevia_api.list_onboarding_requirements($1)", [orgParam(event)])),
    }),
  },

  "POST /v1/onboarding/requirements": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const org = uuid(body.organizationId, "organizationId");
      const key = text(body.requirementKey, "requirementKey", 41, { required: true });
      const label = text(body.label, "label", 80);
      const category = body.category === undefined || body.category === null ? null : oneOf(body.category, "category", ["background_check", "training", "clearance", "other"]);
      const required = body.required === undefined ? null : booleanValue(body.required, "required");
      const validity = body.validityMonths === undefined || body.validityMonths === null ? null : wholeNumber(body.validityMonths, "validityMonths", 1, 120);
      const hireType = body.hireType === undefined || body.hireType === null ? null : oneOf(body.hireType, "hireType", ["direct_hire", "eor"]);
      const active = body.isActive === undefined ? null : booleanValue(body.isActive, "isActive");
      const reason = text(body.reason, "reason", 500, { required: true });
      await tx((db) => db.query("select ogevia_api.set_onboarding_requirement($1, $2, $3, $4, $5, $6, $7, $8, $9)", [org, key, label, category, required, validity, hireType, active, reason]));
      return { ok: true };
    },
  },

  "GET /v1/caregivers/{caregiverRecordId}/onboarding": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const record = uuid(p(event).caregiverRecordId, "caregiverRecordId");
      const org = orgParam(event);
      return { onboarding: (await tx((db) => first(db, "select ogevia_api.get_onboarding($1, $2) as o", [org, record]))).o };
    },
  },

  "POST /v1/caregivers/{caregiverRecordId}/onboarding/start": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const record = uuid(p(event).caregiverRecordId, "caregiverRecordId");
      const org = uuid(parseBody(event.body, event.isBase64Encoded).organizationId, "organizationId");
      await tx((db) => db.query("select ogevia_api.start_onboarding($1, $2)", [org, record]));
      return { onboarding: (await tx((db) => first(db, "select ogevia_api.get_onboarding($1, $2) as o", [org, record]))).o };
    },
  },

  "POST /v1/caregivers/{caregiverRecordId}/onboarding/items": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const record = uuid(p(event).caregiverRecordId, "caregiverRecordId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const org = uuid(body.organizationId, "organizationId");
      const key = text(body.requirementKey, "requirementKey", 41, { required: true });
      const action = oneOf(body.action, "action", ["complete", "waive", "reopen"]);
      const completedOn = optionalDate(body.completedOn, "completedOn");
      const expiresOn = optionalDate(body.expiresOn, "expiresOn");
      const note = text(body.note, "note", 200);
      const reason = text(body.reason, "reason", 500);
      return { onboarding: (await tx((db) => first(db,
        "select ogevia_api.record_onboarding_item($1, $2, $3, $4, $5, $6, $7, $8) as o", [org, record, key, action, completedOn, expiresOn, note, reason]))).o };
    },
  },

  // Recurring shifts (0034). Occurrences are ordinary shifts; every check runs in PostgreSQL.
  "GET /v1/shift-series/preview": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const query = q(event);
      const org = orgParam(event);
      const client = uuid(query.clientId, "clientId");
      const service = uuid(query.serviceId, "serviceId");
      const caregiver = optionalUuid(query.caregiverRecordId, "caregiverRecordId");
      const days = weekdayList(query.weekdays);
      const start = clockTime(query.startTime, "startTime");
      const end = clockTime(query.endTime, "endTime");
      const startsOn = date(query.startsOn, "startsOn");
      const endsOn = optionalDate(query.endsOn, "endsOn");
      const pattern = patternValue(query.pattern);
      return {
        occurrences: await tx((db) => rows(db,
          "select *, local_date::text as local_date, month_start::text as month_start from ogevia_api.preview_shift_series($1, $2, $3, $4, $5::smallint[], $6::time, $7::time, $8, $9, $10::jsonb)",
          [org, client, service, caregiver, days, start, end, startsOn, endsOn, pattern])),
      };
    },
  },

  "GET /v1/shift-series": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      series: await tx((db) => rows(db, "select * from ogevia_api.list_shift_series($1)", [orgParam(event)])),
    }),
  },

  // 0061: saves every date that fits and returns `rejected`, every other date with its reason. When no date fits, `series` has seriesId null and
  // created 0 (nothing is saved); the status stays 201, so a caller must read `created`.
  "POST /v1/shift-series": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const client = uuid(body.clientId, "clientId");
      const service = uuid(body.serviceId, "serviceId");
      const caregiver = optionalUuid(body.caregiverRecordId, "caregiverRecordId");
      const days = weekdayList(body.weekdays);
      const start = clockTime(body.startTime, "startTime");
      const end = clockTime(body.endTime, "endTime");
      const startsOn = date(body.startsOn, "startsOn");
      const endsOn = optionalDate(body.endsOn, "endsOn");
      const onConflict = oneOf(body.onConflict ?? "save_valid", "onConflict", ["save_valid", "refuse", "skip_flagged"]);
      const pattern = patternValue(body.pattern);
      const [series] = await tx((db) => rows(db,
        "select * from ogevia_api.create_shift_series($1, $2, $3, $4, $5::smallint[], $6::time, $7::time, $8, $9, $10, $11, $12::jsonb)",
        [org, client, service, caregiver, days, start, end, startsOn, endsOn, onConflict, key, pattern]));
      return { series };
    },
  },

  "POST /v1/shift-series/{seriesId}/change": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const series = uuid(p(event).seriesId, "seriesId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const from = date(body.fromDate, "fromDate");
      const caregiver = optionalUuid(body.caregiverRecordId, "caregiverRecordId");
      const days = weekdayList(body.weekdays);
      const start = clockTime(body.startTime, "startTime");
      const end = clockTime(body.endTime, "endTime");
      const endsOn = optionalDate(body.endsOn, "endsOn");
      const onConflict = oneOf(body.onConflict ?? "save_valid", "onConflict", ["save_valid", "refuse", "skip_flagged"]);
      const reason = text(body.reason, "reason", 500, { required: true });
      const pattern = patternValue(body.pattern);
      const clearPattern = body.clearPattern === undefined ? false : booleanValue(body.clearPattern, "clearPattern");
      const [result] = await tx((db) => rows(db,
        "select * from ogevia_api.change_shift_series_from($1, $2, $3, $4, $5::smallint[], $6::time, $7::time, $8, $9, $10, $11, $12::jsonb, $13)",
        [org, series, from, caregiver, days, start, end, endsOn, onConflict, reason, key, pattern, clearPattern]));
      return { result };
    },
  },

  "POST /v1/shift-series/{seriesId}/end": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const series = uuid(p(event).seriesId, "seriesId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const from = date(body.fromDate, "fromDate");
      const reason = text(body.reason, "reason", 500, { required: true });
      const [result] = await tx((db) => rows(db, "select * from ogevia_api.end_shift_series($1, $2, $3, $4, $5)", [org, series, from, reason, key]));
      return { result };
    },
  },

  "POST /v1/shift-series/{seriesId}/extend": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const series = uuid(p(event).seriesId, "seriesId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const through = date(body.through, "through");
      const onConflict = oneOf(body.onConflict ?? "save_valid", "onConflict", ["save_valid", "refuse", "skip_flagged"]);
      const [result] = await tx((db) => rows(db, "select * from ogevia_api.extend_shift_series($1, $2, $3, $4, $5)", [org, series, through, onConflict, key]));
      return { result };
    },
  },

  // Caregiver hour limits, caregiver load and make-up visits (0053).
  "GET /v1/hour-limits": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      limits: await tx((db) => rows(db, "select * from ogevia_api.list_hour_limits($1)", [orgParam(event)])),
    }),
  },

  // The agency's fixed work-hour policy (0060): read-only; nothing in the API can change it.
  "GET /v1/work-hour-policy": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const [policy] = await tx((db) => rows(db, "select * from ogevia_api.get_work_hour_policy($1)", [orgParam(event)]));
      return { policy: policy ?? { applies: false } };
    },
  },

  "POST /v1/hour-limits": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const org = uuid(body.organizationId, "organizationId");
      const caregiver = optionalUuid(body.caregiverRecordId, "caregiverRecordId");
      const daily = body.maxDailyMinutes === null || body.maxDailyMinutes === undefined ? null : wholeNumber(body.maxDailyMinutes, "maxDailyMinutes", 60, 1440);
      const weekly = body.maxWeeklyMinutes === null || body.maxWeeklyMinutes === undefined ? null : wholeNumber(body.maxWeeklyMinutes, "maxWeeklyMinutes", 60, 10080);
      const mode = oneOf(body.mode ?? "report", "mode", ["report", "block"]);
      const reason = text(body.reason, "reason", 500, { required: true });
      await tx((db) => db.query("select ogevia_api.set_hour_limit($1, $2, $3, $4, $5, $6)", [org, caregiver, daily, weekly, mode, reason]));
      return { ok: true };
    },
  },

  "GET /v1/caregiver-load": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const query = q(event);
      const org = orgParam(event);
      const from = date(query.from, "from");
      const to = date(query.to, "to");
      return {
        load: await tx((db) => rows(db,
          "select *, week_start::text as week_start, busiest_day::text as busiest_day from ogevia_api.list_caregiver_load($1, $2, $3)", [org, from, to])),
      };
    },
  },

  "POST /v1/shifts/{shiftId}/makeup": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const shift = uuid(p(event).shiftId, "shiftId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const day = date(body.localDate, "localDate");
      const start = clockTime(body.startTime, "startTime");
      const end = clockTime(body.endTime, "endTime");
      const caregiver = optionalUuid(body.caregiverRecordId, "caregiverRecordId");
      const [makeup] = await tx((db) => rows(db,
        "select * from ogevia_api.schedule_makeup_shift($1, $2, $3, $4::time, $5::time, $6, $7)", [org, shift, day, start, end, caregiver, key]));
      return { makeup };
    },
  },

  "POST /v1/shifts/{shiftId}/reschedule": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const shift = uuid(p(event).shiftId, "shiftId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const day = date(body.date, "date");
      const start = clockTime(body.startTime, "startTime");
      const end = clockTime(body.endTime, "endTime");
      const reason = text(body.reason, "reason", 500, { required: true });
      const [result] = await tx((db) => rows(db, "select * from ogevia_api.reschedule_shift($1, $2, $3, $4::time, $5::time, $6, $7)", [org, shift, day, start, end, reason, key]));
      return { shift: result };
    },
  },

  "POST /v1/shifts/{shiftId}/callout": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const shift = uuid(p(event).shiftId, "shiftId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const reason = text(body.reason, "reason", 500, { required: true });
      const state = await tx(async (db) =>
        ((await db.query("select ogevia_api.record_shift_callout($1, $2, $3, $4) as s", [org, shift, reason, key])).rows[0] as { s: string }).s);
      return { coverageState: state };
    },
  },

  "POST /v1/shifts/{shiftId}/caregiver": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const shift = uuid(p(event).shiftId, "shiftId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const caregiver = uuid(body.caregiverRecordId, "caregiverRecordId");
      const reason = text(body.reason, "reason", 500);
      const state = await tx(async (db) =>
        ((await db.query("select ogevia_api.assign_shift_caregiver($1, $2, $3, $4, $5) as s", [org, shift, caregiver, reason, key])).rows[0] as { s: string }).s);
      return { coverageState: state };
    },
  },

  "POST /v1/shifts/{shiftId}/cancel": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const shift = uuid(p(event).shiftId, "shiftId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const reason = text(body.reason, "reason", 500, { required: true });
      const released = await tx(async (db) =>
        ((await db.query("select ogevia_api.cancel_shift($1, $2, $3, $4) as n", [org, shift, reason, key])).rows[0] as { n: number }).n);
      return { releasedMinutes: released };
    },
  },

  "GET /v1/shifts/{shiftId}/coverage": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const shift = uuid(p(event).shiftId, "shiftId");
      return { events: await tx((db) => rows(db, "select * from ogevia_api.list_shift_coverage($1, $2)", [orgParam(event), shift])) };
    },
  },

  "GET /v1/my-shifts": {
    mutating: false,
    handle: async ({ event, tx }) => ({ shifts: await tx((db) => rows(db, "select * from ogevia_api.list_my_shifts($1)", [orgParam(event)])) }),
  },

  "POST /v1/my-shifts/{shiftId}/callout": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const shift = uuid(p(event).shiftId, "shiftId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const reason = text(body.reason, "reason", 500, { required: true });
      const state = await tx(async (db) =>
        ((await db.query("select ogevia_api.call_out_my_shift($1, $2, $3, $4) as s", [org, shift, reason, key])).rows[0] as { s: string }).s);
      return { coverageState: state };
    },
  },

  // Open shifts (0051, Wave 1): a caregiver sees the open shifts they are assigned to and picks one up. One person wins;
  // a retry is the same answer; readiness, overlap and authorization are re-checked in the database.
  "GET /v1/open-shifts": {
    mutating: false,
    handle: async ({ event, tx }) => ({ shifts: await tx((db) => rows(db, "select * from ogevia_api.list_open_shifts($1)", [orgParam(event)])) }),
  },

  // 0063: asking for an open shift only records a request; the shift is not assigned until an administrator confirms (confirm below).
  "POST /v1/shifts/{shiftId}/pickup": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const shift = uuid(p(event).shiftId, "shiftId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const state = await tx(async (db) =>
        ((await db.query("select ogevia_api.pickup_open_shift($1, $2, $3) as s", [org, shift, key])).rows[0] as { s: string }).s);
      return { pickupState: state };
    },
  },

  "POST /v1/shifts/{shiftId}/pickup/withdraw": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const shift = uuid(p(event).shiftId, "shiftId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const org = uuid(body.organizationId, "organizationId");
      const state = await tx(async (db) =>
        ((await db.query("select ogevia_api.withdraw_my_shift_pickup($1, $2) as s", [org, shift])).rows[0] as { s: string }).s);
      return { pickupState: state };
    },
  },

  // The administrator's queue (shifts.manage): each waiting request with what would block it now.
  "GET /v1/shift-pickups": {
    mutating: false,
    handle: async ({ event, tx }) => ({ requests: await tx((db) => rows(db, "select * from ogevia_api.list_shift_pickup_requests($1)", [orgParam(event)])) }),
  },

  "POST /v1/shift-pickups/{requestId}/confirm": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const request = uuid(p(event).requestId, "requestId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const state = await tx(async (db) =>
        ((await db.query("select ogevia_api.confirm_shift_pickup($1, $2, $3) as s", [org, request, key])).rows[0] as { s: string }).s);
      return { coverageState: state };
    },
  },

  "POST /v1/shift-pickups/{requestId}/decline": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const request = uuid(p(event).requestId, "requestId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const reason = text(body.reason, "reason", 500, { required: true });
      const state = await tx(async (db) =>
        ((await db.query("select ogevia_api.decline_shift_pickup($1, $2, $3, $4) as s", [org, request, reason, key])).rows[0] as { s: string }).s);
      return { pickupState: state };
    },
  },

  // Shifts that ended with no visit record and still hold a reservation (0067). Nothing is released automatically: a person records an outcome.
  "GET /v1/shifts-to-reconcile": {
    mutating: false,
    handle: async ({ event, tx }) => ({ shifts: await tx((db) => rows(db, "select * from ogevia_api.list_shifts_to_reconcile($1)", [orgParam(event)])) }),
  },

  "POST /v1/shifts/{shiftId}/reconcile": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const shift = uuid(p(event).shiftId, "shiftId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const outcome = text(body.outcome, "outcome", 40, { required: true });
      const note = text(body.note, "note", 1000, { required: true });
      const result = await tx(async (db) =>
        ((await db.query("select ogevia_api.reconcile_ended_shift($1, $2, $3, $4, $5) as r", [org, shift, outcome, note, key])).rows[0] as { r: unknown }).r);
      return { reconciliation: result };
    },
  },

  // Agency visit rules (0050, Wave 1): the schedule-variance rule is versioned and effective-dated; reading needs
  // visits.read, changing needs organization.update (the Administrator).
  "GET /v1/visit-rules": {
    mutating: false,
    handle: async ({ event, tx }) => ({ rules: await tx((db) => rows(db, "select * from ogevia_api.list_visit_rules($1)", [orgParam(event)])) }),
  },

  "POST /v1/visit-rules": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      if (typeof body.minutes !== "number" || !Number.isInteger(body.minutes)) throw new ApiError(400, "bad_request", "minutes must be a whole number.");
      const effectiveFrom = optionalDate(body.effectiveFrom, "effectiveFrom");
      const reason = text(body.reason, "reason", 500);
      const [created] = await tx((db) =>
        rows(db, "select ogevia_api.set_visit_rule($1, $2, $3, $4, $5) as version", [org, body.minutes, effectiveFrom, reason, key]));
      return { version: created?.version };
    },
  },

  // Assignments (0024): assignments.manage (Administrator, manager); list with visits.read.
  "GET /v1/assignments": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const query = q(event);
      const client = optionalUuid(query.clientId, "clientId");
      const caregiver = optionalUuid(query.caregiverRecordId, "caregiverRecordId");
      return {
        assignments: await tx((db) => rows(db, "select * from ogevia_api.list_assignments($1, $2, $3)", [orgParam(event), client, caregiver])),
      };
    },
  },

  "POST /v1/assignments": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const caregiver = uuid(body.caregiverRecordId, "caregiverRecordId");
      const client = uuid(body.clientId, "clientId");
      const service = uuid(body.serviceId, "serviceId");
      const start = date(body.effectiveStart, "effectiveStart");
      const end = optionalDate(body.effectiveEnd, "effectiveEnd");
      const [created] = await tx((db) =>
        rows(db, "select * from ogevia_api.create_assignment($1, $2, $3, $4, $5, $6, $7)", [org, caregiver, client, service, start, end, key]));
      return { assignment: created };
    },
  },

  "POST /v1/assignments/{assignmentId}/end": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const assignment = uuid(p(event).assignmentId, "assignmentId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const end = optionalDate(body.lastDay, "lastDay");
      const reason = text(body.reason, "reason", 500, { required: true });
      const outcome = await tx(async (db) =>
        ((await db.query("select ogevia_api.end_assignment($1, $2, $3, $4, $5) as outcome", [org, assignment, end, reason, key])).rows[0] as { outcome: string }).outcome);
      return { outcome };
    },
  },

  // NEEDS ATTENTION counts (0020): visits.read; the billing count only with billing.visits.read.
  "GET /v1/attention": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const org = orgParam(event);
      const [summary] = await tx((db) => rows(db, "select * from ogevia_api.get_attention_summary($1, 12, 2880)", [org]));
      // 0055: caregivers on a compliance hold (shifts to cover, visits in progress). null when the viewer may not see it, never a false zero.
      const compliance = await tx(async (db) => (await first(db, "select ogevia_api.get_compliance_attention($1) as a", [org])).a ?? null);
      return { summary: summary ? { ...summary, complianceHolds: compliance } : null };
    },
  },

  // Attention by purpose (0054): needs attention now / upcoming staffing / documents & compliance / visit review. One read-only classification
  // of the same records; a section is null when the viewer may not see it. The urgent window is 48 hours (owner decision D10;
  // default 48; 1 to 168 accepted so a filter such as 24 or 72 hours can be tried).
  "GET /v1/attention/overview": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const raw = q(event).urgentHours;
      const hours = raw === undefined || raw === "" ? 48 : wholeNumber(Number(raw), "urgentHours", 1, 168);
      return { overview: await tx(async (db) => (await first(db, "select ogevia_api.get_attention_overview($1,$2) as o", [orgParam(event), hours])).o) };
    },
  },

  // Appearance (0054): agency defaults (organization.update) and each person's own choices. A null value means "follow the next level".
  "GET /v1/appearance": {
    mutating: false,
    handle: async ({ event, tx }) => ({ appearance: await tx(async (db) => (await first(db, "select ogevia_api.get_appearance($1) as a", [orgParam(event)])).a) }),
  },

  "POST /v1/appearance/organization": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      return { appearance: await tx(async (db) => (await first(db, "select ogevia_api.set_organization_appearance($1,$2,$3,$4,$5,$6,$7) as a", appearanceArgs(body))).a) };
    },
  },

  "POST /v1/appearance/me": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      return { appearance: await tx(async (db) => (await first(db, "select ogevia_api.set_my_appearance($1,$2,$3,$4,$5,$6,$7) as a", appearanceArgs(body))).a) };
    },
  },

  // The authorizations whose rate is missing, so a month's dollar figures leave their hours out (administrator only).
  "GET /v1/authorizations/missing-rate": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      authorizations: await tx((db) => rows(db, "select * from ogevia_api.list_authorizations_missing_rate($1, $2::date)", [orgParam(event), date(q(event).monthStart, "monthStart")])),
    }),
  },

  // Hire type, scheduling and family relationship (0030): separate facts; none relaxes any visit rule.
  "POST /v1/caregivers/{caregiverRecordId}/employment": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const hire = body.hireType === null || body.hireType === undefined || body.hireType === "" ? null : oneOf(body.hireType, "hireType", ["direct_hire", "eor"] as const);
      const mode = oneOf(body.schedulingMode, "schedulingMode", ["fixed", "flexible"] as const);
      const [result] = await tx((db) => rows(db, "select * from ogevia_api.set_caregiver_employment($1, $2, $3, $4, $5, $6)",
        [uuid(body.organizationId, "organizationId"), uuid(p(event).caregiverRecordId, "caregiverRecordId"), hire, mode, text(body.reason, "reason", 500), key]));
      return { result };
    },
  },

  // Caregiver compliance (0055): OWNER-DEFINED rules (approved background clearance; CPR/TB within 14 days of the hire date).
  // Every decision is made in PostgreSQL; these routes only validate input and shape output. Not stated as legal requirements.
  "GET /v1/caregivers/{caregiverRecordId}/compliance": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      compliance: await tx(async (db) => (await first(db, "select ogevia_api.get_caregiver_compliance($1,$2) as c", [orgParam(event), uuid(p(event).caregiverRecordId, "caregiverRecordId")])).c),
    }),
  },

  "POST /v1/caregivers/{caregiverRecordId}/hire-date": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      return {
        compliance: await tx(async (db) => (await first(db, "select ogevia_api.set_caregiver_hire_date($1,$2,$3::date,$4,$5) as c", [
          uuid(body.organizationId, "organizationId"), uuid(p(event).caregiverRecordId, "caregiverRecordId"), date(body.hireDate, "hireDate"),
          text(body.reason, "reason", 500, { required: true }), key])).c),
      };
    },
  },

  "POST /v1/caregivers/{caregiverRecordId}/background-check/status": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      return {
        compliance: await tx(async (db) => (await first(db, "select ogevia_api.set_background_check_status($1,$2,$3,$4,$5) as c", [
          uuid(body.organizationId, "organizationId"), uuid(p(event).caregiverRecordId, "caregiverRecordId"),
          oneOf(body.status, "status", ["not_started", "requested", "submitted", "pending", "completed", "needs_attention"] as const),
          text(body.note, "note", 500), key])).c),
      };
    },
  },

  "POST /v1/caregivers/{caregiverRecordId}/background-check/verify": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      return {
        compliance: await tx(async (db) => (await first(db, "select ogevia_api.verify_background_check($1,$2,$3,$4,$5) as c", [
          uuid(body.organizationId, "organizationId"), uuid(p(event).caregiverRecordId, "caregiverRecordId"),
          oneOf(body.result, "result", ["approved", "not_approved"] as const), text(body.evidenceNote, "evidenceNote", 500, { required: true }), key])).c),
      };
    },
  },

  "GET /v1/compliance/holds": {
    mutating: false,
    handle: async ({ event, tx }) => ({ ...(await tx(async (db) => (await first(db, "select ogevia_api.list_compliance_holds($1) as h", [orgParam(event)])).h)) }),
  },

  // "Check now": re-evaluates this agency once. The scheduled run does the same for every agency.
  "POST /v1/compliance/sweep": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      return { result: await tx(async (db) => (await first(db, "select ogevia_api.run_compliance_sweep($1) as r", [uuid(body.organizationId, "organizationId")])).r) };
    },
  },

  "POST /v1/assignments/{assignmentId}/family-relationship": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const rel = body.relationship === null || body.relationship === undefined || body.relationship === "" ? null
        : oneOf(body.relationship, "relationship", ["none", "parent", "spouse_partner", "child", "sibling", "grandparent", "grandchild", "other_relative"] as const);
      const [result] = await tx((db) => rows(db, "select * from ogevia_api.set_assignment_family_relationship($1, $2, $3, $4)",
        [uuid(body.organizationId, "organizationId"), uuid(p(event).assignmentId, "assignmentId"), rel, key]));
      return { result };
    },
  },

  // Continuity pack (0027): continuity.export (Administrator, manager). The agency is checked
  // server-side from the caller's membership; the pack is returned, never stored or logged here.
  "POST /v1/continuity/pack": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const [row] = await tx((db) => rows(db, "select ogevia_api.create_continuity_pack($1, $2) as pack", [org, key]));
      return { pack: row?.pack ?? null };
    },
  },

  "GET /v1/continuity/status": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const [status] = await tx((db) => rows(db, "select * from ogevia_api.get_continuity_status($1)", [orgParam(event)]));
      return { status: status ?? null };
    },
  },

  // Outage visit records (0028): visits.manage. Each numbered paper record is entered once and
  // becomes a locked visit in administrator review with 0 billable minutes.
  "POST /v1/outage-visits": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const n = outageNumber(body.outageNumber);
      const params = [
        org, n, uuid(body.clientId, "clientId"), uuid(body.serviceId, "serviceId"), uuid(body.caregiverRecordId, "caregiverRecordId"),
        date(body.date, "date"), clockTime(body.timeIn, "timeIn"), clockTime(body.timeOut, "timeOut"),
        oneOf(body.paperConfirmation, "paperConfirmation", ["signature_on_form", "verbal", "unable_to_confirm", "declined"] as const),
        text(body.signerName, "signerName", 120), text(body.notes, "notes", 1000), key,
      ];
      const [visit] = await tx((db) => rows(db,
        "select * from ogevia_api.record_outage_visit($1, $2, $3, $4, $5, $6, $7::time, $8::time, $9, $10, $11, $12)", params));
      return { visit };
    },
  },

  "POST /v1/outage-visits/not-used": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const reason = text(body.reason, "reason", 500, { required: true });
      const [row] = await tx((db) => rows(db, "select * from ogevia_api.mark_outage_number_unused($1, $2, $3, $4)", [org, outageNumber(body.outageNumber), reason, key]));
      return { outageNumber: row?.outageNumber ?? null, state: row?.state ?? null };
    },
  },

  "GET /v1/outage-visits/reconciliation": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const openOnly = q(event).openOnly === "true";
      return { records: await tx((db) => rows(db, "select * from ogevia_api.list_outage_reconciliation($1, $2)", [orgParam(event), openOnly])) };
    },
  },

  // Monthly utilisation per service (0020): visits.read; dollar values only with billing.read (owner).
  "GET /v1/reports/utilisation": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const org = orgParam(event);
      const month = date(q(event).monthStart, "monthStart");
      return { services: await tx((db) => rows(db, "select * from ogevia_api.get_utilisation_overview($1, $2)", [org, month])) };
    },
  },

  "GET /v1/visits/active": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const org = orgParam(event);
      const [visit] = await tx((db) => rows(db, "select * from ogevia_api.get_active_service_visit($1)", [org]));
      return { visit: visit ?? null };
    },
  },

  "GET /v1/clients/assigned": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const org = orgParam(event);
      return { clients: await tx((db) => rows(db, "select * from ogevia_api.list_assigned_visit_clients($1)", [org])) };
    },
  },

  "GET /v1/clients/{clientId}/services": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const org = orgParam(event);
      const client = uuid(p(event).clientId, "clientId");
      return {
        services: await tx((db) => rows(db, "select * from ogevia_api.list_authorized_services_for_client($1, $2)", [org, client])),
      };
    },
  },

  "POST /v1/visits": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const client = uuid(body.clientId, "clientId");
      const service = uuid(body.serviceId, "serviceId");
      // Wave 1 (0050): a visit that matches no scheduled shift is provisional and needs a reason (the database refuses
      // it without one). A reason sent with a visit that DOES match a shift is ignored by the database.
      const unscheduledReason = text(body.unscheduledReason, "unscheduledReason", 500);
      // No time, duration or caregiver parameter exists: the server records
      // time_in and the caregiver from the verified identity.
      const visitId = await tx(async (db) => {
        const r = await db.query("select ogevia_api.start_ad_hoc_service_visit($1, $2, $3, '{}', null, $4, $5) as id", [org, client, service, key, unscheduledReason]);
        return (r.rows[0] as { id: string }).id;
      });
      return { visitId };
    },
  },

  "POST /v1/visits/{visitId}/end": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const visit = uuid(p(event).visitId, "visitId");
      const [ended] = await tx((db) => rows(db, "select * from ogevia_api.end_service_visit($1)", [visit]));
      return { visit: ended };
    },
  },

  // Manager close-out of a missed clock-out (0015): enters the actual Time
  // Out; the visit goes back to the caregiver for client confirmation.
  "POST /v1/visits/{visitId}/close": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const visit = uuid(p(event).visitId, "visitId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const timeOut = timestamp(body.timeOut, "timeOut");
      const reason = text(body.reason, "reason", 1000, { required: true });
      const [closed] = await tx((db) =>
        rows(db, "select * from ogevia_api.close_missed_service_visit($1, $2, $3, $4)", [visit, timeOut, reason, key]),
      );
      return { visit: closed };
    },
  },

  "POST /v1/visits/{visitId}/confirm": {
    mutating: true,
    handle: async ({ event, tx, evidence }) => {
      const visit = uuid(p(event).visitId, "visitId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const signerRole = oneOf(body.signerRole, "signerRole", SIGNER_ROLES);
      const method = oneOf(body.method, "method", METHODS);
      const typedName = text(body.typedSignerName, "typedSignerName", 200);
      const relationship = text(body.signerRelationship, "signerRelationship", 100);
      const reason = text(body.reason, "reason", 1000);
      // Wave 1 (0050): the caregiver's attestation. The version is fixed by the server, never taken from the client.
      // Absent or false is stored as "not recorded" so an older app version keeps working during a staged release.
      const attestationVersion = body.attested === true ? ATTESTATION_VERSION : null;
      const needsImage = method === "draw" || method === "assisted_mark";
      if (!needsImage && body.signaturePng !== undefined && body.signaturePng !== null) {
        throw new ApiError(422, "validation_failed", "A signature image is only accepted for drawn signatures or marks.");
      }

      const confirm = async (db: Queryable, evidenceId: string | null) => {
        const [result] = await rows(db, "select * from ogevia_api.confirm_service_visit($1, $2, $3, $4, $5, $6, $7, $8, $9)", [
          visit, signerRole, method, evidenceId, typedName, relationship, reason, key, attestationVersion,
        ]);
        return [await withOutcome(db, visit, result)];
      };
      // The stored result of a retried request, with the same extra fields the first answer carried.
      const withStoredOutcome = async (stored: Record<string, unknown> | undefined) =>
        stored ? tx((db) => withOutcome(db, visit, stored)) : stored;

      if (!needsImage) {
        const [result] = await tx((db) => confirm(db, null));
        return { result };
      }

      const signature = validateSignaturePng(body.signaturePng);
      const org = uuid(body.organizationId, "organizationId");
      const replay = () => tx((db) => rows(db, "select * from ogevia_api.get_confirmation_replay($1, $2)", [visit, key]));

      // 1. Retry of a request that already committed: return the stored result, no new upload.
      const [prior] = await replay();
      if (prior) return { result: await withStoredOutcome(prior) };

      // 2. Authority check BEFORE writing to S3: the visit must be the caller's
      //    own visit in this organization, waiting for a signature.
      const waiting = await tx(async (db) => {
        const r = await db.query("select visit_id, visit_status from ogevia_api.get_active_service_visit($1)", [org]);
        const mine = (r.rows as Array<{ visit_id: string; visit_status: string }>).find((v) => v.visit_id === visit);
        return !!mine && mine.visit_status === "awaiting_signature";
      });
      if (!waiting) {
        // A duplicate of this same request may have committed between the
        // replay check above and this check: return its stored result.
        const [committed] = await replay();
        if (committed) return { result: await withStoredOutcome(committed) };
        // One response for "not yours", "already locked" and "still running":
        // it reveals nothing about visits the caller does not own.
        throw new ApiError(409, "conflict", "This visit is not waiting for a confirmation.");
      }

      // 3. Private, KMS-encrypted, checksummed write. Key = UUIDs only.
      const objectKey = signatureObjectKey(org, visit);
      let versionId: string | null;
      try {
        ({ versionId } = await evidence.put(objectKey, signature.bytes, signature.sha256));
      } catch {
        throw new ApiError(503, "evidence_unavailable", "The signature could not be saved. Please try again.");
      }

      // 4. Register the exact object version and lock the visit in ONE transaction.
      try {
        const [result] = await tx(async (db) => {
          const r = await db.query("select ogevia_api.register_visit_evidence($1, $2, $3, 'image/png', $4, $5, $6) as id", [
            visit, objectKey, versionId, signature.bytes.length, signature.sha256Hex, key,
          ]);
          return confirm(db, (r.rows[0] as { id: string }).id);
        });
        return { result };
      } catch (error) {
        // A concurrent duplicate may have committed first with another object version.
        if ((error as { code?: string }).code === "OGI09" || (error as { code?: string }).code === "OGC09") {
          const [committed] = await replay();
          if (committed) return { result: await withStoredOutcome(committed) };
        }
        throw error;
      }
    },
  },

  "GET /v1/visits": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const query = q(event);
      const org = orgParam(event);
      const status = query.status ? oneOf(query.status, "status", VISIT_STATUSES) : null;
      const params = [
        org,
        optionalUuid(query.clientId, "clientId"),
        optionalUuid(query.caregiverUserId, "caregiverUserId"),
        optionalUuid(query.serviceId, "serviceId"),
        optionalDate(query.dateFrom, "dateFrom"),
        optionalDate(query.dateTo, "dateTo"),
        status,
      ];
      return { visits: await tx((db) => rows(db, "select * from ogevia_api.list_service_visits($1, $2, $3, $4, $5, $6, $7)", params)) };
    },
  },

  "GET /v1/visits/{visitId}/corrections": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const visit = uuid(p(event).visitId, "visitId");
      return { corrections: await tx((db) => rows(db, "select * from ogevia_api.list_visit_corrections($1)", [visit])) };
    },
  },

  "POST /v1/visits/{visitId}/corrections": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const visit = uuid(p(event).visitId, "visitId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const timeIn = timestamp(body.timeIn, "timeIn");
      const timeOut = timestamp(body.timeOut, "timeOut");
      const reason = text(body.reason, "reason", 1000, { required: true });
      const correctedVisitId = await tx(async (db) => {
        const r = await db.query("select ogevia_api.correct_service_visit($1, $2, $3, $4, $5) as id", [visit, timeIn, timeOut, reason, key]);
        return (r.rows[0] as { id: string }).id;
      });
      return { correctedVisitId };
    },
  },

  "GET /v1/visits/{visitId}/signature": {
    mutating: false,
    handle: async ({ event, tx, evidence }) => {
      const visit = uuid(p(event).visitId, "visitId");
      // Permission check + audit row commit first; only then is the object read.
      const [ref] = await tx((db) => rows(db, "select * from ogevia_api.get_visit_signature_evidence($1)", [visit]));
      const meta = ref as { objectKey: string; objectVersionId: string | null; sha256Hex: string };
      let object;
      try {
        object = await evidence.get(meta.objectKey, meta.objectVersionId);
      } catch {
        throw new ApiError(503, "evidence_unavailable", "The signature could not be loaded. Please try again.");
      }
      const { createHash } = await import("node:crypto");
      if (createHash("sha256").update(object.bytes).digest("hex") !== meta.sha256Hex) {
        // Integrity failure: never serve bytes that differ from what was registered.
        throw new ApiError(500, "evidence_integrity_failure", "The stored signature failed an integrity check.");
      }
      return { contentType: "image/png", sha256: meta.sha256Hex, pngBase64: object.bytes.toString("base64") };
    },
  },

  // 0030: approved minutes per authorization lineage (minutes only, never money).
  "GET /v1/reports/monthly-approval-summary": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const query = q(event);
      const org = orgParam(event);
      const client = optionalUuid(query.clientId, "clientId");
      const monthStart = date(query.monthStart, "monthStart");
      return {
        lineages: await tx((db) =>
          rows(db, "select * from ogevia_api.list_monthly_approval_summary($1, $2, $3)", [org, monthStart, client]),
        ),
      };
    },
  },

  "GET /v1/reports/monthly-service-summary": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const query = q(event);
      const org = orgParam(event);
      const client = optionalUuid(query.clientId, "clientId");
      const monthStart = date(query.monthStart, "monthStart");
      return {
        services: await tx((db) =>
          rows(db, "select * from ogevia_api.list_monthly_service_summary($1, $2, $3)", [
            org,
            monthStart,
            client,
          ]),
        ),
      };
    },
  },

  // Full-chain monthly report (0070): visits.read; billing-state columns need billing.visits.read.
  "GET /v1/reports/monthly-chain": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const query = q(event);
      const client = optionalUuid(query.clientId, "clientId");
      const monthStart = date(query.monthStart, "monthStart");
      return { rows: await tx((db) => rows(db, "select * from ogevia_api.get_monthly_chain_report($1, $2, $3)", [orgParam(event), monthStart, client])) };
    },
  },

  // The CSV of the full-chain report is generated HERE, and the export is authorized and recorded in the same transaction (0069): no permission, no file, no unrecorded file.
  "POST /v1/reports/monthly-chain/export": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const org = uuid(body.organizationId, "organizationId");
      const client = optionalUuid(body.clientId, "clientId");
      const monthStart = date(body.monthStart, "monthStart");
      const out = await tx(async (db) => {
        const data = await rows(db, "select * from ogevia_api.get_monthly_chain_report($1, $2, $3)", [org, monthStart, client]);
        const rec = (await db.query("select ogevia_api.record_report_export($1, 'monthly_chain', $2::jsonb, $3, 'server_generated') as r",
          [org, JSON.stringify({ monthStart, clientId: client }), data.length])).rows[0] as { r: { exportId: string; exportedAt: string } };
        return { data, rec: rec.r };
      });
      return { exportId: out.rec.exportId, exportedAt: out.rec.exportedAt, filename: `monthly-chain-${monthStart.slice(0, 7)}.csv`, csv: chainCsv(out.data) };
    },
  },

  // Browser-assembled exports (0069): the server authorizes and records the export first; the browser downloads nothing if this refuses.
  "POST /v1/exports": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const org = uuid(body.organizationId, "organizationId");
      const report = text(body.report, "report", 60, { required: true });
      const rowCount = Number(body.rowCount);
      if (!Number.isInteger(rowCount) || rowCount < 0) throw new ApiError(400, "bad_request", "rowCount must be a whole number.");
      const params = typeof body.params === "object" && body.params !== null ? body.params : {};
      const rec = await tx(async (db) =>
        ((await db.query("select ogevia_api.record_report_export($1, $2, $3::jsonb, $4, 'browser_assembled') as r", [org, report, JSON.stringify(params), rowCount])).rows[0] as { r: unknown }).r);
      return { export: rec };
    },
  },

  "GET /v1/exports": {
    mutating: false,
    handle: async ({ event, tx }) => ({ exports: await tx((db) => rows(db, "select * from ogevia_api.list_report_exports($1, 100)", [orgParam(event)])) }),
  },

  "GET /v1/reports/correction-history": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const query = q(event);
      const org = orgParam(event);
      const from = optionalDate(query.dateFrom, "dateFrom");
      const to = optionalDate(query.dateTo, "dateTo");
      if (from && to && from > to) {
        throw new ApiError(400, "bad_request", "dateFrom must not be after dateTo.");
      }
      return {
        corrections: await tx((db) =>
          rows(db, "select * from ogevia_api.list_correction_history_report($1, $2, $3, $4, $5, $6, $7, $8)", [
            org,
            from,
            to,
            optionalUuid(query.clientId, "clientId"),
            optionalUuid(query.serviceId, "serviceId"),
            optionalUuid(query.caregiverUserId, "caregiverUserId"),
            optionalUuid(query.correctedByUserId, "correctedByUserId"),
            query.status ? oneOf(query.status, "status", VISIT_STATUSES) : null,
          ]),
        ),
      };
    },
  },

  "GET /v1/billing-review": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const query = q(event);
      const org = orgParam(event);
      const from = date(query.dateFrom, "dateFrom");
      const to = date(query.dateTo, "dateTo");
      if (from > to) throw new ApiError(400, "bad_request", "dateFrom must not be after dateTo.");
      return { visits: await tx((db) => rows(db, "select * from ogevia_api.list_billing_review_visits($1, $2, $3)", [org, from, to])) };
    },
  },

  // Human billing approval (0019). Managers and owners approve the billable
  // minutes of a Billing Ready visit; dollar amounts are returned only to
  // holders of billing.read (owner). Approval is not payer submission.
  "GET /v1/billing-approvals": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const query = q(event);
      const org = orgParam(event);
      const from = date(query.dateFrom, "dateFrom");
      const to = date(query.dateTo, "dateTo");
      if (from > to) throw new ApiError(400, "bad_request", "dateFrom must not be after dateTo.");
      return { approvals: await tx((db) => rows(db, "select * from ogevia_api.list_billing_approvals($1, $2, $3)", [org, from, to])) };
    },
  },

  // Visit review (0031): why a visit needs review, the no-signer reason, and an explicit, audited
  // decision. Opening a visit changes nothing; nothing here creates a signature or a billing approval.
  "GET /v1/visits/{visitId}/review": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const visit = uuid(p(event).visitId, "visitId");
      const found = await tx((db) => rows(db, "select * from ogevia_api.get_visit_review($1)", [visit]));
      if (found.length === 0) throw new ApiError(404, "not_found", "Visit not found.");
      const [outcome] = await tx((db) => rows(db, "select * from ogevia_api.get_visit_outcome($1)", [visit]));
      return { visit: { ...found[0], ...(outcome ? { unscheduledReason: outcome.unscheduledReason, ruleVersion: outcome.ruleVersion, ruleMinutes: outcome.ruleMinutes, ruleSource: outcome.ruleSource, ruleOutcome: outcome.ruleOutcome, attestationVersion: outcome.attestationVersion } : {}) } };
    },
  },

  "POST /v1/visits/{visitId}/review-decision": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const visit = uuid(p(event).visitId, "visitId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const decision = oneOf(body.decision, "decision", ["accept_capped_billable", "close_not_billable"]);
      const reason = text(body.reason, "reason", 1000);
      const decisionId = await tx(async (db) => {
        const r = await db.query("select ogevia_api.decide_visit_review($1, $2, $3, $4) as id", [visit, decision, reason, key]);
        return (r.rows[0] as { id: string }).id;
      });
      return { decisionId };
    },
  },

  "POST /v1/visit-review-decisions/{decisionId}/revoke": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const decision = uuid(p(event).decisionId, "decisionId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const reason = text(body.reason, "reason", 1000);
      await tx((db) => db.query("select ogevia_api.revoke_visit_review_decision($1, $2, $3)", [decision, reason, key]));
      return { decisionId: decision, revoked: true };
    },
  },

  // Missing-signature recovery (0036): a staff-copied secure link plus a one-time code that staff
  // give by phone to a recipient they verified, or a paper form. Responses are reviewed by a person;
  // acceptance makes the visit eligible for the separate human billing approval, never approved.
  "POST /v1/visits/{visitId}/confirmation-requests": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const visit = uuid(p(event).visitId, "visitId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const channel = oneOf(body.channel, "channel", ["link", "paper"] as const);
      const recipientName = text(body.recipientName, "recipientName", 200, { required: true });
      const recipientRole = oneOf(body.recipientRole, "recipientRole", ["client", "parent", "guardian", "authorized_representative"] as const);
      const identityCheck = text(body.identityCheck, "identityCheck", 500);
      const days = body.expiresInDays;
      if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 30) {
        throw new ApiError(400, "bad_request", "expiresInDays must be a whole number from 1 to 30.");
      }
      // The token and code exist only in this response; the database keeps their hashes.
      const token = channel === "link" ? newOpaqueToken() : null;
      const code = channel === "link" ? String(randomInt(0, 1_000_000)).padStart(6, "0") : null;
      const tokenHash = token ? hashOpaqueToken(token) : null;
      const codeHash = token && code ? confirmationCodeHash(tokenHash!, code) : null;
      const [made] = await tx((db) =>
        rows(db, "select * from ogevia_api.create_visit_confirmation_request($1, $2, $3, $4, $5, $6, $7, $8, $9)", [
          visit, channel, recipientName, recipientRole, identityCheck, tokenHash, codeHash, days, key,
        ]),
      );
      const request = made as { requestId: string; expiresAt: string; isNew: boolean };
      // A retried request returns the one already made; its link cannot be shown again.
      return request.isNew
        ? { requestId: request.requestId, expiresAt: request.expiresAt, token, code }
        : { requestId: request.requestId, expiresAt: request.expiresAt, token: null, code: null, linkAlreadyShown: channel === "link" };
    },
  },

  "GET /v1/visits/{visitId}/confirmation-requests": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const visit = uuid(p(event).visitId, "visitId");
      return { requests: await tx((db) => rows(db, "select * from ogevia_api.list_visit_confirmation_requests($1)", [visit])) };
    },
  },

  "POST /v1/visit-confirmation-requests/{requestId}/revoke": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const requestId = uuid(p(event).requestId, "requestId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const reason = text(body.reason, "reason", 500, { required: true });
      await tx((db) => db.query("select ogevia_api.revoke_visit_confirmation_request($1, $2, $3)", [requestId, reason, key]));
      return { requestId, revoked: true };
    },
  },

  "POST /v1/visit-confirmation-requests/{requestId}/paper": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx, evidence }) => {
      const requestId = uuid(p(event).requestId, "requestId");
      const body = parseBody(event.body, event.isBase64Encoded, 5_600_000);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const signerName = text(body.signerName, "signerName", 200, { required: true });
      const signerRole = oneOf(body.signerRole, "signerRole", ["client", "parent", "guardian", "authorized_representative"] as const);
      const signedOn = date(body.signedOn, "signedOn");
      const file = validateDocumentFile(body.fileBase64, body.contentType);
      // Authority and the request's state are checked BEFORE anything is stored.
      await tx((db) => db.query("select ogevia_api.check_paper_confirmation_upload($1, $2)", [requestId, org]));
      // A retry with the same key uses the same id, so it stores the same object and returns the same record.
      const lateId = key ? stableUuid(`paper:${requestId}:${key}`) : randomUUID();
      const objectKey = `${org}/documents/${lateId}/paper-form`;
      let s3VersionId: string | null;
      try {
        ({ versionId: s3VersionId } = await evidence.put(objectKey, file.bytes, file.sha256, file.contentType));
      } catch {
        throw new ApiError(503, "storage_unavailable", "The form could not be stored. Nothing was saved; please try again.");
      }
      const id = await tx(async (db) => {
        const r = await db.query("select ogevia_api.record_paper_visit_confirmation($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as id", [
          requestId, lateId, signerName, signerRole, signedOn, objectKey, s3VersionId, file.contentType, file.bytes.length, file.sha256Hex, key,
        ]);
        return (r.rows[0] as { id: string }).id;
      });
      return { lateConfirmationId: id };
    },
  },

  "POST /v1/late-confirmations/{lateConfirmationId}/review": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const lateId = uuid(p(event).lateConfirmationId, "lateConfirmationId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const outcome = oneOf(body.outcome, "outcome", ["accepted", "rejected"] as const);
      const reason = text(body.reason, "reason", 1000, { required: true });
      const [result] = await tx((db) => rows(db, "select * from ogevia_api.review_late_visit_confirmation($1, $2, $3, $4)", [lateId, outcome, reason, key]));
      return { review: result };
    },
  },

  "GET /v1/late-confirmations/{lateConfirmationId}/evidence": {
    mutating: false,
    handle: async ({ event, tx, evidence }) => {
      const lateId = uuid(p(event).lateConfirmationId, "lateConfirmationId");
      const [meta] = await tx((db) => rows(db, "select * from ogevia_api.get_late_confirmation_evidence($1)", [lateId]));
      if (!meta) throw new ApiError(404, "not_found", "No signature or form is stored for this response.");
      let stored;
      try {
        stored = await evidence.get(meta.objectKey as string, (meta.versionId as string | null) ?? null, MAX_DOCUMENT_BYTES);
      } catch {
        throw new ApiError(503, "evidence_unavailable", "The file could not be loaded. Please try again.");
      }
      const digest = createHash("sha256").update(stored.bytes).digest("hex");
      if (digest !== meta.sha256) throw new ApiError(500, "integrity_error", "The stored file failed its integrity check.");
      return { contentType: meta.contentType, fileBase64: stored.bytes.toString("base64") };
    },
  },

  "POST /v1/visits/{visitId}/billing-approval": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const visit = uuid(p(event).visitId, "visitId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const minutes = body.approvedMinutes;
      if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
        throw new ApiError(400, "bad_request", "approvedMinutes must be a whole number of minutes.");
      }
      const notes = text(body.notes, "notes", 1000);
      const billingApprovalId = await tx(async (db) => {
        const r = await db.query("select ogevia_api.approve_visit_for_billing($1, $2, $3, $4) as id", [visit, minutes, notes, key]);
        return (r.rows[0] as { id: string }).id;
      });
      return { billingApprovalId };
    },
  },

  // Billing rounding (0029). Policies: Administrator only (billing.rounding.manage), each change a new
  // dated version that records the payer rule. Adjustments: billing.approve, computed by the server,
  // separate from the visit approval; clock times, worked and billable minutes are never changed.
  "GET /v1/billing-rounding/policies": {
    mutating: false,
    handle: async ({ event, tx }) => ({ policies: await tx((db) => rows(db, "select * from ogevia_api.list_billing_rounding_policies($1)", [orgParam(event)])) }),
  },

  "POST /v1/billing-rounding/policies": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const method = oneOf(body.method, "method", ["none", "nearest", "up", "down"] as const);
      const inc = body.incrementMinutes === null || body.incrementMinutes === undefined ? null : body.incrementMinutes;
      if (inc !== null && (typeof inc !== "number" || !Number.isInteger(inc))) throw new ApiError(400, "bad_request", "incrementMinutes must be a whole number of minutes.");
      const basis = method === "none" ? null : oneOf(body.basis, "basis", ["per_visit", "daily_total"] as const);
      const [policy] = await tx((db) => rows(db,
        "select * from ogevia_api.set_billing_rounding_policy($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        [uuid(body.organizationId, "organizationId"), text(body.payer, "payer", 200, { required: true }), uuid(body.serviceId, "serviceId"), method, inc, basis,
         text(body.payerRuleReference, "payerRuleReference", 500), optionalDate(body.payerRuleDate, "payerRuleDate"),
         date(body.effectiveFrom, "effectiveFrom"), text(body.reason, "reason", 1000, { required: true }), key]));
      return { policy };
    },
  },

  "GET /v1/billing-rounding/preview": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const query = q(event);
      return { units: await tx((db) => rows(db, "select * from ogevia_api.list_billing_rounding_preview($1, $2, $3)",
        [orgParam(event), date(query.from, "from"), date(query.to, "to")])) };
    },
  },

  "POST /v1/billing-rounding/adjustments": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const visit = optionalUuid(body.visitId, "visitId");
      const lineage = optionalUuid(body.authorizationLineageId, "authorizationLineageId");
      const day = optionalDate(body.serviceDate, "serviceDate");
      if (!visit && !(lineage && day)) throw new ApiError(400, "bad_request", "Give visitId, or authorizationLineageId and serviceDate for a daily total.");
      const [adjustment] = await tx((db) => rows(db,
        "select * from ogevia_api.approve_billing_rounding_adjustment($1, $2, $3, $4, $5, $6)",
        [uuid(body.organizationId, "organizationId"), visit, visit ? null : lineage, visit ? null : day, text(body.notes, "notes", 1000), key]));
      return { adjustment };
    },
  },

  "POST /v1/billing-rounding/adjustments/{adjustmentId}/void": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const id = uuid(p(event).adjustmentId, "adjustmentId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const reason = text(body.reason, "reason", 1000, { required: true });
      const adjustmentId = await tx(async (db) => ((await db.query("select ogevia_api.void_billing_rounding_adjustment($1, $2, $3) as id", [id, reason, key])).rows[0] as { id: string }).id);
      return { adjustmentId };
    },
  },

  "POST /v1/billing-approvals/{approvalId}/void": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const approval = uuid(p(event).approvalId, "approvalId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const reason = text(body.reason, "reason", 1000, { required: true });
      const billingApprovalId = await tx(async (db) => {
        const r = await db.query("select ogevia_api.void_billing_approval($1, $2, $3) as id", [approval, reason, key]);
        return (r.rows[0] as { id: string }).id;
      });
      return { billingApprovalId };
    },
  },

  // Staff documents (0021): request -> upload -> review. Files live in the
  // private evidence bucket under {org}/documents/{document}/{version};
  // the database authorizes every read and write.
  "GET /v1/document-types": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      types: await tx((db) => rows(db, "select * from ogevia_api.list_document_types($1)", [orgParam(event)])),
    }),
  },

  // 0033: reminder thresholds (days before expiry) for the agency (documentTypeId null) or one
  // document type (days null = use the agency default). Screens only; nothing is emailed.
  "POST /v1/document-reminder-days": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const type = body.documentTypeId === null || body.documentTypeId === undefined ? null : uuid(body.documentTypeId, "documentTypeId");
      let days: number[] | null = null;
      if (body.days !== null && body.days !== undefined) {
        if (!Array.isArray(body.days) || body.days.length === 0 || body.days.length > 8
          || !body.days.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= 365)) {
          throw new ApiError(400, "bad_request", "days must be 1 to 8 whole numbers from 1 to 365.");
        }
        days = body.days as number[];
      }
      const saved = await tx(async (db) => {
        const r = await db.query("select ogevia_api.set_document_reminder_days($1, $2, $3::integer[], $4) as d", [org, type, days, key]);
        return (r.rows[0] as { d: number[] | null }).d;
      });
      return { days: saved };
    },
  },

  "POST /v1/document-types": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const name = text(body.name, "name", 80, { required: true });
      const requiresExpiry = booleanValue(body.requiresExpiry, "requiresExpiry");
      const documentTypeId = await tx(async (db) => {
        const r = await db.query("select ogevia_api.create_document_type($1, $2, $3, $4) as id", [org, name, requiresExpiry, key]);
        return (r.rows[0] as { id: string }).id;
      });
      return { documentTypeId };
    },
  },

  "GET /v1/documents/people": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      people: await tx((db) => rows(db, "select * from ogevia_api.list_document_people($1)", [orgParam(event)])),
    }),
  },

  "GET /v1/documents": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      documents: await tx((db) => rows(db, "select * from ogevia_api.list_staff_documents($1)", [orgParam(event)])),
    }),
  },

  "GET /v1/documents/alerts": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const [alerts] = await tx((db) => rows(db, "select * from ogevia_api.get_document_alerts($1)", [orgParam(event)]));
      return { alerts: alerts ?? null };
    },
  },

  "POST /v1/documents/requests": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const person = uuid(body.caregiverRecordId, "caregiverRecordId");
      const type = uuid(body.documentTypeId, "documentTypeId");
      const dueOn = optionalDate(body.dueOn, "dueOn");
      const documentId = await tx(async (db) => {
        const r = await db.query("select ogevia_api.request_staff_document($1, $2, $3, $4, $5) as id", [org, person, type, dueOn, key]);
        return (r.rows[0] as { id: string }).id;
      });
      return { documentId };
    },
  },

  "POST /v1/documents/{documentId}/versions": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx, evidence }) => {
      const documentId = uuid(p(event).documentId, "documentId");
      // 4 MB as base64 (+33%) plus the JSON fields; under the 6 MB Lambda payload limit.
      const body = parseBody(event.body, event.isBase64Encoded, 5_600_000);
      const key = idempotencyKey(event.headers);
      const org = uuid(body.organizationId, "organizationId");
      const issuedOn = optionalDate(body.issuedOn, "issuedOn");
      const expiresOn = optionalDate(body.expiresOn, "expiresOn");
      const file = validateDocumentFile(body.fileBase64, body.contentType);

      // 1. Retry of a request that already committed: return it, store nothing again.
      const replay = () => tx((db) => rows(db, "select * from ogevia_api.get_document_upload_replay($1, $2)", [documentId, key]));
      const [prior] = await replay();
      if (prior) return { version: prior };

      // 2. Authority and the cheap checks BEFORE writing to S3.
      const [doc] = await tx((db) =>
        rows(db, "select * from ogevia_api.list_staff_documents($1) where document_id = $2", [org, documentId]),
      );
      if (!doc) throw new ApiError(404, "not_found", "Document not found.");
      if (doc.requiresExpiry && !expiresOn) throw new ApiError(422, "validation_failed", "This document type needs its expiry date.");
      if (issuedOn && expiresOn && expiresOn <= issuedOn) throw new ApiError(422, "validation_failed", "The expiry date must be after the issue date.");

      // 3. Store the file (SSE-KMS, checksum enforced), then record it.
      const versionId = randomUUID();
      const objectKey = documentObjectKey(org, documentId, versionId);
      let s3VersionId: string | null;
      try {
        ({ versionId: s3VersionId } = await evidence.put(objectKey, file.bytes, file.sha256, file.contentType));
      } catch {
        throw new ApiError(503, "storage_unavailable", "The file could not be stored. Nothing was saved; please try again.");
      }
      const [version] = await tx((db) =>
        rows(db, "select * from ogevia_api.register_document_version($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)", [
          documentId, versionId, objectKey, s3VersionId, file.contentType, file.bytes.length, file.sha256Hex, issuedOn, expiresOn, key,
        ]),
      );
      return { version };
    },
  },

  "POST /v1/document-versions/{versionId}/review": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const versionId = uuid(p(event).versionId, "versionId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const decision = oneOf(body.decision, "decision", ["verified", "rejected"] as const);
      const reason = text(body.reason, "reason", 1000);
      const result = await tx(async (db) => {
        const r = await db.query("select ogevia_api.review_document_version($1, $2, $3, $4) as d", [versionId, decision, reason, key]);
        return (r.rows[0] as { d: string }).d;
      });
      return { decision: result };
    },
  },

  "GET /v1/document-versions/{versionId}/file": {
    mutating: false,
    handle: async ({ event, tx, evidence }) => {
      const versionId = uuid(p(event).versionId, "versionId");
      // Authorized and audited in the database before any S3 read.
      const [meta] = await tx((db) => rows(db, "select * from ogevia_api.open_document_version($1)", [versionId]));
      if (!meta) throw new ApiError(404, "not_found", "Document not found.");
      const stored = await evidence.get(meta.objectKey as string, (meta.s3VersionId as string | null) ?? null, MAX_DOCUMENT_BYTES);
      const digest = createHash("sha256").update(stored.bytes).digest("hex");
      if (digest !== meta.sha256) throw new ApiError(500, "integrity_error", "The stored file failed its integrity check.");
      return { contentType: meta.contentType, fileBase64: stored.bytes.toString("base64"), sha256: digest };
    },
  },

  // Public visit confirmation (0036). The caller holds the link token AND the one-time code given by
  // phone. A wrong code is counted (5 lock the link) in a committed transaction, then refused.
  "POST /v1/public/visit-confirmations/{token}/open": {
    public: true,
    mutating: true,
    handle: async ({ event, tx }) => {
      const tokenHash = hashOpaqueToken(opaqueToken(p(event).token));
      const code = confirmationCode(parseBody(event.body, event.isBase64Encoded).code);
      const [found] = await tx((db) => rows(db, "select * from ogevia_api.public_open_visit_confirmation($1, $2)", [tokenHash, confirmationCodeHash(tokenHash, code)]));
      const visit = publicConfirmationOrThrow(found);
      const { organizationId: _org, status: _status, ...shown } = visit;
      return { visit: shown };
    },
  },

  "POST /v1/public/visit-confirmations/{token}/respond": {
    public: true,
    status: 201,
    mutating: true,
    handle: async ({ event, tx, evidence }) => {
      const tokenHash = hashOpaqueToken(opaqueToken(p(event).token));
      const body = parseBody(event.body, event.isBase64Encoded, 2_000_000);
      const codeHash = confirmationCodeHash(tokenHash, confirmationCode(body.code));
      const outcome = oneOf(body.outcome, "outcome", ["confirmed", "disputed"] as const);
      const method = outcome === "confirmed" ? oneOf(body.method, "method", ["draw", "typed"] as const) : null;
      const signerName = text(body.signerName, "signerName", 200, { required: true });
      const disputeReason = outcome === "disputed" ? text(body.disputeReason, "disputeReason", 1000, { required: true }) : null;
      const attested = body.attested === true;
      const responseKey = uuid(body.responseKey, "responseKey");
      const signature = method === "draw" ? validateSignaturePng(body.signaturePng) : null;
      if (method !== "draw" && body.signaturePng !== undefined && body.signaturePng !== null) {
        throw new ApiError(422, "validation_failed", "A signature image is only accepted for a drawn signature.");
      }
      // Check the link and code (a wrong code is counted and committed) before storing anything.
      const [found] = await tx((db) => rows(db, "select * from ogevia_api.public_open_visit_confirmation($1, $2)", [tokenHash, codeHash]));
      // A retry after the response was recorded: the link is answered, so look the response up by its key.
      const lateId = stableUuid(`late:${tokenHash}:${responseKey}`);
      let objectKey: string | null = null;
      let s3VersionId: string | null = null;
      if (found?.status === "ok" && signature) {
        objectKey = signatureObjectKey(found.organizationId as string, lateId);
        try {
          ({ versionId: s3VersionId } = await evidence.put(objectKey, signature.bytes, signature.sha256));
        } catch {
          throw new ApiError(503, "evidence_unavailable", "The signature could not be saved. Nothing was recorded; please try again.");
        }
      } else if (found?.status !== "ok" && found?.status !== "unavailable") {
        publicConfirmationOrThrow(found);
      }
      const [result] = await tx((db) =>
        rows(db, "select * from ogevia_api.public_respond_visit_confirmation($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)", [
          tokenHash, codeHash, lateId, outcome, method, signerName, disputeReason, attested,
          objectKey, s3VersionId, signature ? signature.bytes.length : null, signature ? signature.sha256Hex : null, responseKey,
        ]),
      );
      publicConfirmationOrThrow(result);
      return { received: true, outcome };
    },
  },

  "GET /v1/public/care-portals/{token}": {
    public: true,
    mutating: false,
    handle: async ({ event, tx }) => {
      const token = opaqueToken(p(event).token);
      return { services: await tx((db) => rows(db, "select * from ogevia_api.get_public_care_portal($1)", [hashOpaqueToken(token)])) };
    },
  },

  /** Upcoming requests made through THIS link, so a family can return to check status or cancel. */
  "GET /v1/public/care-portals/{token}/requests": {
    public: true,
    mutating: false,
    handle: async ({ event, tx }) => {
      const token = opaqueToken(p(event).token);
      return { requests: await tx((db) => rows(db, "select * from ogevia_api.public_list_care_requests($1)", [hashOpaqueToken(token)])) };
    },
  },

  "POST /v1/public/care-portals/{token}/requests": {
    public: true,
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const token = opaqueToken(p(event).token);
      const body = parseBody(event.body, event.isBase64Encoded);
      const params = [
        hashOpaqueToken(token),
        uuid(body.serviceId, "serviceId"),
        timestamp(body.startsAt, "startsAt"),
        timestamp(body.endsAt, "endsAt"),
        text(body.note, "note", 1000),
        uuid(body.requestKey, "requestKey"),
      ];
      const [request] = await tx((db) => rows(db, "select * from ogevia_api.public_create_care_request($1,$2,$3,$4,$5,$6)", params));
      return { request };
    },
  },

  "GET /v1/public/care-portals/{token}/requests/{requestId}": {
    public: true,
    mutating: false,
    handle: async ({ event, tx }) => {
      const token = opaqueToken(p(event).token);
      const requestId = uuid(p(event).requestId, "requestId");
      const [request] = await tx((db) => rows(db, "select * from ogevia_api.public_get_care_request($1,$2)", [hashOpaqueToken(token), requestId]));
      if (!request) throw new ApiError(404, "not_found", "Care request not found.");
      return { request };
    },
  },

  "POST /v1/public/care-portals/{token}/requests/{requestId}/cancel": {
    public: true,
    mutating: true,
    handle: async ({ event, tx }) => {
      // Validate everything before touching the database (anonymous route).
      const params = [hashOpaqueToken(opaqueToken(p(event).token)), uuid(p(event).requestId, "requestId"), text(parseBody(event.body, event.isBase64Encoded).reason, "reason", 500)];
      const result = await tx(async (db) => {
        const row = await db.query("select ogevia_api.public_cancel_care_request($1,$2,$3) status", params);
        return toCamel(row.rows[0]);
      });
      return result;
    },
  },

  "GET /v1/public/care-offers/{token}": {
    public: true,
    mutating: false,
    handle: async ({ event, tx }) => {
      const tokenHash = hashOpaqueToken(opaqueToken(p(event).token));
      const [offer] = await tx((db) => rows(db, "select * from ogevia_api.public_get_care_offer($1)", [tokenHash]));
      if (!offer) throw new ApiError(404, "not_found", "Care opportunity not found.");
      return { offer };
    },
  },

  "POST /v1/public/care-offers/{token}/respond": {
    public: true,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const params = [hashOpaqueToken(opaqueToken(p(event).token)), booleanValue(body.available, "available"), text(body.note, "note", 500)];
      const result = await tx(async (db) => {
        const row = await db.query("select ogevia_api.public_respond_care_offer($1,$2,$3) status", params);
        return toCamel(row.rows[0]);
      });
      return result;
    },
  },

  "POST /v1/public/care-offers/{token}/cancel-assignment": {
    public: true,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const params = [hashOpaqueToken(opaqueToken(p(event).token)), text(body.reason, "reason", 500, { required: true })];
      const result = await tx(async (db) => {
        const row = await db.query("select ogevia_api.public_cancel_assigned_offer($1,$2) status", params);
        return toCamel(row.rows[0]);
      });
      return result;
    },
  },

  "GET /v1/care-requests": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const query = q(event);
      const status = query.status ? oneOf(query.status, "status", CARE_REQUEST_STATUSES) : null;
      return { requests: await tx((db) => rows(db, "select * from ogevia_api.list_care_requests($1,$2)", [orgParam(event), status])) };
    },
  },

  "GET /v1/care-requests/{requestId}/candidates": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      caregivers: await tx((db) => rows(db, "select * from ogevia_api.list_available_caregivers($1,$2)", [
        orgParam(event), uuid(p(event).requestId, "requestId"),
      ])),
    }),
  },

  "GET /v1/care-requests/{requestId}/offers": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      offers: await tx((db) => rows(db, "select * from ogevia_api.list_care_request_offers($1,$2)", [
        orgParam(event), uuid(p(event).requestId, "requestId"),
      ])),
    }),
  },

  "POST /v1/care-requests/{requestId}/offers": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const token = newOpaqueToken();
      const offerId = await tx(async (db) => {
        const result = await db.query("select ogevia_api.send_care_offer($1,$2,$3,$4) id", [
          uuid(body.organizationId, "organizationId"),
          uuid(p(event).requestId, "requestId"),
          uuid(body.caregiverRecordId, "caregiverRecordId"),
          hashOpaqueToken(token),
        ]);
        return String((result.rows[0] as { id: string }).id);
      });
      return { offer: { offerId, token } };
    },
  },

  "POST /v1/care-requests/{requestId}/assign": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const result = await tx(async (db) => {
        const row = await db.query("select ogevia_api.assign_care_request($1,$2,$3) shift_id", [
          uuid(body.organizationId, "organizationId"),
          uuid(p(event).requestId, "requestId"),
          uuid(body.offerId, "offerId"),
        ]);
        return toCamel(row.rows[0]);
      });
      return result;
    },
  },

  "GET /v1/care-portals/clients": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      clients: await tx((db) => rows(db, "select * from ogevia_api.list_client_portal_options($1)", [orgParam(event)])),
    }),
  },

  "POST /v1/care-portals/revoke": {
    // Revokes every active link for one client (e.g. a family link was shared
    // too widely). Naturally idempotent: revoking twice revokes nothing more.
    mutating: false,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const revoked = await tx(async (db) => {
        const r = await db.query("select ogevia_api.revoke_client_care_portals($1,$2) n", [
          uuid(body.organizationId, "organizationId"),
          uuid(body.clientId, "clientId"),
        ]);
        return Number((r.rows[0] as { n: number }).n);
      });
      return { revoked };
    },
  },

  "POST /v1/care-portals": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const token = newOpaqueToken();
      const portalId = await tx(async (db) => {
        const result = await db.query("select ogevia_api.create_client_care_portal($1,$2,$3,$4) id", [
          uuid(body.organizationId, "organizationId"),
          uuid(body.clientId, "clientId"),
          hashOpaqueToken(token),
          text(body.label, "label", 100),
        ]);
        return String((result.rows[0] as { id: string }).id);
      });
      return { portal: { portalId, token } };
    },
  },

  "GET /v1/care-alert-staff": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      staff: await tx((db) => rows(db, "select * from ogevia_api.list_care_alert_staff($1)", [orgParam(event)])),
    }),
  },

  "POST /v1/care-alert-staff": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      if (!Array.isArray(body.userIds)) throw new ApiError(400, "bad_request", "userIds must be an array.");
      const userIds = body.userIds.map((value) => uuid(value, "userId"));
      await tx((db) => db.query("select ogevia_api.replace_care_alert_staff($1,$2::uuid[])", [
        uuid(body.organizationId, "organizationId"), userIds,
      ]));
      return { saved: true };
    },
  },

  "GET /v1/care-notifications": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      notifications: await tx((db) => rows(db, "select * from ogevia_api.list_staff_care_notifications($1)", [orgParam(event)])),
    }),
  },

  "GET /v1/availability/me": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      windows: await tx((db) => rows(db, "select * from ogevia_api.get_my_availability($1)", [orgParam(event)])),
    }),
  },

  // Withdrawn in 0039: availability changes are requests that an administrator approves (POST /v1/availability/requests).
  // The route stays so an old client gets a clear, correct message instead of a missing-route error.
  "POST /v1/availability/me": {
    mutating: true,
    handle: async () => {
      throw new ApiError(422, "availability_requires_approval", "Availability changes need administrator approval. Use Request change.");
    },
  },

  "GET /v1/care-opportunities": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      opportunities: await tx((db) => rows(db, "select * from ogevia_api.list_my_care_opportunities($1)", [orgParam(event)])),
    }),
  },

  "POST /v1/care-opportunities/{offerId}/respond": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const result = await tx(async (db) => {
        const row = await db.query("select ogevia_api.respond_my_care_opportunity($1,$2,$3,$4) status", [
          uuid(body.organizationId, "organizationId"),
          uuid(p(event).offerId, "offerId"),
          booleanValue(body.available, "available"),
          text(body.note, "note", 500),
        ]);
        return toCamel(row.rows[0]);
      });
      return result;
    },
  },

  // ---------------------------------------------------------------------------
  // Caregiver-readiness release (migrations 0039-0043). Every decision is made in PostgreSQL; these routes
  // only validate the shape of the request. Nested JSON from the database is returned as it is stored
  // (window items use start_local / end_local).
  // ---------------------------------------------------------------------------

  "GET /v1/availability": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      availability: await tx(async (db) => (await first(db, "select ogevia_api.get_availability($1, $2) as a", [orgParam(event), optionalUuid(q(event).caregiverRecordId, "caregiverRecordId")])).a),
    }),
  },

  "POST /v1/availability/requests": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      if (!Array.isArray(body.windows)) throw new ApiError(400, "bad_request", "windows must be a list.");
      const requestId = await tx(async (db) => (await first(db, "select ogevia_api.request_availability_change($1,$2,$3::jsonb,$4::date,$5::date,$6,$7,$8) as id", [
        uuid(body.organizationId, "organizationId"), oneOf(body.kind, "kind", ["weekly", "date"] as const), JSON.stringify(body.windows),
        date(body.effectiveFrom, "effectiveFrom"), optionalDate(body.effectiveUntil, "effectiveUntil"), text(body.reason, "reason", 500, { required: true }),
        wholeNumber(body.baseVersion, "baseVersion", 0, 1_000_000), key])).id);
      return { requestId };
    },
  },

  "GET /v1/availability/requests": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const status = q(event).status;
      const wanted = status === undefined || status === "" ? "pending" : status === "all" ? null : oneOf(status, "status", ["pending", "approved", "declined", "withdrawn", "superseded"] as const);
      return { requests: await tx((db) => rows(db, "select * from ogevia_api.list_availability_requests($1, $2)", [orgParam(event), wanted])) };
    },
  },

  "GET /v1/availability/requests/{requestId}": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      preview: await tx(async (db) => (await first(db, "select ogevia_api.preview_availability_request($1,$2) as r", [orgParam(event), uuid(p(event).requestId, "requestId")])).r),
    }),
  },

  "POST /v1/availability/requests/{requestId}/withdraw": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      await tx((db) => db.query("select ogevia_api.withdraw_availability_request($1,$2)", [uuid(body.organizationId, "organizationId"), uuid(p(event).requestId, "requestId")]));
      return { withdrawn: true };
    },
  },

  "POST /v1/availability/requests/{requestId}/review": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      return { result: await tx(async (db) => (await first(db, "select ogevia_api.review_availability_request($1,$2,$3,$4,$5) as r", [
        uuid(body.organizationId, "organizationId"), uuid(p(event).requestId, "requestId"), oneOf(body.decision, "decision", ["approve", "decline"] as const),
        text(body.note, "note", 500), key])).r) };
    },
  },

  "POST /v1/caregivers/{caregiverRecordId}/availability": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      if (!Array.isArray(body.windows)) throw new ApiError(400, "bad_request", "windows must be a list.");
      return { result: await tx(async (db) => (await first(db, "select ogevia_api.set_availability_direct($1,$2,$3,$4::jsonb,$5::date,$6::date,$7,$8) as r", [
        uuid(body.organizationId, "organizationId"), uuid(p(event).caregiverRecordId, "caregiverRecordId"), oneOf(body.kind, "kind", ["weekly", "date"] as const),
        JSON.stringify(body.windows), date(body.effectiveFrom, "effectiveFrom"), optionalDate(body.effectiveUntil, "effectiveUntil"),
        text(body.reason, "reason", 500, { required: true }), key])).r) };
    },
  },

  "POST /v1/availability/overrides": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const overrideId = await tx(async (db) => (await first(db, "select ogevia_api.authorize_availability_override($1,$2,$3::timestamptz,$4::timestamptz,$5,$6) as id", [
        uuid(body.organizationId, "organizationId"), uuid(body.caregiverRecordId, "caregiverRecordId"), timestamp(body.rangeStart, "rangeStart"),
        timestamp(body.rangeEnd, "rangeEnd"), text(body.reason, "reason", 500, { required: true }), uuid(body.clientId, "clientId")])).id);
      return { overrideId };
    },
  },

  "GET /v1/caregiver-services": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      approvals: await tx((db) => rows(db, "select * from ogevia_api.list_caregiver_service_approvals($1, $2)", [orgParam(event), optionalUuid(q(event).caregiverRecordId, "caregiverRecordId")])),
    }),
  },

  "POST /v1/caregiver-services": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const approvalId = await tx(async (db) => (await first(db, "select ogevia_api.approve_caregiver_service($1,$2,$3,$4::date,$5::date,$6,$7) as id", [
        uuid(body.organizationId, "organizationId"), uuid(body.caregiverRecordId, "caregiverRecordId"), uuid(body.serviceId, "serviceId"),
        date(body.effectiveFrom, "effectiveFrom"), optionalDate(body.effectiveUntil, "effectiveUntil"), text(body.reason, "reason", 500, { required: true }), key])).id);
      return { approvalId };
    },
  },

  "POST /v1/caregiver-services/{approvalId}/revoke": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      return { result: await tx(async (db) => (await first(db, "select ogevia_api.revoke_caregiver_service($1,$2,$3,$4::date,$5) as r", [
        uuid(body.organizationId, "organizationId"), uuid(p(event).approvalId, "approvalId"), text(body.reason, "reason", 500, { required: true }),
        optionalDate(body.effectiveOn, "effectiveOn"), key])).r) };
    },
  },

  "GET /v1/caregiver-services/review": {
    mutating: false,
    handle: async ({ event, tx }) => ({ pairs: await tx((db) => rows(db, "select * from ogevia_api.list_service_review_pairs($1)", [orgParam(event)])) }),
  },

  "POST /v1/caregiver-services/bulk-approve": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      if (!Array.isArray(body.pairs)) throw new ApiError(400, "bad_request", "pairs must be a list.");
      const pairs = body.pairs.map((x) => {
        const o = (x ?? {}) as Record<string, unknown>;
        return { caregiverRecordId: uuid(o.caregiverRecordId, "caregiverRecordId"), serviceId: uuid(o.serviceId, "serviceId") };
      });
      return { result: await tx(async (db) => (await first(db, "select ogevia_api.bulk_approve_reviewed_services($1,$2::jsonb,$3,$4::date,$5,$6) as r", [
        uuid(body.organizationId, "organizationId"), JSON.stringify(pairs), wholeNumber(body.expectedCount, "expectedCount", 0, 200),
        date(body.effectiveFrom, "effectiveFrom"), text(body.reason, "reason", 500, { required: true }), key])).r) };
    },
  },

  "GET /v1/readiness/flags": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const kind = q(event).kind;
      return { flags: await tx((db) => rows(db, "select * from ogevia_api.list_readiness_flags($1, $2)", [orgParam(event), kind === undefined || kind === "" ? null : oneOf(kind, "kind", ["availability", "service", "document", "compliance"] as const)])) };
    },
  },

  "GET /v1/document-requirements": {
    mutating: false,
    handle: async ({ event, tx }) => ({ setup: await tx(async (db) => (await first(db, "select ogevia_api.get_work_requirement_setup($1) as s", [orgParam(event)])).s) }),
  },

  "POST /v1/document-requirements/type": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      await tx((db) => db.query("select ogevia_api.set_document_work_requirement($1,$2,$3,$4,$5)", [
        uuid(body.organizationId, "organizationId"), oneOf(body.requirement, "requirement", ["cpr", "tb"] as const), optionalUuid(body.documentTypeId, "documentTypeId"),
        text(body.reason, "reason", 500, { required: true }), key]));
      return { saved: true };
    },
  },

  "POST /v1/document-requirements/policy": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const days = body.validityDays === undefined || body.validityDays === null ? null : wholeNumber(body.validityDays, "validityDays", 1, 3650);
      await tx((db) => db.query("select ogevia_api.set_requirement_policy($1,$2,$3,$4,$5,$6)", [
        uuid(body.organizationId, "organizationId"), oneOf(body.requirement, "requirement", ["cpr", "tb"] as const),
        oneOf(body.validityBasis, "validityBasis", ["document_expiry", "issue_plus_days"] as const), days, text(body.reason, "reason", 500, { required: true }), key]));
      return { saved: true };
    },
  },

  "GET /v1/document-readiness": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const from = q(event).startsAt;
      const to = q(event).endsAt;
      return { readiness: await tx(async (db) => (await first(db, "select ogevia_api.get_document_readiness($1,$2,$3::timestamptz,$4::timestamptz) as r", [
        orgParam(event), optionalUuid(q(event).caregiverRecordId, "caregiverRecordId"),
        from ? timestamp(from, "startsAt") : null, to ? timestamp(to, "endsAt") : null])).r) };
    },
  },

  "GET /v1/document-readiness/all": {
    mutating: false,
    handle: async ({ event, tx }) => ({ caregivers: await tx((db) => rows(db, "select * from ogevia_api.list_document_readiness($1)", [orgParam(event)])) }),
  },

  "GET /v1/readiness": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      readiness: await tx(async (db) => {
        const org = orgParam(event);
        const status = (await first(db, "select ogevia_api.get_readiness_status($1) as s", [org])).s as Record<string, unknown>;
        // 0055: who would be held (background clearance, the 14-day CPR/TB period) before the owner switches enforcement on
        return { ...status, compliance: (await first(db, "select ogevia_api.get_compliance_summary($1) as s", [org])).s };
      }),
    }),
  },

  "POST /v1/readiness/activate": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      return { readiness: await tx(async (db) => (await first(db, "select ogevia_api.activate_readiness_enforcement($1,$2,$3) as s", [
        uuid(body.organizationId, "organizationId"), text(body.reason, "reason", 500, { required: true }), wholeNumber(body.expectedAffectedShifts, "expectedAffectedShifts", 0, 1_000_000)])).s) };
    },
  },

  "POST /v1/readiness/service-checks": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      return { readiness: await tx(async (db) => (await first(db, "select ogevia_api.set_service_checks($1,$2,$3) as s", [
        uuid(body.organizationId, "organizationId"), booleanValue(body.enabled, "enabled"), text(body.reason, "reason", 500, { required: true })])).s) };
    },
  },

  "POST /v1/readiness/evaluate": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const org = uuid(body.organizationId, "organizationId");
      const caregiver = uuid(body.caregiverRecordId, "caregiverRecordId");
      const service = optionalUuid(body.serviceId, "serviceId");
      const context = body.context === undefined ? "shift" : oneOf(body.context, "context", ["shift", "care_request", "reschedule", "series", "assignment", "visit_start"] as const);
      const exclude = optionalUuid(body.excludeShiftId, "excludeShiftId");
      const client = optionalUuid(body.clientId, "clientId");
      // Either exact instants, or the agency-local date and times the schedule screen uses (converted in the database).
      if (body.date !== undefined) {
        return { evaluation: await tx(async (db) => (await first(db, "select ogevia_api.evaluate_assignment_readiness_local($1,$2,$3,$4::date,$5::time,$6::time,$7,$8,$9) as r", [
          org, caregiver, service, date(body.date, "date"), clockTime(body.startTime, "startTime"), clockTime(body.endTime, "endTime"), context, exclude, client])).r) };
      }
      return { evaluation: await tx(async (db) => (await first(db, "select ogevia_api.evaluate_assignment_readiness($1,$2,$3,$4::timestamptz,$5::timestamptz,$6,$7,$8) as r", [
        org, caregiver, service, timestamp(body.startsAt, "startsAt"), timestamp(body.endsAt, "endsAt"), context, exclude, client])).r) };
    },
  },

  "POST /v1/matching/candidates": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      if (!Array.isArray(body.intervals) || body.intervals.length < 1 || body.intervals.length > 30) throw new ApiError(400, "bad_request", "intervals must list 1 to 30 time ranges.");
      const intervals = body.intervals.map((x, i) => {
        const o = (x ?? {}) as Record<string, unknown>;
        return { starts_at: timestamp(o.startsAt, `intervals[${i}].startsAt`), ends_at: timestamp(o.endsAt, `intervals[${i}].endsAt`) };
      });
      return { matches: await tx(async (db) => (await first(db, "select ogevia_api.match_caregivers($1,$2,$3,$4::jsonb,$5,$6) as r", [
        uuid(body.organizationId, "organizationId"), uuid(body.serviceId, "serviceId"), uuid(body.clientId, "clientId"), JSON.stringify(intervals),
        optionalUuid(body.careRequestId, "careRequestId"), text(body.ruleVersion, "ruleVersion", 60)])).r) };
    },
  },

  "GET /v1/care-requests/{requestId}/matches": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      matches: await tx(async (db) => (await first(db, "select ogevia_api.match_caregivers_for_request($1,$2,$3) as r", [orgParam(event), uuid(p(event).requestId, "requestId"), text(q(event).ruleVersion, "ruleVersion", 60)])).r),
    }),
  },

  "GET /v1/experience-tags": {
    mutating: false,
    handle: async ({ event, tx }) => ({ tags: await tx((db) => rows(db, "select * from ogevia_api.list_experience_tags($1)", [orgParam(event)])) }),
  },

  "POST /v1/experience-tags": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const tagId = await tx(async (db) => (await first(db, "select ogevia_api.create_experience_tag($1,$2) as id", [uuid(body.organizationId, "organizationId"), text(body.label, "label", 60, { required: true })])).id);
      return { tagId };
    },
  },

  "GET /v1/experience/me": {
    mutating: false,
    handle: async ({ event, tx }) => ({ experience: await tx(async (db) => (await first(db, "select ogevia_api.get_caregiver_experience($1, null) as e", [orgParam(event)])).e) }),
  },

  "POST /v1/experience/me": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      if (!Array.isArray(body.tagIds) || body.tagIds.length > 40) throw new ApiError(400, "bad_request", "tagIds must be a list of at most 40 tags.");
      const ids = body.tagIds.map((x) => uuid(x, "tagIds"));
      await tx((db) => db.query("select ogevia_api.report_my_experience($1,$2::uuid[])", [uuid(body.organizationId, "organizationId"), ids]));
      return { saved: true };
    },
  },

  "GET /v1/caregivers/{caregiverRecordId}/experience": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      experience: await tx(async (db) => (await first(db, "select ogevia_api.get_caregiver_experience($1,$2) as e", [orgParam(event), uuid(p(event).caregiverRecordId, "caregiverRecordId")])).e),
    }),
  },

  "POST /v1/caregivers/{caregiverRecordId}/experience/review": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      if (!Array.isArray(body.confirmedTagIds) || body.confirmedTagIds.length > 40) throw new ApiError(400, "bad_request", "confirmedTagIds must be a list of at most 40 tags.");
      const ids = body.confirmedTagIds.map((x) => uuid(x, "confirmedTagIds"));
      await tx((db) => db.query("select ogevia_api.review_caregiver_experience($1,$2,$3::uuid[],$4)", [
        uuid(body.organizationId, "organizationId"), uuid(p(event).caregiverRecordId, "caregiverRecordId"), ids, text(body.note, "note", 500)]));
      return { reviewed: true };
    },
  },

  "GET /v1/clients/{clientId}/experience-requirements": {
    mutating: false,
    handle: async ({ event, tx }) => ({
      requirements: await tx((db) => rows(db, "select * from ogevia_api.get_client_experience_requirements($1,$2)", [orgParam(event), uuid(p(event).clientId, "clientId")])),
    }),
  },

  "POST /v1/clients/{clientId}/experience-requirements": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      if (!Array.isArray(body.requirements) || body.requirements.length > 20) throw new ApiError(400, "bad_request", "requirements must be a list of at most 20 tags.");
      const list = body.requirements.map((x) => {
        const o = (x ?? {}) as Record<string, unknown>;
        return { tagId: uuid(o.tagId, "tagId"), mandatory: booleanValue(o.mandatory ?? false, "mandatory") };
      });
      await tx((db) => db.query("select ogevia_api.set_client_experience_requirements($1,$2,$3::jsonb,$4)", [
        uuid(body.organizationId, "organizationId"), uuid(p(event).clientId, "clientId"), JSON.stringify(list), text(body.reason, "reason", 500, { required: true })]));
      return { saved: true };
    },
  },

  "POST /v1/caregivers/{caregiverRecordId}/zip": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      await tx((db) => db.query("select ogevia_api.set_caregiver_zip($1,$2,$3)", [uuid(body.organizationId, "organizationId"), uuid(p(event).caregiverRecordId, "caregiverRecordId"), text(body.zip, "zip", 5, { required: true })]));
      return { saved: true };
    },
  },

  "GET /v1/caregivers/{caregiverRecordId}/zip": {
    mutating: false,
    handle: async ({ event, tx }) => ({ location: await tx(async (db) => (await first(db, "select ogevia_api.get_matching_zip($1,$2,'caregiver') as location", [orgParam(event), uuid(p(event).caregiverRecordId, "caregiverRecordId")])).location) }),
  },

  "GET /v1/clients/{clientId}/zip": {
    mutating: false,
    handle: async ({ event, tx }) => ({ location: await tx(async (db) => (await first(db, "select ogevia_api.get_matching_zip($1,$2,'client') as location", [orgParam(event), uuid(p(event).clientId, "clientId")])).location) }),
  },

  "POST /v1/clients/{clientId}/zip": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      await tx((db) => db.query("select ogevia_api.set_client_service_zip($1,$2,$3)", [uuid(body.organizationId, "organizationId"), uuid(p(event).clientId, "clientId"), text(body.zip, "zip", 5, { required: true })]));
      return { saved: true };
    },
  },

  "GET /v1/location-data": {
    mutating: false,
    handle: async ({ event, tx }) => ({ status: await tx(async (db) => (await first(db, "select ogevia_api.location_data_status($1) as s", [orgParam(event)])).s) }),
  },

};

export const ROUTE_KEYS = Object.keys(ROUTES).sort();
