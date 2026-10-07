import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/env";

// Created on first use, not at import. The AWS build (VITE_AUTH_PROVIDER=
// cognito) never touches it, so no Supabase client, session storage, token
// refresh timer, or network call exists in that runtime.
let instance: SupabaseClient | null = null;

function client(): SupabaseClient {
  instance ??= createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    },
    global: {
      headers: {
        "x-client-info": "carelik-global-web/0.1.0"
      }
    }
  });
  return instance;
}

export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, property) {
    const real = client();
    const value = Reflect.get(real, property, real) as unknown;
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(real) : value;
  }
});

/** For tests: whether the Supabase client has been created in this runtime. */
export function isSupabaseClientCreated(): boolean {
  return instance !== null;
}
