import { createHash, randomBytes } from "node:crypto";
import type { Queryable } from "@carelik/auth/server";
import { ApiError } from "./errors";
import { signatureObjectKey, validateSignaturePng, type EvidenceStore } from "./evidence";
import type { HttpApiEvent } from "./http";
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
}

export interface Route {
  readonly status?: number;
  /** Public routes use an opaque, hashed capability token instead of Cognito. */
  readonly auth?: "jwt" | "public";
  /** Mutating routes require an Idempotency-Key header when the route calls idempotencyKey(). */
  readonly mutating: boolean;
  handle(ctx: RouteContext): Promise<unknown>;
}

const SIGNER_ROLES = ["client", "parent", "guardian", "authorized_representative"] as const;
const METHODS = ["draw", "assisted_mark", "typed", "verbal", "unable_to_confirm"] as const;
const VISIT_STATUSES = ["draft", "awaiting_signature", "signed", "administrator_review", "corrected", "voided"] as const;
const CARE_REQUEST_STATUSES = ["new", "awaiting_responses", "assigned", "cancelled", "closed"] as const;

const tokenHash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const newOpaqueToken = () => randomBytes(32).toString("base64url");
const capabilityToken = (value: unknown, name: string) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
    throw new ApiError(404, "not_found", `${name} is invalid or expired.`);
  }
  return value;
};

const camel = (key: string) => key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
/** snake_case DB row -> camelCase JSON. Values are passed through unchanged. */
export function toCamel(row: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([k, v]) => [camel(k), v]));
}

async function rows(db: Queryable, sql: string, params: unknown[]) {
  return (await db.query(sql, params)).rows.map(toCamel);
}

const q = (event: HttpApiEvent) => event.queryStringParameters ?? {};
const p = (event: HttpApiEvent) => event.pathParameters ?? {};
const orgParam = (event: HttpApiEvent) => uuid(q(event).organizationId, "organizationId");

/**
 * Route table keyed by the API Gateway routeKey. Every route here MUST also be
 * declared (with the JWT authorizer) in infra/aws/lib/service-verification-api-stack.ts;
 * a test enforces that the two lists are identical.
 */
export const ROUTES: Record<string, Route> = {
  "GET /v1/me": {
    mutating: false,
    handle: async ({ tx }) => ({
      memberships: await tx((db) => rows(db, "select * from ogevia_api.get_my_context()", [])),
    }),
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
      // No time, duration or caregiver parameter exists: the server records
      // time_in and the caregiver from the verified identity.
      const visitId = await tx(async (db) => {
        const r = await db.query("select ogevia_api.start_ad_hoc_service_visit($1, $2, $3, '{}', null, $4) as id", [org, client, service, key]);
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
      const needsImage = method === "draw" || method === "assisted_mark";
      if (!needsImage && body.signaturePng !== undefined && body.signaturePng !== null) {
        throw new ApiError(422, "validation_failed", "A signature image is only accepted for drawn signatures or marks.");
      }

      const confirm = (db: Queryable, evidenceId: string | null) =>
        rows(db, "select * from ogevia_api.confirm_service_visit($1, $2, $3, $4, $5, $6, $7, $8)", [
          visit, signerRole, method, evidenceId, typedName, relationship, reason, key,
        ]);

      if (!needsImage) {
        const [result] = await tx((db) => confirm(db, null));
        return { result };
      }

      const signature = validateSignaturePng(body.signaturePng);
      const org = uuid(body.organizationId, "organizationId");
      const replay = () => tx((db) => rows(db, "select * from ogevia_api.get_confirmation_replay($1, $2)", [visit, key]));

      // 1. Retry of a request that already committed: return the stored result, no new upload.
      const [prior] = await replay();
      if (prior) return { result: prior };

      // 2. Authority check BEFORE writing to S3: the visit must be the caller's
      //    own visit in this organization, waiting for a signature.
      await tx(async (db) => {
        const r = await db.query("select visit_id, visit_status from ogevia_api.get_active_service_visit($1)", [org]);
        const mine = (r.rows as Array<{ visit_id: string; visit_status: string }>).find((v) => v.visit_id === visit);
        // One response for "not yours", "already locked" and "still running":
        // it reveals nothing about visits the caller does not own.
        if (!mine || mine.visit_status !== "awaiting_signature") {
          throw new ApiError(409, "conflict", "This visit is not waiting for a confirmation.");
        }
      });

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
          if (committed) return { result: committed };
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

  "GET /v1/care-requests/clients": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const org = orgParam(event);
      return { clients: await tx((db) => rows(db, "select * from ogevia_api.list_care_request_clients($1)", [org])) };
    },
  },

  "POST /v1/clients/{clientId}/request-link": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const org = uuid(body.organizationId, "organizationId");
      const clientId = uuid(p(event).clientId, "clientId");
      const token = newOpaqueToken();
      const expiresAt = body.expiresAt ? timestamp(body.expiresAt, "expiresAt") : null;
      const [result] = await tx((db) =>
        rows(db, "select ogevia_api.create_client_request_link($1, $2, $3, $4) as link_id", [
          org, clientId, tokenHash(token), expiresAt,
        ]),
      );
      return { linkId: result.linkId, token };
    },
  },

  "GET /v1/care-requests": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const query = q(event);
      const org = orgParam(event);
      const status = query.status ? oneOf(query.status, "status", CARE_REQUEST_STATUSES) : null;
      return { requests: await tx((db) => rows(db, "select * from ogevia_api.list_care_requests($1, $2)", [org, status])) };
    },
  },

  "GET /v1/care-requests/{requestId}/candidates": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const requestId = uuid(p(event).requestId, "requestId");
      return { candidates: await tx((db) => rows(db, "select * from ogevia_api.list_care_request_candidates($1)", [requestId])) };
    },
  },

  "GET /v1/care-requests/{requestId}/offers": {
    mutating: false,
    handle: async ({ event, tx }) => {
      const requestId = uuid(p(event).requestId, "requestId");
      return { offers: await tx((db) => rows(db, "select * from ogevia_api.list_care_request_offers($1)", [requestId])) };
    },
  },

  "POST /v1/care-requests/{requestId}/offers": {
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const requestId = uuid(p(event).requestId, "requestId");
      const body = parseBody(event.body, event.isBase64Encoded);
      if (!Array.isArray(body.caregiverRecordIds) || body.caregiverRecordIds.length < 1 || body.caregiverRecordIds.length > 20) {
        throw new ApiError(400, "bad_request", "Select between 1 and 20 caregivers.");
      }
      const caregiverIds = body.caregiverRecordIds.map((value) => uuid(value, "caregiverRecordId"));
      const expiresAt = body.expiresAt ? timestamp(body.expiresAt, "expiresAt") : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const offers: Array<{ caregiverRecordId: string; offerId: unknown; token: string }> = [];
      await tx(async (db) => {
        for (const caregiverRecordId of caregiverIds) {
          const token = newOpaqueToken();
          const result = await db.query(
            "select ogevia_api.create_care_request_offer($1, $2, $3, $4) as offer_id",
            [requestId, caregiverRecordId, tokenHash(token), expiresAt],
          );
          offers.push({ caregiverRecordId, offerId: (result.rows[0] as { offer_id: unknown }).offer_id, token });
        }
      });
      return { offers, expiresAt };
    },
  },

  "POST /v1/care-requests/{requestId}/assign": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const requestId = uuid(p(event).requestId, "requestId");
      const body = parseBody(event.body, event.isBase64Encoded);
      const caregiverRecordId = uuid(body.caregiverRecordId, "caregiverRecordId");
      const [result] = await tx((db) =>
        rows(db, "select ogevia_api.assign_care_request($1, $2) as shift_id", [requestId, caregiverRecordId]),
      );
      return { shiftId: result.shiftId };
    },
  },

  "GET /public/request/{token}": {
    auth: "public",
    mutating: false,
    handle: async ({ event, tx }) => {
      const token = capabilityToken(p(event).token, "Request link");
      const [context] = await tx((db) =>
        rows(db, "select * from ogevia_api.public_request_link_context($1)", [tokenHash(token)]),
      );
      if (!context) throw new ApiError(404, "not_found", "Request link is invalid or expired.");
      return { context };
    },
  },

  "POST /public/request/{token}": {
    auth: "public",
    status: 201,
    mutating: true,
    handle: async ({ event, tx }) => {
      const token = capabilityToken(p(event).token, "Request link");
      const body = parseBody(event.body, event.isBase64Encoded);
      const key = idempotencyKey(event.headers);
      const serviceId = uuid(body.serviceId, "serviceId");
      const requestedStart = timestamp(body.requestedStart, "requestedStart");
      const requestedEnd = timestamp(body.requestedEnd, "requestedEnd");
      const note = text(body.note, "note", 1000);
      const [result] = await tx((db) =>
        rows(db, "select ogevia_api.public_create_care_request($1, $2, $3, $4, $5, $6) as request_id", [
          tokenHash(token), serviceId, requestedStart, requestedEnd, note, key,
        ]),
      );
      return { requestId: result.requestId };
    },
  },

  "POST /public/request/{token}/cancel": {
    auth: "public",
    mutating: true,
    handle: async ({ event, tx }) => {
      const token = capabilityToken(p(event).token, "Request link");
      const body = parseBody(event.body, event.isBase64Encoded);
      const requestId = uuid(body.requestId, "requestId");
      const reason = text(body.reason, "reason", 500) ?? "";
      await tx((db) =>
        rows(db, "select ogevia_api.public_cancel_care_request($1, $2, $3)", [tokenHash(token), requestId, reason]),
      );
      return { cancelled: true };
    },
  },

  "GET /public/opportunity/{token}": {
    auth: "public",
    mutating: false,
    handle: async ({ event, tx }) => {
      const token = capabilityToken(p(event).token, "Opportunity link");
      const [context] = await tx((db) =>
        rows(db, "select * from ogevia_api.public_offer_context($1)", [tokenHash(token)]),
      );
      if (!context) throw new ApiError(404, "not_found", "Opportunity link is invalid or expired.");
      return { context };
    },
  },

  "POST /public/opportunity/{token}/respond": {
    auth: "public",
    mutating: true,
    handle: async ({ event, tx }) => {
      const token = capabilityToken(p(event).token, "Opportunity link");
      const body = parseBody(event.body, event.isBase64Encoded);
      if (typeof body.available !== "boolean") throw new ApiError(400, "bad_request", "available must be true or false.");
      const [result] = await tx((db) =>
        rows(db, "select ogevia_api.public_respond_care_offer($1, $2) as status", [tokenHash(token), body.available]),
      );
      return { status: result.status };
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
};

export const ROUTE_KEYS = Object.keys(ROUTES).sort();
