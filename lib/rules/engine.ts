// Mahnwerk rules engine: default start, default interest, flat fee and payment allocation
// under German law (BGB 286, 288, 289, 367). Pure functions, no I/O, no clock access.
// This is a calculation aid, not legal advice.

import { addDays, diffDays, fromDayNumber, maxDate, toDayNumber } from "./dates";
import { Dec, assertCents, interestExact, roundHalfUpCents, type DecValue } from "./money";
import type {
  AllocationRow,
  AllocationTarget,
  BaseRateRow,
  CalcInput,
  CalcResult,
  DefaultRule,
  DunningStage,
  ISODate,
  InvoiceFacts,
  LedgerEntry,
  RuleSet,
  Segment,
} from "./types";

export interface DefaultStartResult {
  defaultStart: ISODate | null;
  defaultRule: DefaultRule | null;
  citation: string[];
}

/**
 * Earliest legal default start (first interest-bearing day) among the rules that apply.
 * (a) BGB 286(2) no. 1: due date fixed by the calendar, default from the next day without a reminder.
 * (b) BGB 286(1): payment request (Mahnung) sent after the due date, default from the next day.
 *     We use the send date as a proxy for receipt (Zugang); see report for the caveat.
 * (c) BGB 286(3): 30 days after the later of due date and receipt. A consumer only if the invoice
 *     warned about this consequence. If receipt is unknown and the debtor is a business, we use
 *     due date + 30 as a simplified stand-in for 286(3) sentence 2.
 */
export function computeDefaultStart(invoice: InvoiceFacts, ruleSet: RuleSet): DefaultStartResult {
  const c = ruleSet.citations;
  const candidates: { date: ISODate; rule: DefaultRule; citation: string[] }[] = [];

  if (invoice.fixedCalendarDue) {
    candidates.push({ date: addDays(invoice.dueDate, 1), rule: "fixed_calendar_date", citation: [c.fixedCalendarDate] });
  }

  if (invoice.firstPaymentRequestSentOn !== undefined) {
    // Only a request strictly after the due date counts (spec). A request before maturity has no effect.
    if (diffDays(invoice.dueDate, invoice.firstPaymentRequestSentOn) > 0) {
      candidates.push({
        date: addDays(invoice.firstPaymentRequestSentOn, 1),
        rule: "payment_request",
        citation: [c.paymentRequest],
      });
    }
  }

  const consumerAllowed = invoice.debtorType === "business" || invoice.defaultWarningPrinted;
  if (consumerAllowed) {
    if (invoice.receivedOn !== undefined) {
      const base = maxDate(invoice.dueDate, invoice.receivedOn);
      const citation = [c.thirtyDayRule];
      if (invoice.debtorType === "consumer") citation.push(c.consumerWarning);
      candidates.push({ date: addDays(base, ruleSet.thirtyDayRuleDays), rule: "thirty_day_rule", citation });
    } else if (invoice.debtorType === "business") {
      candidates.push({
        date: addDays(invoice.dueDate, ruleSet.thirtyDayRuleDays),
        rule: "thirty_day_rule",
        citation: [c.thirtyDayRule, c.thirtyDayRuleUncertainReceipt],
      });
    }
  }

  if (candidates.length === 0) return { defaultStart: null, defaultRule: null, citation: [] };
  // Earliest wins; on a tie the first pushed (a, then b, then c) wins.
  let best = candidates[0];
  for (const cand of candidates) {
    if (toDayNumber(cand.date) < toDayNumber(best.date)) best = cand;
  }
  return { defaultStart: best.date, defaultRule: best.rule, citation: best.citation };
}

/** Earliest date a dunning stage may be sent, given the date of the previous step. */
export function earliestStageDate(stage: DunningStage, previousStepDate: ISODate, ruleSet: RuleSet): ISODate {
  return addDays(previousStepDate, ruleSet.waitingDays[stage]);
}

interface RateTable {
  days: number[];
  rates: number[];
}

function buildRateTable(rows: readonly BaseRateRow[]): RateTable {
  const sorted = [...rows]
    .map((r) => {
      if (!Number.isInteger(r.rateBp)) throw new RangeError(`rateBp must be an integer, got ${r.rateBp}`);
      return { day: toDayNumber(r.valid_from), rateBp: r.rateBp };
    })
    .sort((a, b) => a.day - b.day);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].day === sorted[i - 1].day) throw new RangeError(`Duplicate base rate valid_from ${fromDayNumber(sorted[i].day)}`);
  }
  return { days: sorted.map((r) => r.day), rates: sorted.map((r) => r.rateBp) };
}

function baseRateOn(table: RateTable, day: number): number {
  let idx = -1;
  for (let i = 0; i < table.days.length; i++) {
    if (table.days[i] <= day) idx = i;
    else break;
  }
  if (idx < 0) throw new RangeError(`No base rate known for ${fromDayNumber(day)}`);
  return table.rates[idx];
}

function validateInput(input: CalcInput): void {
  const inv = input.invoice;
  assertCents(inv.principalCents, "principalCents");
  toDayNumber(inv.dueDate);
  toDayNumber(input.calcDate);
  if (inv.receivedOn !== undefined) toDayNumber(inv.receivedOn);
  if (inv.firstPaymentRequestSentOn !== undefined) toDayNumber(inv.firstPaymentRequestSentOn);
  for (const e of input.ledger) {
    toDayNumber(e.date);
    assertCents(e.amountCents, `ledger amountCents on ${e.date}`);
    if (e.kind !== "payment" && e.kind !== "refund") throw new RangeError(`Unknown ledger kind ${String(e.kind)}`);
  }
  const order = input.ruleSet.allocationOrder;
  const set = new Set<AllocationTarget>(order);
  if (order.length !== 3 || !set.has("fee") || !set.has("interest") || !set.has("principal")) {
    throw new RangeError("allocationOrder must be a permutation of fee, interest, principal");
  }
  if (input.ruleSet.flatFeeCents.consumer !== 0) {
    throw new RangeError("Flat fee for consumers must be 0 (BGB 288(5))");
  }
}

/**
 * Main calculation. Ledger entries dated after calcDate are ignored (they have not happened yet
 * from the point of view of calcDate). Same-day entries keep their input order.
 */
export function calculateClaim(input: CalcInput): CalcResult {
  validateInput(input);
  const { invoice, ruleSet } = input;
  const calcDay = toDayNumber(input.calcDate);
  const rateTable = buildRateTable(input.baseRates);
  const marginBp = ruleSet.marginBp[invoice.debtorType];
  const feeForDebtor = invoice.debtorType === "consumer" ? 0 : ruleSet.flatFeeCents.business;
  const basis = ruleSet.dayCountBasis;

  const ds = computeDefaultStart(invoice, ruleSet);
  const defaultDay = ds.defaultStart === null ? null : toDayNumber(ds.defaultStart);

  const entries = input.ledger
    .map((e, i) => ({ ...e, day: toDayNumber(e.date), i }))
    .filter((e) => e.day <= calcDay)
    .sort((a, b) => a.day - b.day || a.i - b.i);

  // Running state, all integer cents except the unsettled interest.
  let principalOpen = invoice.principalCents;
  let feeOpen = 0;
  let interestOpen = 0; // settled (rounded) and not yet paid
  let interestPaid = 0;
  let interestAccrued = 0; // sum of rounded settlements
  let credit = 0; // overpayment held for the debtor
  let refundCapped = 0; // refund amounts beyond what was still outstanding (not applied)
  let unsettled: DecValue = new Dec(0);
  let active = false;
  let flatFee = 0;
  let accrualDay = 0; // next day that has not yet accrued interest (valid when active)

  const segments: Segment[] = [];
  const allocation: AllocationRow[] = [];

  // Accrue interest on open principal for days [accrualDay, untilDay), split at base rate changes.
  const accrueUntil = (untilDay: number): void => {
    if (!active) return;
    let from = accrualDay;
    while (from < untilDay) {
      const rate = baseRateOn(rateTable, from) + marginBp;
      let to = untilDay;
      for (const d of rateTable.days) {
        if (d > from && d < to) {
          to = d;
          break;
        }
      }
      if (principalOpen > 0) {
        const days = to - from;
        const exact = interestExact(principalOpen, rate, days, basis);
        unsettled = unsettled.add(exact);
        segments.push({
          from: fromDayNumber(from),
          to: fromDayNumber(to),
          days,
          principalCents: principalOpen,
          rateBp: rate,
          interestExact: exact.toString(),
        });
      }
      from = to;
    }
    accrualDay = untilDay;
  };

  // Round the unsettled interest once (half up) and book it as open interest.
  const settle = (): void => {
    const rounded = roundHalfUpCents(unsettled);
    interestOpen += rounded;
    interestAccrued += rounded;
    unsettled = new Dec(0);
  };

  const activateIfDue = (day: number): void => {
    if (active || defaultDay === null || day < defaultDay || defaultDay > calcDay) return;
    // Default only bites if principal is still open at the start of the default start day.
    // A claim fully paid (or fully reduced by refunds) before that day never enters default.
    // Refunds only ever lower principal, so they can never create a default.
    if (principalOpen > 0) {
      active = true;
      accrualDay = defaultDay;
      feeOpen += feeForDebtor;
      flatFee = feeForDebtor;
    }
  };

  let activationChecked = false;
  for (const e of entries) {
    if (!activationChecked && defaultDay !== null && e.day >= defaultDay) {
      activateIfDue(defaultDay);
      activationChecked = true;
    }
    accrueUntil(e.day);

    if (e.kind === "payment") {
      if (active) settle();
      let rest = e.amountCents;
      const row: AllocationRow = {
        date: e.date,
        kind: "payment",
        amountCents: e.amountCents,
        toFee: 0,
        toInterest: 0,
        toPrincipal: 0,
        unappliedCents: 0,
      };
      // BGB 367(1): costs, then interest, then principal (order configurable).
      for (const target of ruleSet.allocationOrder) {
        if (target === "fee") {
          const x = Math.min(rest, feeOpen);
          feeOpen -= x;
          row.toFee += x;
          rest -= x;
        } else if (target === "interest") {
          const x = Math.min(rest, interestOpen);
          interestOpen -= x;
          interestPaid += x;
          row.toInterest += x;
          rest -= x;
        } else {
          const x = Math.min(rest, principalOpen);
          principalOpen -= x;
          row.toPrincipal += x;
          rest -= x;
        }
      }
      credit += rest;
      row.unappliedCents = rest;
      allocation.push(row);
    } else {
      // Refund = credit note (decision of Nov 3 2026): it REDUCES THE CLAIM. It never reopens
      // principal, never reopens interest or the fee and never restarts interest.
      // 1. It first consumes overpayment credit (returning money the debtor overpaid is not a
      //    claim reduction).
      // 2. The rest lowers the open principal from the refund's booked date on. Interest already
      //    accrued on earlier days stays (accrueUntil above ran up to this day with the old
      //    principal; the unsettled interest is kept and rounded at the next settlement).
      // 3. Anything beyond open principal is capped: not applied, reported in cappedCents and
      //    refundCappedCents so a human can review it. Interest and fee are never reduced.
      let rest = e.amountCents;
      const row: AllocationRow = {
        date: e.date,
        kind: "refund",
        amountCents: -e.amountCents,
        toFee: 0,
        toInterest: 0,
        toPrincipal: 0,
        unappliedCents: 0,
        cappedCents: 0,
      };
      const c = Math.min(rest, credit);
      credit -= c;
      row.unappliedCents = 0 - c; // 0 - c avoids -0
      rest -= c;
      const x = Math.min(rest, principalOpen);
      principalOpen -= x;
      row.toPrincipal = 0 - x;
      rest -= x;
      row.cappedCents = rest;
      refundCapped += rest;
      allocation.push(row);
    }
  }
  if (!activationChecked && defaultDay !== null) activateIfDue(defaultDay);
  accrueUntil(calcDay);
  if (active) settle();

  const citation = [...ds.citation];
  if (active) {
    citation.push(
      invoice.debtorType === "consumer" ? ruleSet.citations.interestConsumer : ruleSet.citations.interestBusiness,
      ruleSet.citations.baseRate,
      ruleSet.citations.noInterestOnInterest,
    );
    if (flatFee > 0) citation.push(ruleSet.citations.flatFee);
  }
  if (allocation.length > 0) citation.push(ruleSet.citations.allocation);

  const totalDue = principalOpen + interestOpen + feeOpen;
  if (totalDue < 0 || principalOpen < 0 || interestOpen < 0 || feeOpen < 0) {
    throw new Error("Internal invariant violated: negative open amount");
  }

  return {
    // In default at calcDate: default has begun and principal is still open. Once the principal
    // is fully paid the default ends, even if interest or the fee is still owed.
    inDefault: active && principalOpen > 0,
    defaultStart: ds.defaultStart,
    defaultRule: ds.defaultRule,
    citation,
    segments,
    interestAccruedCents: interestAccrued,
    interestPaidCents: interestPaid,
    flatFeeCents: flatFee,
    openPrincipalCents: principalOpen,
    openInterestCents: interestOpen,
    openFeeCents: feeOpen,
    totalDueCents: totalDue,
    creditCents: credit,
    refundCappedCents: refundCapped,
    allocation,
  };
}

export type { LedgerEntry };
