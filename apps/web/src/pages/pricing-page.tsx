import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card, buttonVariants } from "@carelik/ui";
import { FEATURE_LABELS, formatCents } from "@carelik/shared";
import { supabase } from "@/lib/supabase";

// Public, unauthenticated pricing page - same standalone pattern as
// marketing-page.tsx. Backed by list_public_plan_versions()
// (20260811041032_list_client_matches_for_caregiver.sql), an
// anon-callable RPC that returns only marketing-safe columns from
// plan_definitions for plans marked is_public/is_active/is_current -
// never hardcoded copy that could drift from what Settings -> Billing
// and the platform Plan Manager actually enforce.
//
// Real Stripe-hosted Checkout now exists (apps/netlify-functions), but
// it only ever sells Ogevia Starter - see create-checkout-session.ts's
// own comment for why (server-controlled STRIPE_STARTER_PRICE_ID, no
// plan picker). list_public_plan_versions() can still return other
// public plans (Grow/Pro/Scale) if the platform owner publishes them,
// but this page deliberately only renders the trial plan and Starter -
// showing a plan here that checkout can't actually sell would be
// misleading. Checkout itself is initiated from inside Settings ->
// Billing (an authenticated, permission-checked org context), not from
// here - an anonymous visitor has no organization for a subscription to
// attach to, so every CTA below still correctly links to /login.
const PURCHASABLE_PLAN_KEYS = new Set(["start"]);
interface PublicPlan {
  plan_key: string;
  name: string;
  description: string | null;
  monthly_price_cents: number;
  annual_price_cents: number;
  max_active_clients: number | null;
  max_active_caregivers: number | null;
  max_administrators: number | null;
  support_level: "standard" | "priority" | "dedicated";
  features: string[];
  is_trial: boolean;
  trial_duration_days: number | null;
  is_introductory: boolean;
}

function limitLabel(value: number | null) {
  return value === null ? "Unlimited" : value.toLocaleString();
}

export function PricingPage() {
  const plansQuery = useQuery({
    queryKey: ["public-plan-versions"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_public_plan_versions");
      if (error) throw error;
      return ((data ?? []) as PublicPlan[]).filter(
        (plan) => plan.is_trial || PURCHASABLE_PLAN_KEYS.has(plan.plan_key)
      );
    }
  });

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-slate-200">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <Link to="/" className="text-lg font-semibold text-slate-950">
            Ogevia
          </Link>
          <Link to="/login" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            Sign in
          </Link>
        </div>
      </header>

      <section className="mx-auto max-w-4xl px-6 py-16 text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-slate-950">Start with Ogevia Starter</h1>
        <p className="mt-4 text-lg text-slate-600">
          Scheduling, CareScore matching, Service Verification, and compliance tracking - everything a small
          agency needs to get started.
        </p>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-20">
        {plansQuery.isLoading ? (
          <p className="text-center text-sm text-slate-500">Loading plans…</p>
        ) : plansQuery.isError ? (
          <p className="text-center text-sm text-red-700">Could not load plans right now.</p>
        ) : (plansQuery.data ?? []).length === 0 ? (
          <p className="text-center text-sm text-slate-400">No plans are published yet.</p>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {plansQuery.data!.map((plan) => (
              <Card key={plan.plan_key} className="flex h-full flex-col">
                <div className="flex-1">
                  <h2 className="text-lg font-semibold text-slate-950">{plan.name}</h2>
                  {plan.description ? <p className="mt-1 text-sm text-slate-500">{plan.description}</p> : null}
                  <p className="mt-4">
                    <span className="text-3xl font-semibold text-slate-950">{formatCents(plan.monthly_price_cents)}</span>
                    <span className="text-sm text-slate-500"> / month</span>
                  </p>
                  <p className="text-xs text-slate-400">or {formatCents(plan.annual_price_cents)} / year</p>

                  <dl className="mt-5 space-y-1.5 text-sm text-slate-700">
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500">Clients</dt>
                      <dd>{limitLabel(plan.max_active_clients)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500">Caregivers</dt>
                      <dd>{limitLabel(plan.max_active_caregivers)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500">Administrators</dt>
                      <dd>{limitLabel(plan.max_administrators)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500">Support</dt>
                      <dd className="capitalize">{plan.support_level}</dd>
                    </div>
                  </dl>

                  <ul className="mt-5 space-y-1.5 text-xs text-slate-600">
                    {plan.features.map((feature) => (
                      <li key={feature}>{FEATURE_LABELS[feature] ?? feature}</li>
                    ))}
                  </ul>
                </div>

                <Link to="/login" className={buttonVariants({ variant: "primary", className: "mt-6 w-full" })}>
                  {plan.is_trial ? "Start free trial" : "Sign in"}
                </Link>
              </Card>
            ))}
          </div>
        )}
      </section>

      <footer className="border-t border-slate-200 py-8 text-center text-xs text-slate-400">
        &copy; {new Date().getFullYear()} Ogevia
      </footer>
    </div>
  );
}
