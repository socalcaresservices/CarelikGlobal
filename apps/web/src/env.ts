import { z } from "zod";

const envSchema = z.object({
  VITE_SUPABASE_URL: z
    .string()
    .url()
    .default("http://127.0.0.1:54321"),

  VITE_SUPABASE_ANON_KEY: z
    .string()
    .min(20)
    .default("development-anon-key-not-configured"),

  VITE_APP_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  VITE_APP_NAME: z
    .string()
    .default("Ogevia"),

  VITE_APP_VERSION: z
    .string()
    .default("0.1.0"),

  VITE_SITE_URL: z
    .string()
    .url()
    .optional(),

  VITE_ENABLE_DEBUG: z
    .coerce
    .boolean()
    .default(false),

  VITE_STRIPE_PUBLISHABLE_KEY: z
    .string()
    .optional(),

  // Sign-in provider. Unset/"supabase" = CURRENT production (unchanged).
  // "cognito" = AWS build: Cognito managed login + Ogevia AWS API.
  VITE_AUTH_PROVIDER: z
    .enum(["supabase", "cognito"])
    .default("supabase"),

  // AWS build only (validated again, fail-closed, by parseCognitoConfig).
  VITE_COGNITO_REGION: z.string().optional(),
  VITE_COGNITO_USER_POOL_ID: z.string().optional(),
  VITE_COGNITO_CLIENT_ID: z.string().optional(),
  VITE_COGNITO_DOMAIN: z.string().url().optional(),
  VITE_COGNITO_REDIRECT_URI: z.string().url().optional(),
  VITE_COGNITO_LOGOUT_URI: z.string().url().optional(),
  VITE_COGNITO_SCOPES: z.string().optional(),
  VITE_COGNITO_REFRESH_PERSISTENCE: z.enum(["memory", "session"]).optional(),
  // Service Verification API base URL (API Gateway stage URL).
  VITE_SV_API_BASE_URL: z.string().url().optional(),
});

const parsed = envSchema.safeParse(import.meta.env);

if (!parsed.success) {
  console.error(
    "Invalid application environment",
    parsed.error.flatten().fieldErrors
  );

  throw new Error("Application environment is invalid.");
}

export const env = parsed.data;

export const isSupabaseConfigured =
  env.VITE_SUPABASE_ANON_KEY !== "development-anon-key-not-configured";

// Stripe is not wired into this project yet - Stripe Checkout/Customer
// Portal/webhooks are all unimplemented (see .env.example). This is a
// proxy signal, not proof: it tells the platform owner's Billing page
// whether the *frontend* half of Stripe config is present, since
// STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET are server-only and never
// reach this bundle.
export const isStripeConfigured = Boolean(env.VITE_STRIPE_PUBLISHABLE_KEY);
