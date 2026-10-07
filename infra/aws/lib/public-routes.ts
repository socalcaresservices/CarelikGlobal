/**
 * The ONLY API routes allowed without the Cognito JWT authorizer.
 *
 * Each is a client/family care-request portal link, a caregiver offer link, or
 * (0036, owner-approved 2026-10-05) a late visit-confirmation link. The visit
 * confirmation link additionally needs a 6-digit one-time code that staff give
 * by phone to a recipient they verified; the database keeps only
 * SHA-256(token hash + ":" + code), counts wrong codes and locks the link after 5
 * (ogevia.confirmation_request_check). Tests:
 * infra/aws/db/test/signature-recovery.db.test.ts.
 * The caller proves possession of a 256-bit random token carried in the
 * {token} path segment:
 * - the API accepts only 64 hex characters and sends PostgreSQL only SHA-256(token);
 * - the raw token is never stored or logged (access logs record the route template only);
 * - every database function resolves the token through ogevia.care_portal_by_token /
 *   ogevia.care_offer_by_token, which enforce revocation, expiry, active
 *   organization/client and the link's own client/offer scope.
 * Tests: infra/aws/db/test/care-token-security.db.test.ts.
 *
 * Adding a route here is a security decision: the template scanner, the
 * CDK stack, the handler table and the smoke suite all compare against this
 * exact list, so no other unauthenticated route can be synthesized.
 */
export const APPROVED_PUBLIC_ROUTE_KEYS: readonly string[] = [
  "GET /v1/public/care-portals/{token}",
  "GET /v1/public/care-portals/{token}/requests",
  "POST /v1/public/care-portals/{token}/requests",
  "GET /v1/public/care-portals/{token}/requests/{requestId}",
  "POST /v1/public/care-portals/{token}/requests/{requestId}/cancel",
  "GET /v1/public/care-offers/{token}",
  "POST /v1/public/care-offers/{token}/respond",
  "POST /v1/public/care-offers/{token}/cancel-assignment",
  "POST /v1/public/visit-confirmations/{token}/open",
  "POST /v1/public/visit-confirmations/{token}/respond",
];

export const PUBLIC_ROUTE_ACKNOWLEDGEMENT =
  "Approved opaque-token care link (lib/public-routes.ts): possession of a 256-bit random link token, stored only as SHA-256 and validated in PostgreSQL for revocation, expiry and scope, replaces the Cognito authorizer for clients/families and caregivers without accounts.";
