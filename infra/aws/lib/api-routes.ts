/** Phase 4 initial operations only (CLAUDE.md §14). Do not add routes without scope approval. */
export const API_ROUTES: ReadonlyArray<{ method: "GET" | "POST"; path: string; supabaseRpc: string }> = [
  { method: "GET", path: "/visits/active", supabaseRpc: "get_active_service_visit_v3" },
  { method: "GET", path: "/visit-clients", supabaseRpc: "list_assigned_visit_clients" },
  { method: "GET", path: "/clients/{clientId}/services", supabaseRpc: "list_authorized_services_for_client" },
  { method: "GET", path: "/shifts/scheduled", supabaseRpc: "list_scheduled_shifts_for_visit" },
  { method: "POST", path: "/visits/start", supabaseRpc: "start_ad_hoc_service_visit" },
  { method: "POST", path: "/visits/{visitId}/end", supabaseRpc: "end_service_visit" },
  { method: "POST", path: "/visits/{visitId}/confirm", supabaseRpc: "confirm_service_visit" },
  { method: "POST", path: "/visits/{visitId}/correct", supabaseRpc: "correct_service_visit" },
];
