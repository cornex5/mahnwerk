// Browser Supabase client with anonymous sign-in. Reads go straight to the tables under RLS,
// mutations go through the API routes with the access token as a Bearer header.

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

export class ConfigError extends Error {
  constructor() {
    super("The backend is not configured (NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are missing).");
    this.name = "ConfigError";
  }
}

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new ConfigError();
  client = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });
  return client;
}

let pending: Promise<Session> | null = null;

/** Returns the current session, signing in anonymously when there is none. */
export function ensureSession(): Promise<Session> {
  if (!pending) {
    pending = (async () => {
      const sb = getSupabase();
      const cur = await sb.auth.getSession();
      if (cur.data.session) return cur.data.session;
      const res = await sb.auth.signInAnonymously();
      if (res.error || !res.data.session) {
        throw new Error(res.error?.message ?? "Anonymous sign-in failed. Is anonymous auth enabled for the project?");
      }
      return res.data.session;
    })().catch((err) => {
      pending = null;
      throw err;
    });
  }
  return pending;
}

/** A fresh access token (the client refreshes it when needed). */
export async function accessToken(): Promise<string> {
  await ensureSession();
  const { data } = await getSupabase().auth.getSession();
  if (!data.session) {
    pending = null;
    throw new Error("Your session ended. Reload the page to sign in again.");
  }
  return data.session.access_token;
}
