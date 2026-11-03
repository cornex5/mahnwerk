import { describe, expect, it } from "vitest";
import { GOLDEN_VIRTUAL_DATE, assertSandbox, virtualDateFor } from "./context";
import { GoldenReadOnlyError, ServiceError } from "./errors";
import { buildGoldenSeed } from "./goldenSeed";
import { createAndSendInvoice } from "./invoices";
import type { MemoryServiceStore } from "./memoryServiceStore";
import { simulate } from "./simulator";
import { approveStep, executeStep, proposeNextStep, rejectStep } from "./steps";
import { OTHER_USER, T0, USER, makeServiceWorld } from "./testkit";
import { advanceClock, createDemoWorkspace, getClock } from "./workspaces";

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (err) {
    return err instanceof ServiceError ? err.code : `other:${String(err)}`;
  }
}

describe("demo workspace creation", () => {
  it("seeds one creditor and three debtors (one consumer, two business, German and English), expiring after 48h", async () => {
    const w = await makeServiceWorld();
    expect(w.ws.kind).toBe("demo");
    expect(w.ws.owner_uid).toBe(USER);
    expect(Date.parse(w.ws.expires_at!) - T0).toBe(48 * 3_600_000);
    const debtors = await w.store.listDebtors(w.ws.id);
    expect(debtors.map((d) => d.type).sort()).toEqual(["business", "business", "consumer"]);
    expect(new Set(debtors.map((d) => d.lang))).toEqual(new Set(["de", "en"]));
    expect(debtors.every((d) => d.email.endsWith("@example.com"))).toBe(true);
    expect(await w.store.getCreditorForWorkspace(w.ws.id)).not.toBeNull();
    expect(w.store.audit.some((a) => a.action === "workspace.created" && a.workspace_id === w.ws.id)).toBe(true);
  });

  it("caps live demo workspaces per user (3) and ignores expired ones", async () => {
    const w = await makeServiceWorld();
    await createDemoWorkspace(w.deps, USER);
    await createDemoWorkspace(w.deps, USER);
    expect(await code(createDemoWorkspace(w.deps, USER))).toBe("user_cap_reached");
    // Another user is not affected.
    expect(await code(createDemoWorkspace(w.deps, OTHER_USER))).toBe("resolved");
    w.tick(48 * 3_600_000 + 1);
    expect(await code(createDemoWorkspace(w.deps, USER))).toBe("resolved");
  });

  it("caps live demo workspaces globally", async () => {
    const w = await makeServiceWorld({ limits: { globalWorkspaces: 3 } });
    await createDemoWorkspace(w.deps, OTHER_USER);
    await createDemoWorkspace(w.deps, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    const err = await createDemoWorkspace(w.deps, "dddddddd-dddd-4ddd-8ddd-dddddddddddd").catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err.code).toBe("global_cap_reached");
    expect(err.status).toBe(503);
    expect([...w.store.workspaces.values()].filter((x) => x.kind === "demo")).toHaveLength(3);
  });

  it("enforces the caps under concurrent creation", async () => {
    const w = await makeServiceWorld({ limits: { perUserWorkspaces: 3 } });
    const results = await Promise.all([1, 2, 3, 4].map(() => code(createDemoWorkspace(w.deps, USER))));
    expect(results.filter((r) => r === "resolved")).toHaveLength(2);
    expect(results.filter((r) => r === "user_cap_reached")).toHaveLength(2);
  });
});

describe("demo clock", () => {
  it("advances by whole days and reports the virtual date", async () => {
    const w = await makeServiceWorld();
    expect(await getClock(w.deps, w.ws.id)).toEqual({ offsetDays: 0, virtualDate: "2026-11-03" });
    const r = await advanceClock(w.deps, w.ws.id, USER, 10);
    expect(r).toEqual({ offsetDays: 10, virtualDate: "2026-11-13", previousVirtualDate: "2026-11-03" });
    expect(w.store.audit.at(-1)).toMatchObject({ action: "clock.advanced", virtual_date: "2026-11-13" });
  });

  it("rejects invalid steps, the total cap, other users and expired workspaces", async () => {
    const w = await makeServiceWorld({ limits: { maxClockOffsetDays: 30 } });
    expect(await code(advanceClock(w.deps, w.ws.id, USER, 0))).toBe("invalid_input");
    expect(await code(advanceClock(w.deps, w.ws.id, USER, -1))).toBe("invalid_input");
    expect(await code(advanceClock(w.deps, w.ws.id, USER, 1.5))).toBe("invalid_input");
    expect(await code(advanceClock(w.deps, w.ws.id, USER, 61))).toBe("invalid_input");
    await advanceClock(w.deps, w.ws.id, USER, 30);
    expect(await code(advanceClock(w.deps, w.ws.id, USER, 1))).toBe("invalid_input");
    expect(await code(advanceClock(w.deps, w.ws.id, OTHER_USER, 1))).toBe("forbidden");
    w.tick(49 * 3_600_000);
    expect(await code(advanceClock(w.deps, w.ws.id, USER, 1))).toBe("workspace_expired");
  });

  it("applies concurrent advances exactly once each (compare and set with retry)", async () => {
    const w = await makeServiceWorld();
    await Promise.all([advanceClock(w.deps, w.ws.id, USER, 2), advanceClock(w.deps, w.ws.id, USER, 3)]);
    expect((await getClock(w.deps, w.ws.id)).offsetDays).toBe(5);
  });

  it("uses the fixed date for the golden workspace", () => {
    expect(virtualDateFor({ kind: "golden", clock_offset_days: 99 }, T0)).toBe(GOLDEN_VIRTUAL_DATE);
    expect(virtualDateFor({ kind: "demo", clock_offset_days: 2 }, T0)).toBe("2026-11-05");
  });
});

describe("sandbox guard", () => {
  it("refuses unless PAYPAL_ENV is exactly sandbox", async () => {
    const w = await makeServiceWorld();
    expect(() => assertSandbox(w.deps)).not.toThrow();
    for (const env of [undefined, "", "live", "Sandbox"]) {
      expect(() => assertSandbox({ ...w.deps, paypalEnv: env })).toThrow(/sandbox/);
    }
    expect(() => assertSandbox({ ...w.deps, paypal: { ...w.paypal, env: "live" } as never })).toThrow(/sandbox/);
  });
});

function loadGolden(store: MemoryServiceStore) {
  const seed = buildGoldenSeed("test-seed");
  store.workspaces.set(seed.workspace.id, { ...seed.workspace });
  store.creditors.set(seed.creditor.id, seed.creditor);
  for (const d of seed.debtors) store.debtors.set(d.id, d);
  for (const i of seed.invoices) {
    store.fullInvoices.set(i.id, { ...i });
    store.invoices.set(i.id, { id: i.id, workspace_id: i.workspace_id, paypal_invoice_id: null, number: i.number, currency: i.currency, principal_cents: i.principal_cents });
  }
  for (const c of seed.cases) store.cases.set(c.id, { id: c.id, workspace_id: c.workspace_id, invoice_id: c.invoice_id, state: c.state, prev_state: c.prev_state, paused_reason: c.paused_reason, version: c.version });
  for (const s of seed.steps) store.fullSteps.push(structuredClone(s));
  store.ledger.push(...seed.ledger);
  return seed;
}

describe("golden workspace is read-only", () => {
  it("throws GoldenReadOnlyError on every mutation, for everyone", async () => {
    const w = await makeServiceWorld();
    const seed = loadGolden(w.store);
    const wsId = seed.workspace.id;
    const proposed = seed.steps.find((s) => s.status === "proposed")!;
    const anyCase = seed.cases[0].id;
    const before = { audit: w.store.audit.length, steps: JSON.stringify(w.store.fullSteps), cases: JSON.stringify([...w.store.cases.values()]) };

    const attempts: [string, () => Promise<unknown>][] = [
      ["advanceClock", () => advanceClock(w.deps, wsId, USER, 1)],
      ["createInvoice", () => createAndSendInvoice(w.deps, USER, { workspaceId: wsId, debtorId: seed.debtors[0].id, amountCents: 100, dueDate: "2026-12-01", nonce: "golden-nonce-1" })],
      ["approveStep", () => approveStep(w.deps, USER, proposed.id)],
      ["rejectStep", () => rejectStep(w.deps, USER, proposed.id)],
      ["executeStep", () => executeStep(w.deps, USER, proposed.id)],
      ["simulate", () => simulate(w.deps, USER, anyCase, { type: "pay_full" }, "golden-nonce-2")],
      ["proposeNextStep", () => proposeNextStep(w.deps, anyCase)],
    ];
    for (const [name, run] of attempts) {
      const err = (await run().catch((e) => e)) as ServiceError;
      expect(err, name).toBeInstanceOf(GoldenReadOnlyError);
      expect(err.status, name).toBe(403);
    }
    expect(w.store.audit.length).toBe(before.audit);
    expect(JSON.stringify(w.store.fullSteps)).toBe(before.steps);
    expect(JSON.stringify([...w.store.cases.values()])).toBe(before.cases);
    expect(w.paypal.calls).toEqual([]);
  });
});
