import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useOrganization } from "@/providers/organization-provider";
import { supabase } from "@/lib/supabase";

// Backed by global_search(), a security-definer RPC (see
// supabase/migrations/20260719290000_global_search.sql) that unions
// across every table with a meaningful name/label, applying that
// table's own permission check (and own-row carve-out, where one
// exists) per row. Field names match the RPC's return columns, same
// snake_case convention every other RPC result in this app uses.
interface GlobalSearchResultRow {
  result_type: "client" | "caregiver" | "credential" | "authorization" | "incident";
  entity_id: string;
  title: string;
  subtitle: string | null;
}

const resultTypeLabels: Record<GlobalSearchResultRow["result_type"], string> = {
  client: "Client",
  caregiver: "Caregiver",
  credential: "Credential",
  authorization: "Authorization",
  incident: "Incident"
};

// Only clients and caregivers have their own detail page today; the
// rest route to their list page rather than a fabricated deep link.
function routeFor(result: GlobalSearchResultRow): string {
  switch (result.result_type) {
    case "client":
      return `/clients/${result.entity_id}`;
    case "caregiver":
      return `/team/${result.entity_id}`;
    case "credential":
      return "/credentials";
    case "authorization":
      return "/authorizations";
    case "incident":
      return "/incidents";
  }
}

export function GlobalSearch() {
  const navigate = useNavigate();
  const { activeOrganizationId } = useOrganization();
  const containerRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const searchQuery = useQuery({
    queryKey: ["global-search", activeOrganizationId, debouncedQuery],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("global_search", {
        target_organization_id: activeOrganizationId!,
        search_query: debouncedQuery
      });
      if (error) throw error;
      return (data ?? []) as GlobalSearchResultRow[];
    },
    enabled: !!activeOrganizationId && debouncedQuery.length >= 2
  });

  const results = searchQuery.data ?? [];

  function handleSelect(result: GlobalSearchResultRow) {
    setOpen(false);
    setQuery("");
    navigate(routeFor(result));
  }

  const showDropdown = open && debouncedQuery.length >= 2;

  return (
    <div ref={containerRef} className="relative w-full max-w-sm">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="search"
          aria-label="Search everything"
          placeholder="Search clients, caregivers, credentials…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          className="w-full rounded-lg border border-slate-200 py-1.5 pl-8 pr-3 text-sm text-slate-900"
        />
      </div>
      {showDropdown ? (
        <div className="absolute z-10 mt-1 w-full rounded-lg border border-slate-200 bg-white shadow-lg">
          {searchQuery.isLoading ? (
            <p className="px-3 py-2 text-sm text-slate-500">Searching…</p>
          ) : searchQuery.isError ? (
            <p className="px-3 py-2 text-sm text-red-700">Could not search.</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-2 text-sm text-slate-500">No matches for "{debouncedQuery}".</p>
          ) : (
            <ul className="max-h-80 overflow-y-auto py-1">
              {results.map((result) => (
                <li key={`${result.result_type}-${result.entity_id}`}>
                  <button
                    type="button"
                    onClick={() => handleSelect(result)}
                    className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-slate-50"
                  >
                    <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                      {resultTypeLabels[result.result_type]}
                    </span>
                    <span className="text-sm text-slate-900">{result.title}</span>
                    {result.subtitle ? (
                      <span className="text-xs text-slate-500">{result.subtitle}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
