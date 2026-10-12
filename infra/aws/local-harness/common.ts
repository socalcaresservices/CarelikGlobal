// LOCAL DEVELOPMENT HARNESS: shared constants. Never used by any deployed code.
// Everything here is synthetic. The sign-in service is a stand-in: it issues tokens that only this harness accepts.
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const HARNESS_DIR = fileURLToPath(new URL(".", import.meta.url));
export const LOCAL_DIR = join(HARNESS_DIR, ".local"); // certificates and the web build (git-ignored)
export const DIST_DIR = join(LOCAL_DIR, "dist");

export const DB_NAME = "ogevia_local_harness";
/** Administrator connection to a LOCAL PostgreSQL. Override with HARNESS_ADMIN_URL. */
export const ADMIN_URL = process.env.HARNESS_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";

export function databaseUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${DB_NAME}`;
  return url.toString();
}

/** The harness only ever touches a database on this computer. */
export function assertLocalDatabase(connectionString: string): void {
  const host = new URL(connectionString).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    throw new Error(`The local harness only connects to a database on this computer, not "${host}".`);
  }
}

// The web app validates its sign-in settings: the Cognito domain must be an https origin WITHOUT a port,
// so the harness serves everything from https://localhost (port 443).
export const PORT = 443;
export const ORIGIN = "https://localhost";
export const REGION = "us-west-2";
export const POOL_ID = "us-west-2_LOCALHARN"; // 9 characters after the underscore, as the app requires
export const CLIENT_ID = "localharness00000000000000"; // 26 lowercase letters and digits, as the app requires
export const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${POOL_ID}`;
export const ORG_SLUG = "local-demo";

export interface Persona {
  readonly key: string;
  readonly name: string;
  readonly sub: string;
  readonly role: "organization_owner" | "manager" | "scheduler" | "caregiver";
  readonly blurb: string;
  readonly caregiverCode?: string;
}

export const PERSONAS: readonly Persona[] = [
  { key: "owner", name: "Olivia Owner", sub: "11111111-0000-4000-8000-000000000001", role: "organization_owner", blurb: "Administrator: everything, including rates and billing" },
  { key: "manager", name: "Morgan Manager", sub: "11111111-0000-4000-8000-000000000002", role: "manager", blurb: "Manager: operations, no dollar values" },
  { key: "scheduler", name: "Sam Scheduler", sub: "11111111-0000-4000-8000-000000000003", role: "scheduler", blurb: "Scheduler: shifts and coverage" },
  { key: "alex", name: "Alex Caregiver", sub: "11111111-0000-4000-8000-0000000000a1", role: "caregiver", caregiverCode: "CG-ALEX", blurb: "Caregiver: can start and end a visit" },
  { key: "blair", name: "Blair Caregiver", sub: "11111111-0000-4000-8000-0000000000b2", role: "caregiver", caregiverCode: "CG-BLAIR", blurb: "Caregiver: has an unclosed visit from yesterday" },
];
