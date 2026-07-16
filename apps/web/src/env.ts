import { z } from "zod";

const envSchema = z.object({
  VITE_SUPABASE_URL: z.string().url(),
  VITE_SUPABASE_ANON_KEY: z.string().min(20),
  VITE_APP_ENV: z.enum(["development", "test", "production"]).default("development")
});

const parsed = envSchema.safeParse(import.meta.env);

if (!parsed.success) {
  console.error("Invalid application environment", parsed.error.flatten().fieldErrors);
  throw new Error("Application environment is invalid.");
}

export const env = parsed.data;
