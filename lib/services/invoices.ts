// Create and send a real PayPal SANDBOX invoice for a debtor, and persist invoice, dunning case
// (state open) and audit rows.
//
// Order and failure handling (no orphan, no duplicate):
// 1. A pending invoice row is written first, keyed by request_key = hash(workspace, debtor, nonce).
//    The same nonce always maps to the same row, the same PayPal-Request-Ids and the same invoice
//    number, so a retry (or a double click) can never create a second invoice.
// 2. PayPal create (idempotent by PayPal-Request-Id; a duplicate invoice number is recovered by a
//    search), then the PayPal id is stored, then send (skipped if PayPal already shows it sent).
// 3. finalizeInvoice creates the case and the audit row atomically and idempotently.
// A definitive PayPal failure (4xx) deletes the pending row. An ambiguous failure (network, 5xx,
// 429) keeps it, so retrying with the same nonce resumes exactly where it stopped.

import { addDays, diffDays, isValidIsoDate } from "../rules/dates";
import { centsToMoney } from "../paypal/money";
import { ServiceError } from "./errors";
import {
  assertSandbox,
  keyToRequestId,
  limitsOf,
  loadMutableWorkspace,
  realToday,
  stableKey,
  virtualDateFor,
  type ServiceDeps,
} from "./context";
import { isDefinitivePayPalFailure, payPalIssue, safeMessage } from "./paypalErrors";
import type { CreditorRow, DebtorRow, FullCaseRow, FullInvoiceRow } from "./store";

export interface CreateInvoiceInput {
  workspaceId: string;
  debtorId: string;
  amountCents: number;
  /** Virtual due date (ISO). Must not be before the virtual issue date. */
  dueDate: string;
  /** BGB 286(2) no. 1: due date fixed by the calendar. Default false. */
  fixedCalendarDue?: boolean;
  /** BGB 286(3): the invoice warns a consumer about default after 30 days. Default true. */
  defaultWarningPrinted?: boolean;
  description?: string;
  /** Client generated nonce (one per create attempt in the UI); retries reuse it. */
  nonce: string;
}

export interface CreateInvoiceResult {
  invoice: FullInvoiceRow;
  case: FullCaseRow;
  /** True when this call found the invoice already created by an earlier call with the same nonce. */
  replayed: boolean;
}

const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const DEFAULT_WARNING_TEXT = {
  de: "Hinweis: Sie geraten spaetestens 30 Tage nach Faelligkeit und Zugang dieser Rechnung in Verzug (BGB 286 Abs. 3).",
  en: "Notice: you will be in default no later than 30 days after the due date and receipt of this invoice (German Civil Code, BGB 286(3)).",
} as const;

export function invoiceNumberFor(key: string): string {
  return `MW-${key.slice(0, 12).toUpperCase()}`;
}

function splitName(full: string): { given_name: string; surname: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { given_name: parts[0], surname: parts[0] };
  return { given_name: parts.slice(0, -1).join(" "), surname: parts[parts.length - 1] };
}

/** PayPal sees real dates: same term length as in the demo, starting today (real). */
export function paypalDates(virtualIssue: string, virtualDue: string, nowMs: number) {
  const invoiceDate = realToday(nowMs);
  return { invoiceDate, dueDate: addDays(invoiceDate, diffDays(virtualIssue, virtualDue)) };
}

export function buildInvoiceBody(args: {
  number: string;
  creditor: CreditorRow | null;
  debtor: DebtorRow;
  amountCents: number;
  description: string;
  defaultWarningPrinted: boolean;
  paypalInvoiceDate: string;
  paypalDueDate: string;
}): Record<string, unknown> {
  const { debtor } = args;
  const notes: string[] = [];
  if (args.creditor?.kleinunternehmer) {
    notes.push(debtor.lang === "de" ? "Gemaess 19 UStG wird keine Umsatzsteuer berechnet." : "No VAT is charged under the small business scheme (UStG 19).");
  }
  if (args.defaultWarningPrinted) notes.push(DEFAULT_WARNING_TEXT[debtor.lang]);
  notes.push("Mahnwerk demo (PayPal sandbox).");
  return {
    detail: {
      invoice_number: args.number,
      invoice_date: args.paypalInvoiceDate,
      currency_code: "EUR",
      note: notes.join(" "),
      payment_term: { due_date: args.paypalDueDate },
    },
    ...(args.creditor ? { invoicer: { business_name: args.creditor.name } } : {}),
    primary_recipients: [
      {
        billing_info: {
          ...(debtor.type === "business" ? { business_name: debtor.name } : { name: splitName(debtor.name) }),
          email_address: debtor.email,
        },
      },
    ],
    items: [
      {
        name: args.description,
        quantity: "1",
        unit_amount: centsToMoney(args.amountCents, "EUR"),
        unit_of_measure: "AMOUNT",
      },
    ],
    configuration: { allow_tip: false, partial_payment: { allow_partial_payment: true } },
  };
}

function validate(deps: ServiceDeps, input: CreateInvoiceInput, issueDate: string): void {
  const max = limitsOf(deps).maxInvoiceCents;
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > max) {
    throw new ServiceError("invalid_input", `amountCents must be an integer between 1 and ${max}`);
  }
  if (!isValidIsoDate(input.dueDate)) throw new ServiceError("invalid_input", "dueDate must be YYYY-MM-DD");
  if (diffDays(issueDate, input.dueDate) < 0) throw new ServiceError("invalid_input", "dueDate must not be before the issue date");
  if (diffDays(issueDate, input.dueDate) > 365) throw new ServiceError("invalid_input", "dueDate must be within 365 days");
  if (!NONCE_RE.test(input.nonce)) throw new ServiceError("invalid_input", "nonce must be 8 to 64 characters [A-Za-z0-9_-]");
}

function sameRequest(row: FullInvoiceRow, input: CreateInvoiceInput): boolean {
  return row.debtor_id === input.debtorId && row.principal_cents === input.amountCents && row.due_date === input.dueDate;
}

export async function createAndSendInvoice(deps: ServiceDeps, actorUid: string, input: CreateInvoiceInput): Promise<CreateInvoiceResult> {
  assertSandbox(deps);
  const ws = await loadMutableWorkspace(deps, input.workspaceId, actorUid);
  const nowMs = deps.now();
  const issueDate = virtualDateFor(ws, nowMs);
  validate(deps, input, issueDate);

  const debtor = await deps.store.getDebtor(input.debtorId);
  if (!debtor || debtor.workspace_id !== ws.id) throw new ServiceError("not_found", "Debtor not found in this workspace");
  if (!debtor.email) throw new ServiceError("invalid_input", "Debtor has no email address");
  const creditor = await deps.store.getCreditorForWorkspace(ws.id);

  const key = stableKey("invoice", ws.id, debtor.id, input.nonce);
  let row = await deps.store.findInvoiceByRequestKey(key);
  if (row) {
    if (!sameRequest(row, input)) throw new ServiceError("conflict", "This nonce was already used for a different invoice");
    const existingCase = await deps.store.getCaseForInvoice(row.id);
    if (existingCase) return { invoice: row, case: existingCase, replayed: true };
    // Pending row from an earlier attempt: resume below.
  } else {
    const ins = await deps.store.insertPendingInvoice({
      workspace_id: ws.id,
      creditor_id: creditor?.id ?? null,
      debtor_id: debtor.id,
      number: invoiceNumberFor(key),
      currency: "EUR",
      issue_date: issueDate,
      due_date: input.dueDate,
      fixed_calendar_due: input.fixedCalendarDue ?? false,
      default_warning_printed: input.defaultWarningPrinted ?? true,
      // Sent by PayPal on the issue date; used as the receipt date for BGB 286(3).
      received_on: issueDate,
      principal_cents: input.amountCents,
      request_key: key,
    });
    row = ins.invoice;
    if (!ins.inserted) {
      const c = await deps.store.getCaseForInvoice(row.id);
      if (c) return { invoice: row, case: c, replayed: true };
      throw new ServiceError("in_progress", "This invoice is being created right now", { invoiceId: row.id });
    }
  }

  return resumeInvoice(deps, actorUid, row, { creditor, debtor, description: input.description, issueDate });
}

async function resumeInvoice(
  deps: ServiceDeps,
  actorUid: string,
  row: FullInvoiceRow,
  ctx: { creditor: CreditorRow | null; debtor: DebtorRow; description?: string; issueDate: string },
): Promise<CreateInvoiceResult> {
  const key = row.request_key as string;
  const number = row.number as string;
  const dates = paypalDates(row.issue_date, row.due_date, deps.now());
  let stage: "create" | "link" | "send" | "finalize" = "create";
  try {
    let paypalId = row.paypal_invoice_id;
    if (!paypalId) {
      paypalId = await createAtPayPal(deps, key, number, () =>
        buildInvoiceBody({
          number,
          creditor: ctx.creditor,
          debtor: ctx.debtor,
          amountCents: row.principal_cents,
          description: (ctx.description ?? "").trim().slice(0, 200) || "Services",
          defaultWarningPrinted: row.default_warning_printed,
          paypalInvoiceDate: dates.invoiceDate,
          paypalDueDate: dates.dueDate,
        }),
      );
      stage = "link";
      if (!(await deps.store.setInvoicePayPalId(row.id, paypalId))) {
        throw new ServiceError("conflict", "Invoice is already linked to another PayPal invoice");
      }
    }

    stage = "send";
    const remote = await deps.paypal.getInvoice(paypalId);
    if (remote.status === "DRAFT") {
      await deps.paypal.sendInvoice(paypalId, { send_to_recipient: true, send_to_invoicer: false }, { requestId: keyToRequestId("mw-is", key) });
    }

    stage = "finalize";
    const caseId = await deps.store.finalizeInvoice({
      invoiceId: row.id,
      paypalInvoiceId: paypalId,
      actorUid,
      virtualDate: ctx.issueDate,
      details: {
        actor_uid: actorUid,
        paypal_invoice_id: paypalId,
        number,
        amount_cents: row.principal_cents,
        due_date: row.due_date,
        paypal_invoice_date: dates.invoiceDate,
        paypal_due_date: dates.dueDate,
        fixed_calendar_due: row.fixed_calendar_due,
        default_warning_printed: row.default_warning_printed,
      },
    });
    const invoice = (await deps.store.getFullInvoice(row.id)) as FullInvoiceRow;
    const c = (await deps.store.getCase(caseId)) as FullCaseRow;
    return { invoice, case: c, replayed: false };
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    const definitive = (stage === "create" || stage === "send") && isDefinitivePayPalFailure(err);
    let removed = false;
    if (definitive) removed = await deps.store.deletePendingInvoice(row.id).catch(() => false);
    await deps.store
      .insertAudit({
        workspace_id: row.workspace_id,
        case_id: null,
        invoice_id: removed ? null : row.id,
        actor: "system",
        action: removed ? "invoice.create_failed" : "invoice.create_pending",
        virtual_date: ctx.issueDate,
        details: { stage, error: safeMessage(err), issue: payPalIssue(err) ?? null, actor_uid: actorUid, retryable: !removed },
      })
      .catch(() => undefined);
    throw new ServiceError(
      "paypal_failed",
      removed ? "PayPal rejected the invoice; nothing was stored" : "The invoice could not be completed; retry with the same nonce to resume",
      { stage, retryable: !removed, ...(removed ? {} : { invoiceId: row.id }) },
    );
  }
}

/** Creates the PayPal draft. A duplicate invoice number means an earlier attempt created it: find it. */
async function createAtPayPal(deps: ServiceDeps, key: string, number: string, body: () => Record<string, unknown>): Promise<string> {
  try {
    const created = await deps.paypal.createInvoice(body(), { requestId: keyToRequestId("mw-ic", key) });
    return created.id;
  } catch (err) {
    if (payPalIssue(err) !== "DUPLICATE_INVOICE_NUMBER") throw err;
    const found = await deps.paypal.searchInvoices({ invoice_number: number }, { page: 1, pageSize: 2 }, { requestId: keyToRequestId("mw-iq", key) });
    const hits = found.items.filter((i) => i.detail?.invoice_number === number);
    if (hits.length !== 1) throw err;
    return hits[0].id;
  }
}
