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
const newOpaqueToken = () => randomBytes(32).toString("hex");
const hashOpaqueToken = (token: string) => createHash("sha256").update(token, "hex").digest("hex");

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

  "GET /v1/public/care-portals/{token}": {
    public: true,
    mutating: false,
    handle: async ({ event, tx }) => {
      const token = opaqueToken(p(event).token);
      return { services: await tx((db) => rows(db, "select * from ogevia_api.get_public_care_portal($1)", [hashOpaqueToken(token)])) };
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
      const body = parseBody(event.body, event.isBase64Encoded);
      const result = await tx(async (db) => {
        const row = await db.query("select ogevia_api.public_cancel_care_request($1,$2,$3) status", [
          hashOpaqueToken(opaqueToken(p(event).token)),
          uuid(p(event).requestId, "requestId"),
          text(body.reason, "reason", 500),
        ]);
        return toCamel(row.rows[0]);
      });
      return result;
    },
  },

  "GET /v1/public/care-offers/{token}": {
    public: true,
    mutating: false,
    handle: async ({ event, tx }) => {
      const [offer] = await tx((db) => rows(db, "select * from ogevia_api.public_get_care_offer($1)", [hashOpaqueToken(opaqueToken(p(event).token))]));
      if (!offer) throw new ApiError(404, "not_found", "Care opportunity not found.");
      return { offer };
    },
  },

  "POST /v1/public/care-offers/{token}/respond": {
    public: true,
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      const result = await tx(async (db) => {
        const row = await db.query("select ogevia_api.public_respond_care_offer($1,$2,$3) status", [
          hashOpaqueToken(opaqueToken(p(event).token)),
          booleanValue(body.available, "available"),
          text(body.note, "note", 500),
        ]);
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
      const result = await tx(async (db) => {
        const row = await db.query("select ogevia_api.public_cancel_assigned_offer($1,$2) status", [
          hashOpaqueToken(opaqueToken(p(event).token)),
          text(body.reason, "reason", 500, { required: true }),
        ]);
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
        return String(result.rows[0]!.id);
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
        return String(result.rows[0]!.id);
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

  "POST /v1/availability/me": {
    mutating: true,
    handle: async ({ event, tx }) => {
      const body = parseBody(event.body, event.isBase64Encoded);
      if (!Array.isArray(body.windows) || !Array.isArray(body.unavailableDates)) {
        throw new ApiError(400, "bad_request", "windows and unavailableDates must be arrays.");
      }
      await tx((db) => db.query("select ogevia_api.replace_my_availability($1,$2::jsonb,$3::jsonb)", [
        uuid(body.organizationId, "organizationId"),
        JSON.stringify(body.windows),
        JSON.stringify(body.unavailableDates),
      ]));
      return { saved: true };
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

};

export const ROUTE_KEYS = Object.keys(ROUTES).sort();
