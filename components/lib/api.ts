// Fetch helper for the Mahnwerk API routes (Bearer token from the anonymous Supabase session).

import { accessToken } from "./supabase";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
  /** The route does not exist in this deployment, or the AI is not configured on the server. */
  get missing(): boolean {
    return (this.status === 404 && (this.code === "not_found_route" || this.code === "http_404")) || this.status === 501 || this.code === "ai_unavailable";
  }
}

export async function apiPost<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  const token = await accessToken();
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(75_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiError(0, "timeout", "The server took too long to answer. Reload the page to see what happened before you retry.");
    }
    throw new ApiError(0, "network", "Network error. Check your connection and try again.");
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
    // A Next.js 404 for a missing route has no JSON error body.
    const code = e?.code ?? (res.status === 404 ? "not_found_route" : `http_${res.status}`);
    throw new ApiError(res.status, code, e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return json as T;
}

/**
 * Tries request bodies in order until the route accepts one (a 400 means the body shape was
 * refused). Used for the AI routes whose body schema is owned by another module.
 */
export async function apiPostFirstAccepted<T = unknown>(path: string, bodies: unknown[]): Promise<T> {
  let last: unknown = null;
  for (const b of bodies) {
    try {
      return await apiPost<T>(path, b);
    } catch (err) {
      last = err;
      if (!(err instanceof ApiError && err.status === 400 && err.code === "invalid_input")) throw err;
    }
  }
  throw last;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const issues = err.details?.issues;
    if (Array.isArray(issues) && issues.length > 0) return `${err.message}: ${issues.slice(0, 3).join("; ")}`;
    return err.message;
  }
  return err instanceof Error ? err.message : "Something went wrong";
}

export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
