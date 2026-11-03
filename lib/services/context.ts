// Shared dependencies and guards for the service layer.

import { createHash } from "node:crypto";
import { addDays } from "../rules/dates";
import type { PayPalClient } from "../paypal/client";
import type { AiGateway } from "../ai/budget";
import { GoldenReadOnlyError, ServiceError } from "./errors";
import type { ServiceStore, WorkspaceRow } from "./store";

/** The PayPal calls the services use. PayPalClient satisfies it; tests use a fake. */
export type PayPalPort = Pick<
  PayPalClient,
  | "createInvoice"
  | "sendInvoice"
  | "getInvoice"
  | "remindInvoice"
  | "recordPayment"
  | "recordRefund"
  | "searchInvoices"
  | "getDispute"
  | "getCaptureRefund"
> & { readonly env: "sandbox" | "live" };

export interface ServiceLimits {
  /** Live demo workspaces per user. */
  perUserWorkspaces: number;
  /** Live demo workspaces in total (protects the shared sandbox). */
  globalWorkspaces: number;
  workspaceTtlHours: number;
  /** Max days per clock advance call and max total offset. */
  maxAdvanceDays: number;
  maxClockOffsetDays: number;
  /** PayPal sandbox: max invoice reminders per day per API caller. */
  remindersPerDay: number;
  /** Execution lease; a stale lease (crashed executor) can be taken over after this. */
  stepLeaseMs: number;
  maxInvoiceCents: number;
}

export const DEFAULT_LIMITS: ServiceLimits = {
  perUserWorkspaces: 3,
  globalWorkspaces: 200,
  workspaceTtlHours: 48,
  maxAdvanceDays: 60,
  maxClockOffsetDays: 365,
  remindersPerDay: 2,
  stepLeaseMs: 120_000,
  maxInvoiceCents: 5_000_000,
};

/** Optional AI wiring. Without it every letter is the deterministic template and AI routes answer 503. */
export interface AiServices {
  gateway: AiGateway;
  /** Hard cap for the draft generated while proposing a step. The proposal never waits longer. */
  draftTimeoutMs?: number;
}

export interface ServiceDeps {
  store: ServiceStore;
  ai?: AiServices;
  paypal: PayPalPort;
  /** Wall clock in ms. */
  now: () => number;
  /** Raw PAYPAL_ENV value. Every PayPal write refuses unless this is exactly "sandbox". */
  paypalEnv: string | undefined;
  /** Quota key of the PayPal API caller (hash of the client id, never the id itself). */
  merchantId: string;
  limits?: Partial<ServiceLimits>;
  newId?: () => string;
}

export function limitsOf(deps: ServiceDeps): ServiceLimits {
  return { ...DEFAULT_LIMITS, ...(deps.limits ?? {}) };
}

export function merchantIdFor(clientId: string): string {
  return `pp-${createHash("sha256").update(clientId).digest("hex").slice(0, 16)}`;
}

/** Never touch real money: every PayPal write goes through this. */
export function assertSandbox(deps: ServiceDeps): void {
  if (deps.paypalEnv !== "sandbox" || deps.paypal.env !== "sandbox") {
    throw new ServiceError("not_sandbox", "PayPal writes are refused unless PAYPAL_ENV=sandbox");
  }
}

/** Fixed virtual date of the read-only golden workspace (see goldenSeed.ts). */
export const GOLDEN_VIRTUAL_DATE = "2026-11-20";

export function realToday(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Virtual date = real UTC date + demo clock offset. Same formula as the reconciler uses. */
export function virtualDateFor(ws: Pick<WorkspaceRow, "kind" | "clock_offset_days">, nowMs: number): string {
  if (ws.kind === "golden") return GOLDEN_VIRTUAL_DATE;
  return addDays(realToday(nowMs), ws.clock_offset_days);
}

/** Deterministic hex key (sha256) for idempotency keys. */
export function stableKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

/** Short, stable PayPal-Request-Id from a key (PayPal accepts up to 108 characters). */
export function keyToRequestId(prefix: string, key: string): string {
  return `${prefix}-${key.slice(0, 32)}`;
}

export async function loadWorkspace(deps: ServiceDeps, workspaceId: string): Promise<WorkspaceRow> {
  const ws = await deps.store.getWorkspace(workspaceId);
  if (!ws) throw new ServiceError("not_found", "Workspace not found");
  return ws;
}

/** Owner-only, never golden, never expired. Golden is checked first so it always reports read-only. */
export function assertMutable(ws: WorkspaceRow, actorUid: string, nowMs: number): void {
  if (ws.kind === "golden") throw new GoldenReadOnlyError();
  if (!ws.owner_uid || ws.owner_uid !== actorUid) throw new ServiceError("forbidden", "Only the workspace owner may change it");
  if (ws.expires_at !== null && Date.parse(ws.expires_at) <= nowMs) {
    throw new ServiceError("workspace_expired", "This demo workspace has expired");
  }
}

export async function loadMutableWorkspace(deps: ServiceDeps, workspaceId: string, actorUid: string): Promise<WorkspaceRow> {
  const ws = await loadWorkspace(deps, workspaceId);
  assertMutable(ws, actorUid, deps.now());
  return ws;
}

export function newId(deps: ServiceDeps): string {
  return deps.newId ? deps.newId() : crypto.randomUUID();
}
