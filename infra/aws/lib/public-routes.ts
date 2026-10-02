/**
 * The ONLY API routes allowed without the Cognito JWT authorizer.
 *
 * Each is a client/family care-request portal link or a caregiver offer link.
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
];

export const PUBLIC_ROUTE_ACKNOWLEDGEMENT =
  "Approved opaque-token care link (lib/public-routes.ts): possession of a 256-bit random link token, stored only as SHA-256 and validated in PostgreSQL for revocation, expiry and scope, replaces the Cognito authorizer for clients/families and caregivers without accounts.";
