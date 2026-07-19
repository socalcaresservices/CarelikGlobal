import { z } from "zod";

// Mirrors global_search()'s result columns (see
// supabase/migrations/20260719290000_global_search.sql). Every result
// type maps to an existing page/record - there's no result type for
// data that doesn't have a table yet (invoices, documents, visits).
export const globalSearchResultTypeSchema = z.enum([
  "client",
  "caregiver",
  "credential",
  "authorization",
  "incident"
]);
export type GlobalSearchResultType = z.infer<typeof globalSearchResultTypeSchema>;

export const globalSearchResultSchema = z.object({
  resultType: globalSearchResultTypeSchema,
  entityId: z.string().uuid(),
  title: z.string(),
  subtitle: z.string().nullable()
});
export type GlobalSearchResult = z.infer<typeof globalSearchResultSchema>;
