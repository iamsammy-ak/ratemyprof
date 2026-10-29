import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * True when all required Supabase environment variables are present.
 * Expected in Vite:
 * - VITE_SUPABASE_URL
 * - VITE_SUPABASE_ANON_KEY
 */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

if (!isSupabaseConfigured) {
  console.warn(
    "[supabase] Missing VITE_SUPABASE_URL and/or VITE_SUPABASE_ANON_KEY. " +
      "Supabase features are disabled.",
  );
}

/**
 * Supabase client instance.
 * Will be `null` when env variables are missing.
 */
export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export default supabase;
