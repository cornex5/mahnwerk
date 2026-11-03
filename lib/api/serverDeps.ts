// Production wiring for the route handlers: Supabase auth from the request (bearer token or
// session cookies via @supabase/ssr), the service-role store, and the sandbox PayPal client.

import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { getAiServices } from "../ai-wiring/serverAi";
import { getSupabaseAdmin } from "../db/admin";
import { SupabaseServiceStore } from "../db/supabaseServiceStore";
import { getPayPalClient } from "../paypal/client";
import { merchantIdFor, type ServiceDeps } from "../services/context";
import { sharedRateLimiter } from "../services/rateLimit";
import type { AuthResult, RouteDeps } from "./http";

function publicEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("Supabase public env is not set");
  return { url, anon };
}

export async function authenticateRequest(req: Request): Promise<AuthResult | null> {
  const { url, anon } = publicEnv();
  const header = req.headers.get("authorization");
  if (header && /^Bearer\s+\S+$/i.test(header)) {
    const token = header.split(/\s+/)[1];
    const sb = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await sb.auth.getUser(token);
    return error || !data.user ? null : { userId: data.user.id, via: "bearer" };
  }
  const store = await cookies();
  const sb = createServerClient(url, anon, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        // Refreshed session cookies; setting may be refused outside a mutable context.
        try {
          for (const c of list) store.set(c.name, c.value, c.options);
        } catch {
          // ignore
        }
      },
    },
  });
  // getUser validates the JWT with Supabase Auth (getSession alone would trust the cookie).
  const { data, error } = await sb.auth.getUser();
  return error || !data.user ? null : { userId: data.user.id, via: "cookie" };
}

let services: ServiceDeps | null = null;

export function serviceDeps(): ServiceDeps {
  if (services) return services;
  const clientId = process.env.PAYPAL_CLIENT_ID;
  if (!clientId) throw new Error("PAYPAL_CLIENT_ID is not set");
  services = {
    ai: getAiServices(),
    store: new SupabaseServiceStore(getSupabaseAdmin()),
    paypal: getPayPalClient(),
    now: Date.now,
    paypalEnv: process.env.PAYPAL_ENV,
    merchantId: merchantIdFor(clientId),
  };
  return services;
}

export function routeDeps(): RouteDeps {
  return {
    authenticate: authenticateRequest,
    services: serviceDeps,
    limiter: sharedRateLimiter,
    log: (msg, meta) => console.error(`[mahnwerk] ${msg}`, meta),
  };
}
