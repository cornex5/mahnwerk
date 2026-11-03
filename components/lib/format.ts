// Display helpers. Money is integer cents everywhere; dates are ISO calendar days.

import type { CaseState, StepKind, StepStatus } from "./types";

const EUR = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });

export function eur(cents: number): string {
  return EUR.format(cents / 100);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "none";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

export function fmtTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function pct(bp: number): string {
  return `${(bp / 100).toFixed(2)}%`;
}

/** Parses "1234.56", "1.234,56" or "1,234.56" into cents; null when invalid or not positive. */
export function parseEuroToCents(input: string): number | null {
  let s = input.trim().replace(/\s|€|EUR/gi, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma > -1) {
    s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export const STATE_LABEL: Record<CaseState, string> = {
  open: "Open",
  overdue: "Overdue",
  reminded: "Reminded",
  mahnung1: "1st Mahnung",
  mahnung2: "2nd Mahnung",
  handover_ready: "Ready for handover",
  paused_dispute: "Paused: dispute",
  closed_paid: "Paid",
  closed_refunded: "Refunded",
  closed_cancelled: "Cancelled",
};

export const STATE_RANK: Record<CaseState, number> = {
  handover_ready: 0,
  mahnung2: 1,
  mahnung1: 2,
  reminded: 3,
  overdue: 4,
  paused_dispute: 5,
  open: 6,
  closed_paid: 7,
  closed_refunded: 8,
  closed_cancelled: 9,
};

export const isClosedState = (s: CaseState) => s.startsWith("closed_");

export const STEP_LABEL: Record<StepKind, string> = {
  reminder: "Payment reminder",
  mahnung1: "1st Mahnung",
  mahnung2: "2nd Mahnung",
  handover: "Final notice before handover",
  fee_invoice: "Fee invoice (interest and flat fee)",
  close: "Close case",
};

export const STEP_ORDER: StepKind[] = ["reminder", "mahnung1", "mahnung2", "handover", "fee_invoice", "close"];

export const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  proposed: "Awaiting approval",
  approved: "Approved, not sent yet",
  sent: "Sent",
  rejected: "Rejected",
  failed: "Failed",
};

export const SENT_VIA_LABEL: Record<string, string> = {
  paypal_remind: "PayPal sandbox reminder",
  paypal_invoice: "PayPal sandbox invoice",
  email: "Email",
  none: "In-app letter (no email in the demo)",
};

export function humanizeAction(action: string): string {
  const map: Record<string, string> = {
    "invoice.sent": "Invoice created and sent",
    "workspace.created": "Workspace created",
    "clock.advanced": "Demo clock advanced",
    "case.became_overdue": "Became overdue",
    "case.reminder_sent": "Reminder sent",
    "case.mahnung1_sent": "1st Mahnung sent",
    "case.mahnung2_sent": "2nd Mahnung sent",
    "case.handover_prepared": "Handover prepared",
    "case.dispute_opened": "Dispute opened, dunning paused",
    "case.dispute_resolved": "Dispute resolved, dunning resumes",
    "case.paid_in_full": "Paid in full, case closed",
    "case.refunded_in_full": "Refunded in full, case closed",
    "case.cancelled": "Case cancelled",
    "case.reopened": "Case reopened",
    "step.proposed": "Step proposed by the rules engine",
    "step.approved": "Step approved by you",
    "step.rejected": "Step rejected by you",
    "step.sent": "Step executed",
    "step.failed": "Step failed",
    "step.fee_invoice_proposed": "Fee invoice proposed",
    "simulator.pay_full": "Simulated: customer paid in full",
    "simulator.pay_partial": "Simulated: customer paid partially",
    "simulator.refund": "Simulated: refund",
    "simulator.dispute_open": "Simulated: customer opened a dispute",
    "simulator.dispute_resolve": "Simulated: dispute resolved",
    "ledger.payment_recorded": "Payment recorded",
    "reply.classified": "Debtor reply classified by AI (label only)",
  };
  return map[action] ?? action.replace(/[._]/g, " ");
}
