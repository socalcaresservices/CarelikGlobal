// PLACEHOLDER handler (Phase 4 not implemented). Returns 501 for every route and
// logs no request body, headers, or identity data (PHI-safe).
export const handler = async () => ({
  statusCode: 501,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ error: "not_implemented" }),
});
