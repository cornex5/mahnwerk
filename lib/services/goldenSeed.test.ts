import { describe, expect, it } from "vitest";
import { calculateClaim } from "../rules/engine";
import { DE_BASE_RATES, DE_RULESET } from "../rules/de";
import { GOLDEN_VIRTUAL_DATE } from "./context";
import { GOLDEN_CURATOR_UID, buildGoldenSeed, insertGoldenSeed } from "./goldenSeed";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("golden seed builder", () => {
  const seed = buildGoldenSeed("seed-a");
  const byLabel = (label: string) => seed.cases.find((c) => seed.labels[c.id] === label)!;

  it("covers the required states at the fixed virtual date", () => {
    expect(seed.virtualDate).toBe(GOLDEN_VIRTUAL_DATE);
    expect(seed.invoices.length).toBeGreaterThanOrEqual(6);
    expect(Object.fromEntries(seed.cases.map((c) => [seed.labels[c.id], c.state]))).toEqual({
      open: "open",
      overdue: "overdue",
      reminded: "reminded",
      mahnung1: "mahnung1",
      partial_payment: "reminded",
      paused_dispute: "paused_dispute",
      closed_paid: "closed_paid",
    });
    expect(byLabel("paused_dispute")).toMatchObject({ prev_state: "reminded", paused_reason: "dispute:SIM-D-GOLDEN0006" });
    expect(seed.workspace).toMatchObject({ kind: "golden", owner_uid: null, expires_at: null });
  });

  it("is deterministic per seed and unique across seeds", () => {
    expect(buildGoldenSeed("seed-a")).toEqual(seed);
    const other = buildGoldenSeed("seed-b");
    expect(other.workspace.id).not.toBe(seed.workspace.id);
    for (const id of [seed.workspace.id, ...seed.invoices.map((i) => i.id), ...seed.steps.map((s) => s.id)]) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it("only has sent steps with a recorded approval, and pending proposals where due", () => {
    for (const s of seed.steps) {
      if (s.status === "sent" || s.status === "approved") {
        expect(s.approved_by).toBe(GOLDEN_CURATOR_UID);
        expect(s.approved_at).toBeTruthy();
      }
    }
    const pending = seed.steps.filter((s) => s.status === "proposed").map((s) => `${seed.labels[s.case_id]}:${s.kind}`).sort();
    expect(pending).toEqual(["closed_paid:fee_invoice", "mahnung1:mahnung2", "overdue:reminder", "partial_payment:mahnung1", "reminded:mahnung1"]);
  });

  it("matches the rules engine for the partial payment and the paid case", () => {
    const partial = byLabel("partial_payment");
    expect(seed.ledger.filter((l) => l.invoice_id === partial.invoice_id).map((l) => l.amount_cents)).toEqual([40000]);
    const paid = byLabel("closed_paid");
    const inv = seed.invoices.find((i) => i.id === paid.invoice_id)!;
    const r = calculateClaim({
      invoice: { principalCents: inv.principal_cents, dueDate: inv.due_date, fixedCalendarDue: true, defaultWarningPrinted: true, receivedOn: inv.received_on!, firstPaymentRequestSentOn: "2026-09-18", debtorType: "business" },
      ledger: seed.ledger.filter((l) => l.invoice_id === inv.id).map((l) => ({ date: l.booked_on, kind: l.kind, amountCents: l.amount_cents })),
      calcDate: GOLDEN_VIRTUAL_DATE,
      ruleSet: DE_RULESET,
      baseRates: DE_BASE_RATES,
    });
    const fee = seed.steps.find((s) => s.case_id === paid.id && s.kind === "fee_invoice")!;
    expect(fee.facts).toMatchObject({ totalCents: r.totalDueCents, feeCents: 4000, interestCents: r.interestAccruedCents });
    expect(r.totalDueCents).toBe(4000 + r.interestAccruedCents);
  });

  it("writes a coherent audit trail per case", () => {
    for (const c of seed.cases) {
      const rows = seed.audit.filter((a) => a.case_id === c.id);
      expect(rows[0].action).toBe("invoice.sent");
      const transitions = rows.filter((a) => a.action.startsWith("case."));
      expect(transitions.length).toBe(c.version);
      if (transitions.length > 0) expect(transitions.at(-1)!.to_state).toBe(c.state);
      for (let i = 1; i < transitions.length; i++) expect(transitions[i].from_state).toBe(transitions[i - 1].to_state);
    }
  });
});

describe("insertGoldenSeed", () => {
  function fakeDb(existingGolden: boolean, failOn?: string) {
    const ops: string[] = [];
    const db = {
      from(table: string) {
        return {
          select: () => ({ eq: async () => ({ data: existingGolden ? [{ id: "old" }] : [], error: null }) }),
          delete: () => ({
            eq: async (col: string, val: string) => {
              ops.push(`delete ${table} ${col}=${val}`);
              return { error: null };
            },
          }),
          insert: async (rows: unknown[]) => {
            ops.push(`insert ${table} ${rows.length}`);
            return { error: table === failOn ? { message: "boom" } : null };
          },
        };
      },
    };
    return { db: db as unknown as SupabaseClient, ops };
  }

  it("refuses when a golden workspace exists unless replace is set", async () => {
    const seed = buildGoldenSeed("x");
    await expect(insertGoldenSeed(fakeDb(true).db, seed)).rejects.toThrow(/already exists/);
    const { db, ops } = fakeDb(true);
    await insertGoldenSeed(db, seed, { replace: true });
    expect(ops[0]).toBe("delete workspaces kind=golden");
    expect(ops.slice(1).map((o) => o.split(" ")[1])).toEqual(["workspaces", "creditors", "debtors", "invoices", "dunning_cases", "steps", "ledger", "audit_log"]);
  });

  it("removes the half-inserted workspace on failure", async () => {
    const seed = buildGoldenSeed("y");
    const { db, ops } = fakeDb(false, "steps");
    await expect(insertGoldenSeed(db, seed)).rejects.toThrow(/insert steps/);
    expect(ops.at(-1)).toBe(`delete workspaces id=${seed.workspace.id}`);
  });
});
