// Shared types for the Mahnwerk rules engine.
// All money values are integer cents. All dates are ISO strings YYYY-MM-DD (UTC calendar days).

export type ISODate = string;

export type DebtorType = "consumer" | "business";

export type LedgerKind = "payment" | "refund";

export type AllocationTarget = "fee" | "interest" | "principal";

export type DefaultRule = "fixed_calendar_date" | "payment_request" | "thirty_day_rule";

export type DunningStage = "reminder" | "mahnung1" | "mahnung2" | "handover";

export interface InvoiceFacts {
  /** Invoice amount (the claim), integer cents, > 0. */
  principalCents: number;
  /** Date the claim falls due. */
  dueDate: ISODate;
  /** True when the due date is fixed by the calendar (BGB 286(2) no. 1), e.g. "payable by 2026-09-30". */
  fixedCalendarDue: boolean;
  /** True when the invoice warned a consumer about the 30-day default consequence (BGB 286(3) sentence 1). */
  defaultWarningPrinted: boolean;
  /** Date the debtor received the invoice, if known. */
  receivedOn?: ISODate;
  /** First payment request sent after the due date; counts as a Mahnung under BGB 286(1). */
  firstPaymentRequestSentOn?: ISODate;
  debtorType: DebtorType;
}

export interface LedgerEntry {
  date: ISODate;
  kind: LedgerKind;
  /** Always a positive integer; the kind decides the direction. */
  amountCents: number;
}

export interface BaseRateRow {
  /** First day this base rate applies (inclusive). */
  valid_from: ISODate;
  /** Base rate in basis points, may be negative. */
  rateBp: number;
  source?: string;
}

export interface RuleSetCitations {
  fixedCalendarDate: string;
  paymentRequest: string;
  thirtyDayRule: string;
  thirtyDayRuleUncertainReceipt: string;
  consumerWarning: string;
  interestConsumer: string;
  interestBusiness: string;
  baseRate: string;
  noInterestOnInterest: string;
  flatFee: string;
  flatFeeNotConsumer: string;
  allocation: string;
}

export interface RuleSet {
  jurisdiction: string;
  /** Margin over the base rate, in basis points. */
  marginBp: Record<DebtorType, number>;
  /** Flat fee per claim once in default. Must be 0 for consumers. */
  flatFeeCents: Record<DebtorType, number>;
  /** Day count divisor (365-day year). */
  dayCountBasis: number;
  /** Days after the later of due date and receipt for the statutory default (BGB 286(3)). */
  thirtyDayRuleDays: number;
  /** Minimum waiting days before each dunning stage may be sent, counted from the previous step. */
  waitingDays: Record<DunningStage, number>;
  /** Order in which a payment is allocated (BGB 367(1): costs, interest, principal). */
  allocationOrder: readonly AllocationTarget[];
  citations: RuleSetCitations;
}

export interface CalcInput {
  invoice: InvoiceFacts;
  ledger: readonly LedgerEntry[];
  calcDate: ISODate;
  ruleSet: RuleSet;
  baseRates: readonly BaseRateRow[];
}

export interface Segment {
  /** Inclusive. */
  from: ISODate;
  /** Exclusive. */
  to: ISODate;
  days: number;
  principalCents: number;
  /** Total rate (base + margin) in basis points. */
  rateBp: number;
  /** Unrounded interest for this segment, decimal string. */
  interestExact: string;
}

export interface AllocationRow {
  date: ISODate;
  kind: LedgerKind;
  /** Positive for payments, negative for refunds. */
  amountCents: number;
  toFee: number;
  toInterest: number;
  toPrincipal: number;
  /** Overpayment kept as credit (negative when a refund consumes credit). */
  unappliedCents: number;
}

export interface CalcResult {
  inDefault: boolean;
  /** Legal default start date (may be after calcDate, then inDefault is false). Null if no rule applies yet. */
  defaultStart: ISODate | null;
  defaultRule: DefaultRule | null;
  citation: string[];
  segments: Segment[];
  interestAccruedCents: number;
  interestPaidCents: number;
  flatFeeCents: number;
  openPrincipalCents: number;
  openInterestCents: number;
  openFeeCents: number;
  totalDueCents: number;
  /** Overpaid money held as credit for the debtor (not netted against totalDue). */
  creditCents: number;
  allocation: AllocationRow[];
}
