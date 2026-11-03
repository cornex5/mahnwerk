// Demo workspaces: creation with seeded master data and caps, and the demo clock.

import { ServiceError } from "./errors";
import {
  limitsOf,
  loadMutableWorkspace,
  loadWorkspace,
  virtualDateFor,
  type ServiceDeps,
} from "./context";
import type { CreditorSeed, DebtorSeed, WorkspaceRow } from "./store";

/** Fictional demo data only. Emails use example.com (sandbox emails never reach inboxes anyway). */
export const DEMO_CREDITOR: CreditorSeed = {
  name: "Studio Beispiel (Demo)",
  address: { line1: "Musterstrasse 1", postal_code: "10115", city: "Berlin", country: "DE" },
  kleinunternehmer: true,
  lang: "de",
};

export const DEMO_DEBTORS: readonly DebtorSeed[] = [
  { name: "Lena Beispiel", email: "lena.beispiel@example.com", type: "consumer", lang: "de" },
  { name: "Nordlicht Medien GmbH (Demo)", email: "buchhaltung.nordlicht@example.com", type: "business", lang: "de" },
  { name: "Harbor and Pine Ltd (Demo)", email: "accounts.harborpine@example.com", type: "business", lang: "en" },
];

export interface WorkspaceView {
  workspace: WorkspaceRow;
  virtualDate: string;
}

export async function createDemoWorkspace(deps: ServiceDeps, actorUid: string, opts: { name?: string } = {}): Promise<WorkspaceView> {
  const limits = limitsOf(deps);
  const nowMs = deps.now();
  const name = (opts.name ?? "Demo workspace").trim().slice(0, 80) || "Demo workspace";
  const res = await deps.store.createDemoWorkspace({
    ownerUid: actorUid,
    name,
    nowIso: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + limits.workspaceTtlHours * 3_600_000).toISOString(),
    perUserCap: limits.perUserWorkspaces,
    globalCap: limits.globalWorkspaces,
    creditor: DEMO_CREDITOR,
    debtors: [...DEMO_DEBTORS],
  });
  if (!res.ok) {
    if (res.reason === "user_cap") {
      throw new ServiceError("user_cap_reached", `You already have ${limits.perUserWorkspaces} live demo workspaces`);
    }
    throw new ServiceError("global_cap_reached", "The demo is at capacity right now, please try again later");
  }
  const ws = await loadWorkspace(deps, res.workspaceId);
  return { workspace: ws, virtualDate: virtualDateFor(ws, nowMs) };
}

export async function getClock(deps: ServiceDeps, workspaceId: string): Promise<{ offsetDays: number; virtualDate: string }> {
  const ws = await loadWorkspace(deps, workspaceId);
  return { offsetDays: ws.clock_offset_days, virtualDate: virtualDateFor(ws, deps.now()) };
}

/**
 * Advances the demo clock by N whole days (1..maxAdvanceDays). The clock never goes back and the
 * total offset is capped. Compare-and-set, so two concurrent advances both apply or one fails clean.
 */
export async function advanceClock(
  deps: ServiceDeps,
  workspaceId: string,
  actorUid: string,
  days: number,
): Promise<{ offsetDays: number; virtualDate: string; previousVirtualDate: string }> {
  const limits = limitsOf(deps);
  if (!Number.isSafeInteger(days) || days < 1 || days > limits.maxAdvanceDays) {
    throw new ServiceError("invalid_input", `days must be an integer between 1 and ${limits.maxAdvanceDays}`);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const ws = await loadMutableWorkspace(deps, workspaceId, actorUid);
    const next = ws.clock_offset_days + days;
    if (next > limits.maxClockOffsetDays) {
      throw new ServiceError("invalid_input", `The demo clock can move at most ${limits.maxClockOffsetDays} days ahead`);
    }
    const nowMs = deps.now();
    const previousVirtualDate = virtualDateFor(ws, nowMs);
    if (await deps.store.setClockOffset(ws.id, ws.clock_offset_days, next)) {
      const virtualDate = virtualDateFor({ ...ws, clock_offset_days: next }, nowMs);
      await deps.store.insertAudit({
        workspace_id: ws.id,
        case_id: null,
        invoice_id: null,
        actor: "user",
        action: "clock.advanced",
        virtual_date: virtualDate,
        details: { days, from_offset: ws.clock_offset_days, to_offset: next, actor_uid: actorUid },
      });
      return { offsetDays: next, virtualDate, previousVirtualDate };
    }
  }
  throw new ServiceError("conflict", "The clock changed concurrently, please retry");
}
