// Static checks on the migration, rollback, and verification SQL. No
// database needed: runs in the default `pnpm test` (CI, Netlify).
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadMigrations } from "../scripts/migrations.js";

const migrations = loadMigrations();
const read = (dir: string) =>
  readdirSync(new URL(dir, import.meta.url))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({
      f,
      sql: readFileSync(new URL(`${dir}${f}`, import.meta.url), "utf8"),
    }));
const stripComments = (sql: string) => sql.replace(/--.*$/gm, "");

describe("migration files", () => {
  it("are contiguous, ordered NNNN_snake_case.sql files", () => {
    expect(migrations.map((m) => m.version)).toEqual(
      migrations.map((_, i) => String(i + 1).padStart(4, "0")),
    );
  });

  it("only 0001 runs as the administrator", () => {
    expect(
      migrations.filter((m) => m.runAsAdmin).map((m) => m.version),
    ).toEqual(["0001"]);
  });

  it("never manage their own transactions (the runner wraps each file)", () => {
    for (const m of migrations) {
      expect(stripComments(m.sql), m.name).not.toMatch(
        /^\s*(begin|commit|rollback)\s*;/im,
      );
    }
  });

  it("contain no Supabase runtime dependency", () => {
    for (const m of migrations) {
      const sql = stripComments(m.sql);
      expect(sql, m.name).not.toMatch(/\bauth\.(uid|users|jwt|role)\b/i);
      expect(sql, m.name).not.toMatch(
        /\bstorage\.(objects|buckets|foldername)\b/i,
      );
      expect(sql, m.name).not.toMatch(
        /\bto\s+(authenticated|anon|service_role)\b/i,
      );
      expect(sql, m.name).not.toMatch(/\bsupabase\b/i);
      expect(sql, m.name).not.toMatch(/\bpublic\.[a-z_]+\s*\(/i);
    }
  });

  it("pin search_path on every function and use SECURITY DEFINER for every ogevia_api function", () => {
    for (const m of migrations) {
      const blocks = stripComments(m.sql)
        .split(/(?=create (?:or replace )?function )/i)
        .slice(1);
      for (const block of blocks) {
        const header = block.slice(0, block.indexOf("$$"));
        expect(header, `${m.name}: ${header.slice(0, 80)}`).toMatch(
          /set search_path = ogevia, pg_temp/,
        );
        if (/function ogevia_api\./i.test(header)) {
          expect(header, header.slice(0, 80)).toMatch(/security definer/i);
        }
      }
    }
  });

  it("contain no credentials, passwords, or LOGIN grants", () => {
    for (const m of migrations) {
      const sql = stripComments(m.sql);
      expect(sql, m.name).not.toMatch(
        /\bpassword\b|\bwith\s+login\b|\blogin\s+password\b|AKIA[0-9A-Z]{16}/i,
      );
      expect(sql, m.name).not.toMatch(/create role \w+ login/i);
    }
  });

  it("never store binary signature data", () => {
    for (const m of migrations)
      expect(stripComments(m.sql), m.name).not.toMatch(/\bbytea\b/i);
  });
});

describe("verification and rollback files", () => {
  it("verification SQL is strictly read-only", () => {
    for (const { f, sql } of read("../verification/")) {
      expect(stripComments(sql), f).not.toMatch(
        /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|vacuum|reindex)\b/i,
      );
    }
  });

  it("every migration has a classified rollback", () => {
    const downs = read("../rollback/").map(({ f }) =>
      f.replace(".down.sql", ".sql"),
    );
    expect(downs.sort()).toEqual(migrations.map((m) => m.name));
  });
});

describe("test fixtures", () => {
  it("use synthetic data only (no realistic names, DOBs, or identifiers)", () => {
    const dir = new URL("./", import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(new URL(f, dir), "utf8");
      expect(src, f).not.toMatch(
        /\b(19|20)\d{2}-\d{2}-\d{2}\b.*\b(dob|birth)/i,
      );
      expect(src, f).not.toMatch(/\b(UCI|Medicaid|SSN)\s*[:=]\s*['"]?\d/i);
    }
  });
});
