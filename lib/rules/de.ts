// German rule set (BGB 286, 288, 289, 367, 247) and the dated base rate table.
// This encodes statutory defaults for a demo product. It is not legal advice.

import type { BaseRateRow, RuleSet } from "./types";

export const DE_RULESET: RuleSet = {
  jurisdiction: "DE",
  // BGB 288(1) sentence 2: 5 percentage points over base rate (consumer involved).
  // BGB 288(2): 9 percentage points over base rate (no consumer involved).
  marginBp: { consumer: 500, business: 900 },
  // BGB 288(5): 40 EUR flat fee only when the debtor is not a consumer.
  flatFeeCents: { consumer: 0, business: 4000 },
  dayCountBasis: 365,
  thirtyDayRuleDays: 30,
  // Product policy (not statutory): minimum days to wait after the previous step.
  waitingDays: { reminder: 0, mahnung1: 7, mahnung2: 10, handover: 14 },
  // BGB 367(1): costs first, then interest, then principal.
  allocationOrder: ["fee", "interest", "principal"],
  citations: {
    fixedCalendarDate: "BGB § 286(2) no. 1",
    paymentRequest: "BGB § 286(1) sentence 1",
    thirtyDayRule: "BGB § 286(3) sentence 1",
    thirtyDayRuleUncertainReceipt: "BGB § 286(3) sentence 2",
    consumerWarning: "BGB § 286(3) sentence 1, second half-sentence",
    interestConsumer: "BGB § 288(1)",
    interestBusiness: "BGB § 288(2)",
    baseRate: "BGB § 247",
    noInterestOnInterest: "BGB § 289 sentence 1",
    flatFee: "BGB § 288(5)",
    flatFeeNotConsumer: "BGB § 288(5) sentence 1 (debtor is not a consumer)",
    allocation: "BGB § 367(1)",
  },
};

/**
 * Basiszinssatz per BGB 247, published by Deutsche Bundesbank.
 * Production table: only verified rows. Test fixtures live in the test files only.
 */
export const DE_BASE_RATES: readonly BaseRateRow[] = [
  { valid_from: "2026-07-01", rateBp: 152, source: "Deutsche Bundesbank, Basiszinssatz 1.52 percent from 2026-07-01" },
];
