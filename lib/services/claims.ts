// Rules engine glue: claim at a virtual date from stored facts and ledger, and the next dunning
// stage per case state (waiting days from lib/rules/de.ts via earliestStageDate).

import { addDays, diffDays } from "../rules/dates";
import { DE_BASE_RATES, DE_RULESET } from "../rules/de";
import { calculateClaim, earliestStageDate } from "../rules/engine";
import type { CalcResult, RuleSet } from "../rules/types";
import type { CaseEvent, CaseState } from "../cases/stateMachine";
import type { ClaimFacts, LedgerRow } from "../cases/store";
import type { FullInvoiceRow } from "./store";

export type DunningKind = "reminder" | "mahnung1" | "mahnung2" | "handover";

export const STEP_SPECS: Record<DunningKind, { from: CaseState; to: CaseState; event: CaseEvent["type"] }> = {
  reminder: { from: "overdue", to: "reminded", event: "reminder_sent" },
  mahnung1: { from: "reminded", to: "mahnung1", event: "mahnung1_sent" },
  mahnung2: { from: "mahnung1", to: "mahnung2", event: "mahnung2_sent" },
  handover: { from: "mahnung2", to: "handover_ready", event: "handover_prepared" },
};

export function isDunningKind(k: string): k is DunningKind {
  return k in STEP_SPECS;
}

export interface StagePlan {
  kind: DunningKind | null;
  /** Case should first move open -> overdue (system transition, no approval needed). */
  becomesOverdue: boolean;
  /** Earliest virtual date the stage may be sent (or the date the case becomes overdue). */
  earliestDate: string | null;
  dueNow: boolean;
  /** Set when a human hold is the reason nothing is due. */
  heldUntil?: string;
}

/**
 * Next stage for a case at a virtual date. Overdue = the day after the due date. The reminder may
 * go out on the first overdue day plus waitingDays.reminder; each later stage waits waitingDays
 * after the previous step (virtual date of its transition).
 */
export function planNextStage(args: {
  state: CaseState;
  dueDate: string;
  lastStepDate: string | null;
  virtualDate: string;
  ruleSet?: RuleSet;
  /** Case is on hold until this date (a human decision); no stage is due before it. */
  holdUntil?: string | null;
}): StagePlan {
  const rs = args.ruleSet ?? DE_RULESET;
  const firstOverdue = addDays(args.dueDate, 1);
  const at = (kind: DunningKind, prev: string, becomesOverdue = false): StagePlan => {
    const earliestDate = earliestStageDate(kind, prev, rs);
    return { kind, becomesOverdue, earliestDate, dueNow: diffDays(earliestDate, args.virtualDate) >= 0 };
  };
  const base = planBase();
  if (args.holdUntil && base.kind && diffDays(args.holdUntil, args.virtualDate) < 0) {
    return { ...base, dueNow: false, earliestDate: args.holdUntil, heldUntil: args.holdUntil };
  }
  return base;

  function planBase(): StagePlan {
  switch (args.state) {
    case "open":
      if (diffDays(firstOverdue, args.virtualDate) < 0) return { kind: null, becomesOverdue: false, earliestDate: firstOverdue, dueNow: false };
      return at("reminder", firstOverdue, true);
    case "overdue":
      return at("reminder", firstOverdue);
    case "reminded":
      return at("mahnung1", args.lastStepDate ?? firstOverdue);
    case "mahnung1":
      return at("mahnung2", args.lastStepDate ?? firstOverdue);
    case "mahnung2":
      return at("handover", args.lastStepDate ?? firstOverdue);
    default:
      return { kind: null, becomesOverdue: false, earliestDate: null, dueNow: false };
  }
  }
}

export function claimAt(inv: Pick<FullInvoiceRow, "principal_cents">, facts: ClaimFacts, ledger: LedgerRow[], calcDate: string): CalcResult {
  return calculateClaim({
    invoice: {
      principalCents: inv.principal_cents,
      dueDate: facts.due_date,
      fixedCalendarDue: facts.fixed_calendar_due,
      defaultWarningPrinted: facts.default_warning_printed,
      ...(facts.received_on ? { receivedOn: facts.received_on } : {}),
      ...(facts.first_payment_request_on ? { firstPaymentRequestSentOn: facts.first_payment_request_on } : {}),
      debtorType: facts.debtor_type,
    },
    ledger: ledger.map((l) => ({ date: l.booked_on, kind: l.kind, amountCents: l.amount_cents })),
    calcDate,
    ruleSet: DE_RULESET,
    baseRates: DE_BASE_RATES,
  });
}
