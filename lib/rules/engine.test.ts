import { describe, expect, it } from "vitest";
import { calculateClaim, computeDefaultStart, earliestStageDate } from "./engine";
import { DE_BASE_RATES, DE_RULESET } from "./de";
import { legalNoteKeys } from "./legalNotes";
import { addDays, diffDays } from "./dates";
import type { BaseRateRow, CalcInput, InvoiceFacts, LedgerEntry } from "./types";

// TEST FIXTURE ONLY: hypothetical base rate 2.00 percent from 2027-01-01. Not a real published rate.
const FIXTURE_RATES: BaseRateRow[] = [...DE_BASE_RATES, { valid_from: "2027-01-01", rateBp: 200, source: "TEST FIXTURE" }];

function biz(over: Partial<InvoiceFacts> = {}): InvoiceFacts {
  return {
    principalCents: 100000,
    dueDate: "2026-07-31",
    fixedCalendarDue: true, // default starts 2026-08-01
    defaultWarningPrinted: false,
    debtorType: "business",
    ...over,
  };
}

function run(invoice: InvoiceFacts, calcDate: string, ledger: LedgerEntry[] = [], baseRates = DE_BASE_RATES) {
  const input: CalcInput = { invoice, ledger, calcDate, ruleSet: DE_RULESET, baseRates };
  return calculateClaim(input);
}

describe("required tests", () => {
  it("1. business, 100000, 30 days at 10.52 percent: 865", () => {
    // 100000 x 0.1052 x 30 / 365 = 864.6575... -> 865
    const r = run(biz(), "2026-08-31");
    expect(r.inDefault).toBe(true);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toMatchObject({ from: "2026-08-01", to: "2026-08-31", days: 30, rateBp: 1052 });
    expect(r.interestAccruedCents).toBe(865);
    expect(r.flatFeeCents).toBe(4000);
    expect(r.totalDueCents).toBe(100000 + 865 + 4000);
  });

  it("2. consumer, 100000, 30 days at 6.52 percent: 536, fee 0", () => {
    // 100000 x 0.0652 x 30 / 365 = 535.8904... -> 536
    const r = run(biz({ debtorType: "consumer" }), "2026-08-31");
    expect(r.segments[0].rateBp).toBe(652);
    expect(r.interestAccruedCents).toBe(536);
    expect(r.flatFeeCents).toBe(0);
    expect(r.openFeeCents).toBe(0);
  });

  it("3. business partial payment on day 10, then 20 days on 64288", () => {
    // Days 0..10: 100000 x 0.1052 x 10 / 365 = 288.2191... -> 288 (settled at the payment)
    // Payment 40000: fee 4000, interest 288, principal 35712 -> open principal 64288
    // Days 10..30: 64288 x 0.1052 x 20 / 365 = 370.5807... -> 371
    const r = run(biz(), "2026-08-31", [{ date: "2026-08-11", kind: "payment", amountCents: 40000 }]);
    expect(r.allocation).toEqual([
      { date: "2026-08-11", kind: "payment", amountCents: 40000, toFee: 4000, toInterest: 288, toPrincipal: 35712, unappliedCents: 0 },
    ]);
    expect(r.segments.map((s) => [s.days, s.principalCents])).toEqual([
      [10, 100000],
      [20, 64288],
    ]);
    expect(r.interestAccruedCents).toBe(288 + 371);
    expect(r.openInterestCents).toBe(371);
    expect(r.openPrincipalCents).toBe(64288);
    expect(r.openFeeCents).toBe(0);
    expect(r.totalDueCents).toBe(64288 + 371);
  });

  it("4. base rate change across new year (fixture 2.00 percent): 854", () => {
    // 2026-12-17..2027-01-01: 15 days at 10.52: 100000 x 0.1052 x 15 / 365 = 432.3287...
    // 2027-01-01..2027-01-15: 14 days at 11.00: 100000 x 0.1100 x 14 / 365 = 421.9178...
    // Sum 854.2465... -> 854. The original plan said 884; that was an arithmetic error, 854 is correct.
    const r = run(biz({ dueDate: "2026-12-16" }), "2027-01-15", [], FIXTURE_RATES);
    expect(r.defaultStart).toBe("2026-12-17");
    expect(r.segments.map((s) => [s.from, s.to, s.days, s.rateBp])).toEqual([
      ["2026-12-17", "2027-01-01", 15, 1052],
      ["2027-01-01", "2027-01-15", 14, 1100],
    ]);
    expect(Number(r.segments[0].interestExact).toFixed(2)).toBe("432.33");
    expect(Number(r.segments[1].interestExact).toFixed(2)).toBe("421.92");
    expect(r.interestAccruedCents).toBe(854);
  });

  it("5. consumer without warning, 35 days overdue, no Mahnung: not in default", () => {
    const inv = biz({ debtorType: "consumer", fixedCalendarDue: false, receivedOn: "2026-07-20" });
    const r = run(inv, addDays(inv.dueDate, 35));
    expect(r.inDefault).toBe(false);
    expect(r.defaultStart).toBeNull();
    expect(r.interestAccruedCents).toBe(0);
    expect(r.flatFeeCents).toBe(0);
    expect(r.totalDueCents).toBe(100000);
  });

  it("6. business with unknown receivedOn: default on due + 30", () => {
    const inv = biz({ fixedCalendarDue: false });
    const r = computeDefaultStart(inv, DE_RULESET);
    expect(r.defaultStart).toBe("2026-08-30");
    expect(r.defaultRule).toBe("thirty_day_rule");
    expect(r.citation).toContain("BGB § 286(3) sentence 1");
  });

  it("7. fixed calendar due date: default the next day without a reminder", () => {
    const r = run(biz(), "2026-08-01");
    expect(r.defaultStart).toBe("2026-08-01");
    expect(r.defaultRule).toBe("fixed_calendar_date");
    expect(r.citation).toContain("BGB § 286(2) no. 1");
    expect(r.inDefault).toBe(true);
    expect(r.interestAccruedCents).toBe(0); // zero days accrued yet (end exclusive)
  });

  it("8. paid in full before default start: interest 0, fee 0", () => {
    const r = run(biz(), "2026-09-30", [{ date: "2026-07-31", kind: "payment", amountCents: 100000 }]);
    expect(r.inDefault).toBe(false);
    expect(r.interestAccruedCents).toBe(0);
    expect(r.flatFeeCents).toBe(0);
    expect(r.totalDueCents).toBe(0);
  });

  it("9. legal notes", () => {
    const b = legalNoteKeys({ creditorIsSmallBusiness: true, debtorType: "business" });
    const c = legalNoteKeys({ creditorIsSmallBusiness: true, debtorType: "consumer" });
    expect(b).toContain("kleinunternehmer_no_vat");
    expect(c).toContain("kleinunternehmer_no_vat");
    expect(b).toContain("flat_fee_business_only");
    expect(c).not.toContain("flat_fee_business_only");
    expect(c).toContain("consumer_default_warning_required");
    expect(b).toContain("not_legal_advice");
    expect(c).toContain("not_legal_advice");
    expect(legalNoteKeys({ creditorIsSmallBusiness: false, debtorType: "business" })).not.toContain("kleinunternehmer_no_vat");
  });
});

describe("edge cases", () => {
  it("payment exactly on default start day: fee due, zero interest days", () => {
    const r = run(biz(), "2026-08-31", [{ date: "2026-08-01", kind: "payment", amountCents: 100000 }]);
    // Fee 4000 first, interest 0, principal 96000. Then 30 days on 96000:
    // 96000 x 0.1052 x 30 / 365 = 830.0712... -> 830
    expect(r.allocation[0]).toMatchObject({ toFee: 4000, toInterest: 0, toPrincipal: 96000 });
    expect(r.openPrincipalCents).toBe(4000);
    expect(r.interestAccruedCents).toBe(Math.round((4000 * 0.1052 * 30) / 365)); // 4000 x 0.1052 x 30 / 365 = 34.58 -> 35
    expect(r.interestAccruedCents).toBe(35);
  });

  it("overpayment is held as credit, totals never negative", () => {
    // 10 days: 288 interest. Payment 110000: fee 4000, interest 288, principal 100000, credit 5712
    const r = run(biz(), "2026-08-31", [{ date: "2026-08-11", kind: "payment", amountCents: 110000 }]);
    expect(r.allocation[0]).toMatchObject({ toFee: 4000, toInterest: 288, toPrincipal: 100000, unappliedCents: 5712 });
    expect(r.creditCents).toBe(5712);
    expect(r.totalDueCents).toBe(0);
    expect(r.inDefault).toBe(false);
  });

  // Refund semantics changed on Nov 3 2026 (decision by Jonas): a refund is a credit note that
  // REDUCES THE CLAIM. It never reopens principal and never restarts interest. The two earlier
  // tests ("refund after payment reopens principal and it accrues again" and "refund larger than
  // paid is rejected") encoded the old negative-payment semantics and were replaced by these.
  it("refund after payment lowers principal from the refund date; earlier interest stays", () => {
    // Payment day 10: 4000 fee, 288 interest, 35712 principal (open 64288).
    // Refund day 20 of 10000 reduces the claim: open 54288.
    // Days 10..20 on 64288: 64288 x 0.1052 x 10 / 365 = 185.2903...
    // Days 20..30 on 54288: 54288 x 0.1052 x 10 / 365 = 156.4684...
    // Single settlement at calcDate (a refund is not a payment, no settlement): 341.7587 -> 342
    const r = run(biz(), "2026-08-31", [
      { date: "2026-08-11", kind: "payment", amountCents: 40000 },
      { date: "2026-08-21", kind: "refund", amountCents: 10000 },
    ]);
    expect(r.allocation[1]).toEqual({
      date: "2026-08-21", kind: "refund", amountCents: -10000, toFee: 0, toInterest: 0, toPrincipal: -10000, unappliedCents: 0, cappedCents: 0,
    });
    expect(r.segments.map((s) => [s.from, s.to, s.principalCents])).toEqual([
      ["2026-08-01", "2026-08-11", 100000],
      ["2026-08-11", "2026-08-21", 64288],
      ["2026-08-21", "2026-08-31", 54288],
    ]);
    expect(r.openPrincipalCents).toBe(54288);
    expect(r.openInterestCents).toBe(342);
    expect(r.interestAccruedCents).toBe(288 + 342);
    expect(r.openFeeCents).toBe(0);
    expect(r.refundCappedCents).toBe(0);
  });

  it("refund with nothing paid reduces the claim before default", () => {
    // Claim 100000 reduced to 70000 on 2026-07-20. Default 2026-08-01 on 70000:
    // 70000 x 0.1052 x 30 / 365 = 605.2602... -> 605
    const r = run(biz(), "2026-08-31", [{ date: "2026-07-20", kind: "refund", amountCents: 30000 }]);
    expect(r.openPrincipalCents).toBe(70000);
    expect(r.interestAccruedCents).toBe(605);
    expect(r.flatFeeCents).toBe(4000);
    expect(r.totalDueCents).toBe(70000 + 605 + 4000);
  });

  it("full refund with nothing paid before default: no default, nothing owed", () => {
    const r = run(biz(), "2026-08-31", [{ date: "2026-07-20", kind: "refund", amountCents: 100000 }]);
    expect(r.inDefault).toBe(false);
    expect(r.interestAccruedCents).toBe(0);
    expect(r.flatFeeCents).toBe(0);
    expect(r.totalDueCents).toBe(0);
    expect(r.refundCappedCents).toBe(0);
  });

  it("refund after full payment never reopens and never creates a default; it is capped", () => {
    const r = run(biz(), "2026-09-30", [
      { date: "2026-07-31", kind: "payment", amountCents: 100000 },
      { date: "2026-08-15", kind: "refund", amountCents: 50000 },
    ]);
    expect(r.inDefault).toBe(false);
    expect(r.interestAccruedCents).toBe(0);
    expect(r.flatFeeCents).toBe(0);
    expect(r.openPrincipalCents).toBe(0);
    expect(r.totalDueCents).toBe(0);
    expect(r.allocation[1]).toMatchObject({ kind: "refund", amountCents: -50000, toPrincipal: 0, cappedCents: 50000 });
    expect(r.refundCappedCents).toBe(50000);
  });

  it("refund larger than the open principal is capped; interest and fee are never reduced", () => {
    // Payment day 10: open principal 64288, interest 288 paid, fee paid.
    // Refund 70000 on day 20: principal 0, 5712 capped. Days 10..20 on 64288: 185.29 -> 185, then 0.
    const r = run(biz(), "2026-08-31", [
      { date: "2026-08-11", kind: "payment", amountCents: 40000 },
      { date: "2026-08-21", kind: "refund", amountCents: 70000 },
    ]);
    expect(r.allocation[1]).toMatchObject({ toFee: 0, toInterest: 0, toPrincipal: -64288, cappedCents: 5712 });
    expect(r.refundCappedCents).toBe(5712);
    expect(r.openPrincipalCents).toBe(0);
    expect(r.openInterestCents).toBe(185);
    expect(r.openFeeCents).toBe(0);
    expect(r.totalDueCents).toBe(185);
    expect(r.inDefault).toBe(false);
  });

  it("refund first consumes overpayment credit", () => {
    // Payment 110000 on day 10: credit 5712. Refund 5712 returns the overpayment.
    const r = run(biz(), "2026-08-31", [
      { date: "2026-08-11", kind: "payment", amountCents: 110000 },
      { date: "2026-08-12", kind: "refund", amountCents: 5712 },
    ]);
    expect(r.allocation[1]).toMatchObject({ unappliedCents: -5712, toPrincipal: 0, cappedCents: 0 });
    expect(r.creditCents).toBe(0);
    expect(r.refundCappedCents).toBe(0);
    expect(r.totalDueCents).toBe(0);
  });

  it("two partial payments", () => {
    // Days 0..10 on 100000: 288.2191 -> 288. Pay 10000: fee 4000, interest 288, principal 5712 -> 94288
    // Days 10..20 on 94288: 94288 x 0.1052 x 10 / 365 = 271.7568 -> 272. Pay 10000: interest 272, principal 9728 -> 84560
    // Days 20..30 on 84560: 84560 x 0.1052 x 10 / 365 = 243.7194 -> 244
    const r = run(biz(), "2026-08-31", [
      { date: "2026-08-11", kind: "payment", amountCents: 10000 },
      { date: "2026-08-21", kind: "payment", amountCents: 10000 },
    ]);
    expect(r.allocation.map((a) => [a.toFee, a.toInterest, a.toPrincipal])).toEqual([
      [4000, 288, 5712],
      [0, 272, 9728],
    ]);
    expect(r.openPrincipalCents).toBe(84560);
    expect(r.openInterestCents).toBe(244);
    expect(r.interestPaidCents).toBe(560);
    expect(r.interestAccruedCents).toBe(804);
  });

  it("calcDate before default start: not in default yet, but default start known", () => {
    const r = run(biz(), "2026-07-20");
    expect(r.inDefault).toBe(false);
    expect(r.defaultStart).toBe("2026-08-01");
    expect(r.flatFeeCents).toBe(0);
    expect(r.totalDueCents).toBe(100000);
  });

  it("leap year boundary: 29 Feb counts as a day, still divided by 365", () => {
    // 2028-02-27..2028-03-02 = 4 days (27, 28, 29 Feb, 1 Mar). 100000 x 0.1052 x 4 / 365 = 115.2877 -> 115
    const r = run(biz({ dueDate: "2028-02-26" }), "2028-03-02");
    expect(r.segments[0].days).toBe(4);
    expect(diffDays("2028-02-27", "2028-03-02")).toBe(4);
    expect(r.interestAccruedCents).toBe(115);
  });

  it("huge principal: no float drift", () => {
    // 900000000000000 x 1052 x 30 / 3650000 = 7781917808219.178... -> 7781917808219
    const r = run(biz({ principalCents: 900_000_000_000_000 }), "2026-08-31");
    expect(r.interestAccruedCents).toBe(7_781_917_808_219);
    expect(r.segments[0].interestExact.startsWith("7781917808219.178082191780821917808")).toBe(true);
  });

  it("consumer default via printed warning: 30 days after the later of due and receipt", () => {
    const inv = biz({
      debtorType: "consumer",
      fixedCalendarDue: false,
      defaultWarningPrinted: true,
      dueDate: "2026-07-10",
      receivedOn: "2026-07-05",
    });
    const r = run(inv, "2026-08-19");
    expect(r.defaultStart).toBe("2026-08-09"); // 2026-07-10 + 30
    expect(r.defaultRule).toBe("thirty_day_rule");
    expect(r.citation).toContain("BGB § 286(3) sentence 1, second half-sentence");
    // 10 days at 6.52 percent: 100000 x 0.0652 x 10 / 365 = 178.6301 -> 179
    expect(r.interestAccruedCents).toBe(179);
    expect(r.flatFeeCents).toBe(0);
  });

  it("receipt after due date moves the 30-day start", () => {
    const r = computeDefaultStart(biz({ fixedCalendarDue: false, dueDate: "2026-07-10", receivedOn: "2026-07-20" }), DE_RULESET);
    expect(r.defaultStart).toBe("2026-08-19");
  });

  it("payment request after due date triggers default the next day; earliest rule wins", () => {
    const inv = biz({ fixedCalendarDue: false, receivedOn: "2026-07-01", firstPaymentRequestSentOn: "2026-08-05" });
    const r = computeDefaultStart(inv, DE_RULESET);
    expect(r.defaultStart).toBe("2026-08-06");
    expect(r.defaultRule).toBe("payment_request");
    expect(r.citation).toEqual(["BGB § 286(1) sentence 1"]);
  });

  it("payment request on or before due date is ignored", () => {
    const inv = biz({ debtorType: "consumer", fixedCalendarDue: false, firstPaymentRequestSentOn: "2026-07-31" });
    expect(computeDefaultStart(inv, DE_RULESET).defaultStart).toBeNull();
  });

  it("ledger entries after calcDate are ignored", () => {
    const r = run(biz(), "2026-08-31", [{ date: "2026-09-15", kind: "payment", amountCents: 100000 }]);
    expect(r.allocation).toHaveLength(0);
    expect(r.interestAccruedCents).toBe(865);
  });

  it("waiting days per stage", () => {
    expect(earliestStageDate("mahnung1", "2026-08-01", DE_RULESET)).toBe("2026-08-08");
    expect(earliestStageDate("mahnung2", "2026-08-08", DE_RULESET)).toBe("2026-08-18");
    expect(earliestStageDate("handover", "2026-08-18", DE_RULESET)).toBe("2026-09-01");
    expect(earliestStageDate("reminder", "2026-08-01", DE_RULESET)).toBe("2026-08-01");
  });

  it("missing base rate for a date is an error, not a silent zero", () => {
    expect(() => run(biz({ dueDate: "2026-05-31" }), "2026-06-30")).toThrow(/No base rate/);
  });

  it("production table holds no fixture row", () => {
    expect(DE_BASE_RATES.every((r) => r.valid_from !== "2027-01-01")).toBe(true);
  });
});
