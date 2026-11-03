// Client-side display of the claim: the deterministic rules engine runs on the stored invoice
// facts and ledger at the workspace's virtual date. AI is never involved in these numbers.

import { DE_BASE_RATES, DE_RULESET } from "@/lib/rules/de";
import { addDays, diffDays } from "@/lib/rules/dates";
import { calculateClaim } from "@/lib/rules/engine";
import type { CalcResult } from "@/lib/rules/types";
import { isClosedState } from "./format";
import type {
  AuditRow,
  CaseRow,
  DebtorRow,
  InvoiceRow,
  LedgerRow,
  StepRow,
  WorkspaceData,
  WorkspaceRow,
} from "./types";

/** Fixed virtual date of the golden workspace (same constant as lib/services/context.ts). */
export const GOLDEN_VIRTUAL_DATE = "2026-11-20";

export function virtualDateOf(ws: Pick<WorkspaceRow, "kind" | "clock_offset_days">): string {
  if (ws.kind === "golden") return GOLDEN_VIRTUAL_DATE;
  return addDays(new Date().toISOString().slice(0, 10), ws.clock_offset_days);
}

const PAYMENT_REQUEST_ACTIONS = new Set(["case.reminder_sent", "case.mahnung1_sent", "case.mahnung2_sent"]);

/** Virtual date of the first sent reminder or Mahnung (BGB 286(1)), as the server derives it. */
export function firstPaymentRequestOn(audit: AuditRow[], invoiceId: string): string | null {
  const dates = audit
    .filter((a) => a.invoice_id === invoiceId && PAYMENT_REQUEST_ACTIONS.has(a.action) && a.virtual_date)
    .map((a) => a.virtual_date as string)
    .sort();
  return dates[0] ?? null;
}

export function computeClaim(
  inv: InvoiceRow,
  debtorType: "consumer" | "business",
  ledger: LedgerRow[],
  firstRequest: string | null,
  calcDate: string,
): CalcResult | null {
  try {
    return calculateClaim({
      invoice: {
        principalCents: inv.principal_cents,
        dueDate: inv.due_date,
        fixedCalendarDue: inv.fixed_calendar_due,
        defaultWarningPrinted: inv.default_warning_printed,
        ...(inv.received_on ? { receivedOn: inv.received_on } : {}),
        ...(firstRequest ? { firstPaymentRequestSentOn: firstRequest } : {}),
        debtorType,
      },
      ledger: ledger.filter((l) => l.invoice_id === inv.id).map((l) => ({ date: l.booked_on, kind: l.kind, amountCents: l.amount_cents })),
      calcDate,
      ruleSet: DE_RULESET,
      baseRates: DE_BASE_RATES,
    });
  } catch {
    return null;
  }
}

export interface CaseView {
  c: CaseRow;
  invoice: InvoiceRow;
  debtor: DebtorRow | null;
  claim: CalcResult | null;
  /** What the debtor owes at the virtual date (0 for refunded or cancelled cases). */
  owedCents: number;
  daysOverdue: number;
  steps: StepRow[];
  pendingStep: StepRow | null;
}

export function buildViews(data: WorkspaceData, virtualDate: string): CaseView[] {
  const invById = new Map(data.invoices.map((i) => [i.id, i]));
  const debtorById = new Map(data.debtors.map((d) => [d.id, d]));
  const views: CaseView[] = [];
  for (const c of data.cases) {
    const invoice = invById.get(c.invoice_id);
    if (!invoice) continue;
    const debtor = debtorById.get(invoice.debtor_id) ?? null;
    const claim = debtor ? computeClaim(invoice, debtor.type, data.ledger, firstPaymentRequestOn(data.audit, invoice.id), virtualDate) : null;
    const dead = c.state === "closed_refunded" || c.state === "closed_cancelled";
    const owedCents = dead ? 0 : claim ? claim.totalDueCents : invoice.principal_cents;
    const overdue = diffDays(invoice.due_date, virtualDate);
    const steps = data.steps.filter((s) => s.case_id === c.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
    views.push({
      c,
      invoice,
      debtor,
      claim,
      owedCents,
      daysOverdue: isClosedState(c.state) ? 0 : Math.max(0, overdue),
      steps,
      pendingStep: steps.find((s) => s.status === "proposed") ?? null,
    });
  }
  return views;
}

export interface Totals {
  openCents: number;
  openCount: number;
  overdueCents: number;
  overdueCount: number;
  dunningCents: number;
  dunningCount: number;
  collectedCents: number;
}

const DUNNING_STATES = new Set(["reminded", "mahnung1", "mahnung2", "handover_ready", "paused_dispute"]);

export function totalsOf(views: CaseView[], ledger: LedgerRow[]): Totals {
  const t: Totals = { openCents: 0, openCount: 0, overdueCents: 0, overdueCount: 0, dunningCents: 0, dunningCount: 0, collectedCents: 0 };
  for (const v of views) {
    if (isClosedState(v.c.state)) continue;
    t.openCents += v.owedCents;
    t.openCount += 1;
    if (v.daysOverdue > 0) {
      t.overdueCents += v.owedCents;
      t.overdueCount += 1;
    }
    if (DUNNING_STATES.has(v.c.state)) {
      t.dunningCents += v.owedCents;
      t.dunningCount += 1;
    }
  }
  for (const l of ledger) t.collectedCents += l.kind === "payment" ? l.amount_cents : -l.amount_cents;
  t.collectedCents = Math.max(0, t.collectedCents);
  return t;
}
