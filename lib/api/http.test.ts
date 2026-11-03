import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GoldenReadOnlyError, ServiceError } from "../services/errors";
import { RateLimiter } from "../services/rateLimit";
import type { ServiceDeps } from "../services/context";
import { handleRoute, idParam, type AuthResult, type RouteDeps } from "./http";
import { CreateInvoiceBody, SimulateBody } from "./schemas";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function deps(auth: AuthResult | null, limiter = new RateLimiter({ mutate: { limit: 2, windowMs: 60_000 }, workspace_create: { limit: 1, windowMs: 1 }, paypal_write: { limit: 1, windowMs: 1 } }, () => 0)): () => RouteDeps {
  return () => ({ authenticate: async () => auth, services: () => ({}) as ServiceDeps, limiter });
}

const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://mahnwerk.vercel.app/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", host: "mahnwerk.vercel.app", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const Body = z.strictObject({ n: z.number().int() });

async function call(h: (r: Request) => Promise<Response>, r: Request) {
  const res = await h(r);
  return { status: res.status, body: (await res.json()) as { error?: { code: string; message: string } } & Record<string, unknown>, headers: res.headers };
}

describe("handleRoute", () => {
  const ok = async () => ({ ok: true });

  it("returns 401 without a user", async () => {
    const r = await call(handleRoute(deps(null), { bucket: "mutate", body: Body }, ok), req({ n: 1 }));
    expect(r).toMatchObject({ status: 401, body: { error: { code: "unauthorized" } } });
  });

  it("refuses cross-origin cookie requests but accepts bearer and same-origin", async () => {
    const h = (a: AuthResult) => handleRoute(deps(a), { bucket: "mutate", body: Body }, ok);
    expect((await call(h({ userId: USER, via: "cookie" }), req({ n: 1 }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await call(h({ userId: USER, via: "cookie" }), req({ n: 1 }))).status).toBe(403);
    expect((await call(h({ userId: USER, via: "cookie" }), req({ n: 1 }, { origin: "https://mahnwerk.vercel.app" }))).status).toBe(200);
    expect((await call(h({ userId: USER, via: "bearer" }), req({ n: 1 }))).status).toBe(200);
  });

  it("validates the body strictly and rejects bad JSON", async () => {
    const roomy = new RateLimiter({ mutate: { limit: 100, windowMs: 60_000 } }, () => 0);
    const h = handleRoute(deps({ userId: USER, via: "bearer" }, roomy), { bucket: "mutate", body: Body }, ok);
    expect((await call(h, req({ n: "1" }))).body.error!.code).toBe("invalid_input");
    expect((await call(h, req({ n: 1, extra: true }))).status).toBe(400);
    expect((await call(h, req("{not json"))).status).toBe(400);
    expect((await call(h, req("x".repeat(20_000)))).status).toBe(400);
  });

  it("rate limits per user with Retry-After", async () => {
    const h = handleRoute(deps({ userId: USER, via: "bearer" }), { bucket: "mutate", body: Body }, ok);
    expect((await call(h, req({ n: 1 }))).status).toBe(200);
    expect((await call(h, req({ n: 1 }))).status).toBe(200);
    const r = await call(h, req({ n: 1 }));
    expect(r.status).toBe(429);
    expect(r.body.error!.code).toBe("rate_limited");
    expect(r.headers.get("retry-after")).toBe("60");
  });

  it("maps service errors to clean JSON and hides unexpected errors", async () => {
    const golden = await call(handleRoute(deps({ userId: USER, via: "bearer" }), { bucket: "mutate", body: Body }, async () => { throw new GoldenReadOnlyError(); }), req({ n: 1 }));
    expect(golden).toMatchObject({ status: 403, body: { error: { code: "golden_read_only" } } });
    const conflict = await call(handleRoute(deps({ userId: USER, via: "bearer" }), { bucket: "mutate", body: Body }, async () => { throw new ServiceError("in_progress", "busy"); }), req({ n: 1 }));
    expect(conflict.status).toBe(409);
    const boom = await call(handleRoute(deps({ userId: USER, via: "bearer" }), { bucket: "mutate", body: Body }, async () => { throw new Error("secret db detail"); }), req({ n: 1 }));
    expect(boom.status).toBe(500);
    expect(JSON.stringify(boom.body)).not.toMatch(/secret/);
  });

  it("validates ids in the URL", () => {
    expect(idParam("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe(USER);
    expect(() => idParam("../etc")).toThrow(ServiceError);
    expect(() => idParam(undefined)).toThrow(ServiceError);
  });
});

describe("route schemas", () => {
  it("accept valid bodies and reject unknown actions or fields", () => {
    expect(CreateInvoiceBody.safeParse({ debtorId: USER, amountCents: 100, dueDate: "2026-12-01", nonce: "abcdefgh" }).success).toBe(true);
    expect(CreateInvoiceBody.safeParse({ debtorId: USER, amountCents: 1.5, dueDate: "2026-12-01", nonce: "abcdefgh" }).success).toBe(false);
    expect(SimulateBody.safeParse({ nonce: "abcdefgh", action: { type: "pay_partial", amountCents: 500 } }).success).toBe(true);
    expect(SimulateBody.safeParse({ nonce: "abcdefgh", action: { type: "chargeback" } }).success).toBe(false);
    expect(SimulateBody.safeParse({ nonce: "abcdefgh", action: { type: "pay_full", amountCents: 5 } }).success).toBe(false);
  });
});
