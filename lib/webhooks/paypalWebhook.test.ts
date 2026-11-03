import { describe, expect, it } from "vitest";
import { handlePayPalWebhook, type WebhookDeps } from "./paypalWebhook";
import { CASE, PP_INV, makeWorld, remoteInvoice } from "../cases/testWorld";

const HEADERS = {
  "content-type": "application/json",
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test",
  "paypal-transmission-id": "tx-123",
  "paypal-transmission-sig": "sig-test",
  "paypal-transmission-time": "2026-11-03T12:00:00Z",
};

const EVENT = {
  id: "WH-EVT-1",
  event_type: "INVOICING.INVOICE.PAID",
  resource_type: "invoices",
  resource: { id: PP_INV, status: "PAID" },
};

function setup() {
  const w = makeWorld("reminded");
  w.paypal.invoices.set(PP_INV, remoteInvoice({ status: "PAID", payments: [{ id: "PAY-1", date: "2026-11-02", cents: 100000 }] }));
  const tasks: (() => Promise<void>)[] = [];
  const deps: WebhookDeps = { paypal: w.paypal, store: w.store, webhookId: "WH-ID-TEST", schedule: (t) => tasks.push(t), now: w.now };
  const post = (body: unknown, headers: Record<string, string> = HEADERS) =>
    handlePayPalWebhook(new Request("https://example.test/api/webhooks/paypal", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }), deps);
  const drain = async () => {
    while (tasks.length) await tasks.shift()!();
  };
  return { w, deps, tasks, post, drain };
}

describe("POST /api/webhooks/paypal", () => {
  it("verifies with PayPal, stores, answers 200 before processing, then reconciles", async () => {
    const { w, tasks, post, drain } = setup();
    const res = await post(EVENT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "accepted" });
    expect(w.paypal.verifyCalls).toEqual([
      {
        authAlgo: "SHA256withRSA",
        certUrl: HEADERS["paypal-cert-url"],
        transmissionId: "tx-123",
        transmissionSig: "sig-test",
        transmissionTime: "2026-11-03T12:00:00Z",
        webhookId: "WH-ID-TEST",
        webhookEvent: EVENT,
      },
    ]);
    expect(w.store.events.get("WH-EVT-1")).toMatchObject({ verified: true, resource_id: PP_INV, processed_at: null });
    // Not processed yet: the response went out first.
    expect(tasks).toHaveLength(1);
    expect(w.store.ledger).toHaveLength(0);
    expect(w.paypal.gets).toHaveLength(0);
    await drain();
    expect(w.store.cases.get(CASE)!.state).toBe("closed_paid");
    expect(w.store.events.get("WH-EVT-1")!.processed_at).not.toBeNull();
  });

  it("returns 200 duplicate for a processed event id and does nothing", async () => {
    const { w, tasks, post, drain } = setup();
    await post(EVENT);
    await drain();
    const auditCount = w.store.audit.length;
    const res = await post(EVENT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "duplicate" });
    expect(tasks).toHaveLength(0);
    expect(w.store.audit.length).toBe(auditCount);
    expect(w.store.ledger).toHaveLength(1);
  });

  it("reprocesses a redelivered event whose first processing failed", async () => {
    const { w, post, drain } = setup();
    const saved = w.paypal.invoices.get(PP_INV)!;
    w.paypal.invoices.delete(PP_INV); // PayPal GET fails the first time
    await post(EVENT);
    await drain();
    expect(w.store.events.get("WH-EVT-1")!.error).toMatch(/404/);
    w.paypal.invoices.set(PP_INV, saved);
    const res = await post(EVENT);
    expect(await res.json()).toEqual({ status: "reprocessing" });
    await drain();
    expect(w.store.events.get("WH-EVT-1")).toMatchObject({ error: null, attempts: 2 });
    expect(w.store.cases.get(CASE)!.state).toBe("closed_paid");
  });

  it("rejects a failed signature with 401 and stores nothing", async () => {
    const { w, post } = setup();
    w.paypal.verifyResult = false;
    expect((await post(EVENT)).status).toBe(401);
    expect(w.store.events.size).toBe(0);
  });

  it("answers 503 when PayPal verification is unavailable, so PayPal redelivers", async () => {
    const { w, post } = setup();
    w.paypal.verifyResult = new Error("PayPal 503");
    expect((await post(EVENT)).status).toBe(503);
    expect(w.store.events.size).toBe(0);
  });

  it("rejects missing headers, bad JSON and bad shapes before calling PayPal", async () => {
    const { w, post } = setup();
    const { ["paypal-transmission-sig"]: _omit, ...partial } = HEADERS;
    void _omit;
    expect((await post(EVENT, partial)).status).toBe(400);
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ id: "x" })).status).toBe(400);
    expect((await post("x".repeat(600 * 1024))).status).toBe(413);
    expect(w.paypal.verifyCalls).toHaveLength(0);
  });

  it("fails closed without a configured webhook id", async () => {
    const { deps, post, w } = setup();
    deps.webhookId = undefined;
    expect((await post(EVENT)).status).toBe(500);
    expect(w.paypal.verifyCalls).toHaveLength(0);
  });

  it("answers 500 when the event cannot be stored, so PayPal redelivers", async () => {
    const { w, post, tasks } = setup();
    w.store.insertEventIfNew = async () => {
      throw new Error("db down");
    };
    expect((await post(EVENT)).status).toBe(500);
    expect(tasks).toHaveLength(0);
  });

  it("does not leak credentials into stored error text", async () => {
    const { w, post, drain } = setup();
    w.paypal.getInvoice = async () => {
      throw new Error("upstream said Authorization: Bearer abc.def-ghi");
    };
    await post(EVENT);
    await drain();
    expect(w.store.events.get("WH-EVT-1")!.error).toContain("Bearer [redacted]");
    expect(w.store.events.get("WH-EVT-1")!.error).not.toContain("abc.def-ghi");
  });
});
