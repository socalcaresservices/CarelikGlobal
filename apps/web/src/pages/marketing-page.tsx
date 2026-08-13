import { Link } from "react-router-dom";
import { useAuth } from "@carelik/auth";
import { Card, buttonVariants } from "@carelik/ui";
import { toAppUrl } from "@/lib/tenant-resolver";

// Public, unauthenticated marketing homepage - no AppShell/PlatformShell,
// no session required. Lives outside <ProtectedRoute> in App.tsx, and is
// only ever mounted on Ogevia's own platform-root hosts (App.tsx gates it
// on isPlatform) - a tenant subdomain's "/" still resolves to
// CommandCenterPage exactly as before, unaffected by this route.
//
// Ogevia-branded (not org-branded) - unlike apply-page.tsx/upload-page.tsx,
// there's no :orgSlug or :token to resolve branding from, so no RPC call
// on load. Same standalone outer-wrapper pattern those pages use.
//
// Every feature named below is a real, shipped page in this app - see
// tenant-routes.tsx for the routes and their migrations for the backing
// data. Nothing here is aspirational copy for an unbuilt feature.
const FEATURES = [
  {
    title: "CareScore matching",
    description:
      "A real, computed match score between every caregiver and client - proximity, language, availability, skills, and shared visit history - not a guess. Shown on both the scheduling screen and every caregiver's own profile."
  },
  {
    title: "Service Verification",
    description:
      "Caregivers clock in and out from their phone, capture a client or representative signature on the spot, and every visit is locked and auditable the moment it's signed."
  },
  {
    title: "Caregiver & client management",
    description:
      "One record for every caregiver and client - availability, credentials, authorizations, and history in one place, scoped so each agency only ever sees its own."
  },
  {
    title: "Compliance tracking",
    description:
      "Credentials, authorizations, and incidents tracked with real expiration and status - never a stale spreadsheet, always what's true right now."
  },
  {
    title: "Payroll & billing reports",
    description:
      "Signed visit sheets roll up into hours-by-caregiver and hours-by-client reports, ready for payroll and billing without re-entering anything."
  },
  {
    title: "Mobile caregiver workflow",
    description:
      "Built for a phone in the field, not a desktop shrunk down - large touch targets, plain language, and a schedule a caregiver can actually use standing in a doorway."
  },
  {
    title: "Security & audit history",
    description:
      "Every correction, signature, and administrative change is logged with who and when - nothing is silently overwritten."
  }
] as const;

export function MarketingPage() {
  const { user } = useAuth();

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-slate-200">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <p className="text-lg font-semibold text-slate-950">Ogevia</p>
          <nav className="flex items-center gap-4 text-sm font-medium text-slate-600">
            <Link to="/pricing" className="hover:text-slate-950">
              Pricing
            </Link>
            {user ? (
              <a href={toAppUrl()} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                Go to Ogevia
              </a>
            ) : (
              <Link to="/login" className={buttonVariants({ variant: "secondary", size: "sm" })}>
                Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>

      <section className="mx-auto max-w-4xl px-6 py-20 text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
          Care operations software for home care agencies
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-slate-600">
          Ogevia is built for home care and personal-assistance agencies - scheduling, real caregiver-client
          matching, mobile visit verification, compliance tracking, and the reports payroll and billing need,
          all in one place.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link to="/login" className={buttonVariants({ variant: "primary" })}>
            Sign in
          </Link>
          <Link to="/pricing" className={buttonVariants({ variant: "secondary" })}>
            View plans
          </Link>
        </div>
      </section>

      <section className="border-t border-slate-100 bg-slate-50">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-center text-2xl font-semibold text-slate-950">Everything an agency runs on</h2>
          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => (
              <Card key={feature.title} className="h-full">
                <h3 className="font-semibold text-slate-950">{feature.title}</h3>
                <p className="mt-2 text-sm text-slate-600">{feature.description}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-6 py-16 text-center">
        <h2 className="text-2xl font-semibold text-slate-950">Ready to get started?</h2>
        <p className="mt-3 text-slate-600">
          See what fits your agency on the <Link to="/pricing" className="underline">pricing page</Link>, or sign
          in if your organization already has an account.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link to="/pricing" className={buttonVariants({ variant: "primary" })}>
            View plans
          </Link>
          <Link to="/login" className={buttonVariants({ variant: "secondary" })}>
            Sign in
          </Link>
        </div>
      </section>

      <footer className="border-t border-slate-200 py-8 text-center text-xs text-slate-400">
        &copy; {new Date().getFullYear()} Ogevia
      </footer>
    </div>
  );
}
