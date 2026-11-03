// PayPal webhook intake: verify signature with PayPal, store the event idempotently, answer 200
// fast, then process in the background (re-fetch and reconcile). Framework-agnostic for tests.

import { WebhookEventSchema } from "../paypal/schemas";
import type { VerifyWebhookSignatureInput } from "../paypal/client";
import { Reconciler, extractResourceId, type PayPalReader } from "../cases/reconcile";
import type { ReconcileStore } from "../cases/store";

export interface WebhookDeps {
  paypal: PayPalReader & { verifyWebhookSignature(input: VerifyWebhookSignatureInput): Promise<boolean> };
  store: ReconcileStore;
  webhookId: string | undefined;
  /** Runs work after the response is sent (next/server `after` in production). */
  schedule: (task: () => Promise<void>) => void;
  now?: () => number;
}

const MAX_BODY_BYTES = 512 * 1024;

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : "Unknown error";
  // Defensive: strip anything that looks like a bearer or basic credential.
  return msg.replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, "$1 [redacted]").slice(0, 1000);
}

export async function processStoredEvent(
  deps: Pick<WebhookDeps, "paypal" | "store" | "now">,
  event: { event_id: string; event_type: string; payload: unknown },
): Promise<void> {
  const reconciler = new Reconciler({ paypal: deps.paypal, store: deps.store, now: deps.now ?? Date.now });
  try {
    const r = await reconciler.processEvent(event);
    await deps.store.markEventProcessed(event.event_id, { workspaceId: r.workspaceId, note: r.note });
  } catch (err) {
    await deps.store.markEventFailed(event.event_id, sanitizeError(err)).catch(() => undefined);
  }
}

export async function handlePayPalWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (!deps.webhookId) return json(500, { error: "webhook not configured" });

  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) return json(413, { error: "payload too large" });
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: "payload too large" });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid json" });
  }
  const parsed = WebhookEventSchema.safeParse(body);
  if (!parsed.success) return json(400, { error: "invalid event" });
  const event = parsed.data;

  const h = (name: string) => req.headers.get(name);
  const authAlgo = h("paypal-auth-algo");
  const certUrl = h("paypal-cert-url");
  const transmissionId = h("paypal-transmission-id");
  const transmissionSig = h("paypal-transmission-sig");
  const transmissionTime = h("paypal-transmission-time");
  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) {
    return json(400, { error: "missing signature headers" });
  }

  let verified: boolean;
  try {
    verified = await deps.paypal.verifyWebhookSignature({
      authAlgo,
      certUrl,
      transmissionId,
      transmissionSig,
      transmissionTime,
      webhookId: deps.webhookId,
      webhookEvent: body,
    });
  } catch {
    // PayPal could not verify right now: a non-2xx makes PayPal redeliver later.
    return json(503, { error: "verification unavailable" });
  }
  if (!verified) return json(401, { error: "signature verification failed" });

  let stored;
  try {
    stored = await deps.store.insertEventIfNew({
      event_id: event.id,
      event_type: event.event_type,
      resource_type: event.resource_type ?? null,
      resource_id: extractResourceId(event.event_type, event.resource),
      verified: true,
      payload: body,
    });
  } catch {
    return json(500, { error: "could not store event" });
  }

  if (!stored.inserted && stored.event.processed_at !== null) {
    return json(200, { status: "duplicate" });
  }
  // New event, or a redelivery of one whose processing failed or never ran: (re)process.
  // Safe because processing is idempotent.
  const toProcess = { event_id: event.id, event_type: event.event_type, payload: body };
  deps.schedule(() => processStoredEvent(deps, toProcess));
  return json(200, { status: stored.inserted ? "accepted" : "reprocessing" });
}
