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
    .default("CareLik Global"),

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
