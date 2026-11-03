// Thin route-handler plumbing: auth, same-origin check for cookie auth, rate limit, zod-validated
// JSON body, and clean JSON errors. Framework-agnostic (plain Request/Response) for tests.

import { z } from "zod";
import { ServiceError } from "../services/errors";
import type { ServiceDeps } from "../services/context";
import type { RateBucket, RateLimiter } from "../services/rateLimit";
import { safeMessage } from "../services/paypalErrors";

export interface AuthResult {
  userId: string;
  via: "bearer" | "cookie";
}

export interface RouteDeps {
  authenticate(req: Request): Promise<AuthResult | null>;
  services(): ServiceDeps;
  limiter: RateLimiter;
  log?: (msg: string, meta: Record<string, unknown>) => void;
}

const MAX_BODY_BYTES = 16 * 1024;

export function jsonError(status: number, code: string, message: string, details?: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { code, message, ...(details ? { details } : {}) } }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function jsonOk(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function readJson(req: Request): Promise<unknown> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) throw new ServiceError("invalid_input", "Request body too large");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new ServiceError("invalid_input", "Request body too large");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ServiceError("invalid_input", "Body is not valid JSON");
  }
}

/** Cookie-authenticated mutations must come from our own origin (CSRF guard). */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const o = new URL(origin);
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
    return o.host === host;
  } catch {
    return false;
  }
}

export const UuidSchema = z.uuid();

export function handleRoute<S extends z.ZodType>(
  deps: () => RouteDeps,
  opts: { bucket: RateBucket; body: S },
  run: (ctx: { userId: string; body: z.infer<S>; services: ServiceDeps }) => Promise<unknown>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    let d: RouteDeps;
    try {
      d = deps();
    } catch {
      return jsonError(500, "internal", "Server not configured");
    }
    try {
      const auth = await d.authenticate(req);
      if (!auth) return jsonError(401, "unauthorized", "Sign in first (anonymous sign-in is fine)");
      if (auth.via === "cookie" && !sameOrigin(req)) return jsonError(403, "forbidden", "Cross-origin request refused");
      const waitMs = d.limiter.hit(auth.userId, opts.bucket);
      if (waitMs > 0) {
        return jsonError(429, "rate_limited", "Too many requests, slow down", undefined, { "Retry-After": String(Math.ceil(waitMs / 1000)) });
      }
      const parsed = opts.body.safeParse(await readJson(req));
      if (!parsed.success) {
        return jsonError(400, "invalid_input", "Invalid request", { issues: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`) });
      }
      const result = await run({ userId: auth.userId, body: parsed.data, services: d.services() });
      return jsonOk(result);
    } catch (err) {
      if (err instanceof ServiceError) return jsonError(err.status, err.code, err.message, err.details);
      d.log?.("route failed", { error: safeMessage(err) });
      return jsonError(500, "internal", "Something went wrong");
    }
  };
}

/** Validates a dynamic route segment as a UUID. */
export function idParam(raw: string | undefined): string {
  const r = UuidSchema.safeParse(raw);
  if (!r.success) throw new ServiceError("invalid_input", "Invalid id in URL");
  return r.data;
}
