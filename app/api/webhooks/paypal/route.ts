// PayPal webhook endpoint. Logic lives in lib/webhooks/paypalWebhook.ts.

import { after } from "next/server";
import { getPayPalClient } from "@/lib/paypal/client";
import { getSupabaseAdmin } from "@/lib/db/admin";
import { SupabaseStore } from "@/lib/db/supabaseStore";
import { handlePayPalWebhook } from "@/lib/webhooks/paypalWebhook";

// No segment config: cacheComponents is on, POST handlers are always dynamic, and the default
// runtime is Node.js (needed for Buffer in the PayPal client).

export async function POST(req: Request): Promise<Response> {
  let deps;
  try {
    deps = {
      paypal: getPayPalClient(),
      store: new SupabaseStore(getSupabaseAdmin()),
      webhookId: process.env.PAYPAL_WEBHOOK_ID,
      schedule: (task: () => Promise<void>) => after(task),
    };
  } catch {
    return Response.json({ error: "server not configured" }, { status: 500 });
  }
  return handlePayPalWebhook(req, deps);
}
