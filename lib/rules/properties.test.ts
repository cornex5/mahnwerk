// Independent counter-check of the engine. The simulator below shares NO code with engine.ts,
// dates.ts or money.ts: it has its own date math, its own default-start logic and walks day by day.
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { calculateClaim } from "./engine";
import { DE_RULESET } from "./de";
import type { BaseRateRow, CalcResult, InvoiceFacts, LedgerEntry } from "./types";

const D = Decimal.clone({ precision: 60 });

// TEST FIXTURE ONLY: the 2027 rows are hypothetical, used to exercise rate changes.
const RATES: BaseRateRow[] = [
  { valid_from: "2026-07-01", rateBp: 152 },
  { valid_from: "2027-01-01", rateBp: 200 },
  { valid_from: "2027-07-01", rateBp: -88 },
];

// ---- own date math ----
const dayOf = (iso: string): number => {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
};
const isoOf = (n: number): string => new Date(n * 86400000).toISOString().slice(0, 10);

// ---- seeded PRNG (mulberry32) ----
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimOut {
  defaultDay: number | null;
  settlements: number;
  interestAccrued: number;
  principalOpen: number;
  interestOpen: number;
  feeOpen: number;
  fee: number;
  alloc: { fee: number; interest: number; principal: number; unapplied: number }[];
}

function simulate(inv: InvoiceFacts, ledger: LedgerEntry[], calcDate: string): SimOut {
  // Default start, re-derived from the statute summary independently.
  const opts: number[] = [];
  const due = dayOf(inv.dueDate);
  if (inv.fixedCalendarDue) opts.push(due + 1);
  if (inv.firstPaymentRequestSentOn && dayOf(inv.firstPaymentRequestSentOn) > due) opts.push(dayOf(inv.firstPaymentRequestSentOn) + 1);
  if (inv.debtorType === "business" || inv.defaultWarningPrinted) {
    if (inv.receivedOn) opts.push(Math.max(due, dayOf(inv.receivedOn)) + 30);
    else if (inv.debtorType === "business") opts.push(due + 30);
  }
  const defaultDay = opts.length ? Math.min(...opts) : null;

  const margin = inv.debtorType === "consumer" ? 500 : 900;
  const feeAmount = inv.debtorType === "consumer" ? 0 : 4000;
  const end = dayOf(calcDate);
  const rateOn = (day: number) => {
    let r: number | null = null;
    for (const row of RATES) if (dayOf(row.valid_from) <= day) r = row.rateBp;
    if (r === null) throw new Error("no rate");
    return r + margin;
  };

  let pOpen = inv.principalCents, pPaid = 0, iOpen = 0, iPaid = 0, fOpen = 0, fPaid = 0, credit = 0;
  let acc = new D(0);
  let active = false, settlements = 0, accrued = 0, fee = 0;
  const alloc: SimOut["alloc"] = [];
  const settle = () => {
    const c = acc.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
    iOpen += c;
    accrued += c;
    acc = new D(0);
    settlements++;
  };
  const byDay = new Map<number, LedgerEntry[]>();
  for (const e of ledger) {
    const k = dayOf(e.date);
    if (k > end) continue;
    byDay.set(k, [...(byDay.get(k) ?? []), e]);
  }
  const startDay = Math.min(due, ...[...byDay.keys()]);
  for (let day = startDay; day <= end; day++) {
    if (!active && defaultDay !== null && day === defaultDay && pOpen > 0) {
      active = true;
      fOpen += feeAmount;
      fee = feeAmount;
    }
    for (const e of byDay.get(day) ?? []) {
      if (e.kind === "payment") {
        if (active) settle();
        let rest = e.amountCents;
        const f = Math.min(rest, fOpen); fOpen -= f; fPaid += f; rest -= f;
        const i = Math.min(rest, iOpen); iOpen -= i; iPaid += i; rest -= i;
        const p = Math.min(rest, pOpen); pOpen -= p; pPaid += p; rest -= p;
        credit += rest;
        alloc.push({ fee: f, interest: i, principal: p, unapplied: rest });
      } else {
        let rest = e.amountCents;
        const c = Math.min(rest, credit); credit -= c; rest -= c;
        const p = Math.min(rest, pPaid); pPaid -= p; pOpen += p; rest -= p;
        const i = Math.min(rest, iPaid); iPaid -= i; iOpen += i; rest -= i;
        const f = Math.min(rest, fPaid); fPaid -= f; fOpen += f; rest -= f;
        if (rest > 0) throw new Error("refund exceeds paid");
        alloc.push({ fee: -f, interest: -i, principal: -p, unapplied: -c });
      }
    }
    if (day === end) break; // end exclusive
    if (active) acc = acc.add(new D(pOpen).mul(rateOn(day)).div(10000).div(365));
  }
  if (active) settle();
  return { defaultDay, settlements, interestAccrued: accrued, principalOpen: pOpen, interestOpen: iOpen, feeOpen: fOpen, fee, alloc };
}

function scenario(rand: () => number, idx: number) {
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const debtorType = pick(["consumer", "business"] as const);
  const due = dayOf("2026-07-01") + int(0, 400);
  const inv: InvoiceFacts = {
    principalCents: idx % 25 === 0 ? int(1, 99) * 1_000_000_000 : int(1, 500_000),
    dueDate: isoOf(due),
    fixedCalendarDue: rand() < 0.35,
    defaultWarningPrinted: rand() < 0.5,
    debtorType,
  };
  if (rand() < 0.6) inv.receivedOn = isoOf(due + int(-15, 20));
  if (rand() < 0.4) inv.firstPaymentRequestSentOn = isoOf(due + int(-5, 40));
  const calc = due + int(-10, 200);
  const ledger: LedgerEntry[] = [];
  const n = int(0, 5);
  let paid = 0;
  const days = Array.from({ length: n }, () => due + int(-20, 210)).sort((a, b) => a - b);
  for (const d of days) {
    if (paid > 0 && rand() < 0.2) {
      const amt = int(1, paid);
      ledger.push({ date: isoOf(d), kind: "refund", amountCents: amt });
      paid -= amt;
    } else {
      const amt = int(1, Math.max(1, Math.floor(inv.principalCents * 0.6)));
      ledger.push({ date: isoOf(d), kind: "payment", amountCents: amt });
      paid += amt;
    }
  }
  return { inv, ledger, calcDate: isoOf(calc) };
}

describe("engine vs naive day-by-day simulator (300 seeded scenarios)", () => {
  const rand = prng(20261103);
  const cases = Array.from({ length: 300 }, (_, i) => scenario(rand, i));

  it("matches within 1 cent per settlement and holds invariants", () => {
    let checkedDefaults = 0;
    for (const [i, c] of cases.entries()) {
      const r: CalcResult = calculateClaim({ invoice: c.inv, ledger: c.ledger, calcDate: c.calcDate, ruleSet: DE_RULESET, baseRates: RATES });
      const s = simulate(c.inv, c.ledger, c.calcDate);
      const tol = Math.max(1, s.settlements);
      const ctx = `scenario ${i}: ${JSON.stringify(c)}`;

      expect(r.defaultStart === null ? null : dayOf(r.defaultStart), ctx).toBe(s.defaultDay);
      if (s.defaultDay !== null) checkedDefaults++;
      expect(Math.abs(r.interestAccruedCents - s.interestAccrued), ctx).toBeLessThanOrEqual(tol);
      expect(Math.abs(r.openInterestCents - s.interestOpen), ctx).toBeLessThanOrEqual(tol);
      expect(Math.abs(r.openPrincipalCents - s.principalOpen), ctx).toBeLessThanOrEqual(tol);
      expect(r.flatFeeCents, ctx).toBe(s.fee);
      expect(r.openFeeCents, ctx).toBe(s.feeOpen);
      expect(r.allocation.length, ctx).toBe(s.alloc.length);

      // Invariants
      expect(r.totalDueCents, ctx).toBeGreaterThanOrEqual(0);
      expect(r.totalDueCents, ctx).toBe(r.openPrincipalCents + r.openInterestCents + r.openFeeCents);
      for (const a of r.allocation) {
        expect(a.toFee + a.toInterest + a.toPrincipal + a.unappliedCents, ctx).toBe(a.amountCents);
      }
      const consideredSum = c.ledger
        .filter((e) => dayOf(e.date) <= dayOf(c.calcDate))
        .reduce((t, e) => t + (e.kind === "payment" ? e.amountCents : -e.amountCents), 0);
      expect(r.allocation.reduce((t, a) => t + a.amountCents, 0), ctx).toBe(consideredSum);
      if (c.inv.debtorType === "consumer") {
        expect(r.flatFeeCents, ctx).toBe(0);
        expect(r.openFeeCents, ctx).toBe(0);
        expect(r.allocation.every((a) => a.toFee === 0), ctx).toBe(true);
      }
      expect(r.openPrincipalCents, ctx).toBeLessThanOrEqual(c.inv.principalCents);
    }
    // Sanity: the generator really produces defaults, not only trivial cases.
    expect(checkedDefaults).toBeGreaterThan(100);
  });
});
