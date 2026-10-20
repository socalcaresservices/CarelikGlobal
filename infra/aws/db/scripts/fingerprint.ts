// Ogevia schema fingerprint (library). READ-ONLY. A map of object key -> md5 over the parts of a database that a migration or rollback can change:
// columns, constraints, indexes, triggers, policies, function definitions and privileges, plus row count and content hash per ogevia table.
// Used to prove "the rollback restored the earlier schema exactly" and "the upgraded copy has the TEST schema" without printing any row content.
// Row hashes are md5 digests only; no value is returned.
import type { ClientBase } from "pg";

export type Fingerprint = Record<string, string>;

const SCHEMAS = "('ogevia','ogevia_api')";

async function section(client: ClientBase, prefix: string, sql: string, out: Fingerprint): Promise<void> {
  const { rows } = await client.query<{ k: string; h: string }>(sql);
  for (const r of rows) out[`${prefix}:${r.k}`] = r.h;
}

/** data: "hash" (default) = row count and content md5 per ogevia table; "counts" = row count only; false = schema only. */
export async function fingerprint(client: ClientBase, opts: { data?: boolean | "hash" | "counts" } = {}): Promise<Fingerprint> {
  const out: Fingerprint = {};
  await section(client, "column", `
    select table_schema || '.' || table_name || '.' || column_name as k,
           md5(concat_ws('|', data_type, udt_name, is_nullable, coalesce(column_default, ''), coalesce(character_maximum_length::text, ''))) as h
      from information_schema.columns where table_schema in ${SCHEMAS}`, out);
  await section(client, "constraint", `
    select c.conrelid::regclass::text || '.' || c.conname as k, md5(pg_get_constraintdef(c.oid)) as h
      from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ${SCHEMAS}`, out);
  await section(client, "index", `select schemaname || '.' || tablename || '.' || indexname as k, md5(indexdef) as h from pg_indexes where schemaname in ${SCHEMAS}`, out);
  await section(client, "trigger", `
    select t.tgrelid::regclass::text || '.' || t.tgname as k, md5(pg_get_triggerdef(t.oid)) as h
      from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
     where not t.tgisinternal and n.nspname in ${SCHEMAS}`, out);
  await section(client, "policy", `
    select schemaname || '.' || tablename || '.' || policyname as k, md5(concat_ws('|', cmd, roles::text, coalesce(qual, ''), coalesce(with_check, ''))) as h
      from pg_policies where schemaname in ${SCHEMAS}`, out);
  await section(client, "function", `
    select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as k,
           md5(pg_get_functiondef(p.oid) || '|' || coalesce(p.proacl::text, '')) as h
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ${SCHEMAS} and p.prokind = 'f'`, out);
  await section(client, "tableacl", `
    select n.nspname || '.' || c.relname as k, md5(coalesce(c.relacl::text, '') || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text) as h
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ${SCHEMAS} and c.relkind = 'r'`, out);
  if (opts.data !== false) {
    const tables = await client.query<{ s: string; t: string }>(`select schemaname as s, tablename as t from pg_tables where schemaname = 'ogevia' order by 1, 2`);
    for (const { s, t } of tables.rows) {
      const r = await client.query<{ n: string; h: string }>(`select count(*)::text as n, md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from ${s}.${t} x`);
      out[`data:${s}.${t}`] = opts.data === "counts" ? r.rows[0]!.n : `${r.rows[0]!.n}:${r.rows[0]!.h}`;
    }
  }
  return out;
}

/** Keys that differ (present on one side only, or with a different digest). */
export function diffFingerprints(a: Fingerprint, b: Fingerprint): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]).sort();
}
