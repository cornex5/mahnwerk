// Letter preview that mirrors what the server will send (lib/services/letters.ts is pure and
// shared): a validated AI draft when the step carries one, otherwise the deterministic template.

import { DE_RULESET } from "@/lib/rules/de";
import { diffDays } from "@/lib/rules/dates";
import { letterFor, templateLetter, type Letter, type LetterFacts, type LetterKind } from "@/lib/services/letters";
import { draftBasisMatches } from "@/lib/services/draftBasis";
import type { CaseView } from "./claim";
import { fmtDate, STEP_LABEL } from "./format";
import type { CreditorRow, StepRow } from "./types";

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function isLetter(v: unknown): v is Letter {
  return !!v && typeof v === "object" && typeof (v as Letter).subject === "string" && typeof (v as Letter).body === "string";
}

/**
 * True when a stored AI draft was written for other amounts or another date than the case has now. The
 * server then sends the template instead (lib/services/steps.ts), so the card shows the template too.
 */
export function draftIsStale(step: StepRow, view: CaseView | undefined, virtualDate: string): boolean {
  if (step.status === "sent" || step.kind === "fee_invoice" || step.kind === "close") return false;
  if (!step.draft || !view?.claim) return false;
  const c = view.claim;
  return !draftBasisMatches(step.draft, {
    virtual_date: virtualDate,
    principal_cents: c.openPrincipalCents,
    interest_cents: c.openInterestCents,
    fee_cents: c.openFeeCents,
    total_cents: c.totalDueCents,
  });
}

export function letterForStep(step: StepRow, view: CaseView | undefined, creditor: CreditorRow | null, virtualDate: string): Letter | null {
  if (step.kind === "close") return null;
  const sent = step.draft?.letter;
  if (isLetter(sent)) return sent;
  const stale = draftIsStale(step, view, virtualDate);
  if (!view || !view.debtor) return null;
  const kind = step.kind as LetterKind;
  const f = step.facts as Record<string, unknown>;
  let open = { p: 0, i: 0, f: 0, t: 0 };
  if (kind === "fee_invoice") {
    const interest = num(f.interestCents) || num(f.openInterestCents);
    const fee = num(f.feeCents) || num(f.openFeeCents);
    open = { p: 0, i: interest, f: fee, t: num(f.totalCents) || interest + fee };
  } else if (view.claim) {
    open = { p: view.claim.openPrincipalCents, i: view.claim.openInterestCents, f: view.claim.openFeeCents, t: view.claim.totalDueCents };
  }
  const facts: LetterFacts = {
    kind,
    lang: view.debtor.lang,
    creditorName: creditor?.name ?? "Creditor",
    debtorName: view.debtor.name,
    invoiceNumber: view.invoice.number ?? view.invoice.id,
    virtualDate,
    dueDate: view.invoice.due_date,
    openPrincipalCents: open.p,
    openInterestCents: open.i,
    openFeeCents: open.f,
    totalDueCents: open.t,
    payLink: view.invoice.paypal_invoice_id ? `https://www.sandbox.paypal.com/invoice/p/#${encodeURIComponent(view.invoice.paypal_invoice_id)}` : undefined,
  };
  return letterFor(facts, stale ? null : step.draft, stale ? null : step.validation) ?? templateLetter(facts);
}

/** Deterministic "why now" lines from the rules engine facts (no AI). */
export function whyNowLines(step: StepRow, view: CaseView | undefined, virtualDate: string): string[] {
  if (!view) return [];
  const out: string[] = [];
  const inv = view.invoice;
  const late = diffDays(inv.due_date, virtualDate);
  out.push(`Invoice ${inv.number ?? ""} was due on ${fmtDate(inv.due_date)}${late > 0 ? `, ${late} day${late === 1 ? "" : "s"} ago` : ""}.`);
  const cl = view.claim;
  if (cl?.defaultStart) {
    const cite = cl.citation.length ? ` (${cl.citation.join(", ")})` : "";
    out.push(
      cl.defaultStart > virtualDate
        ? `Legal default will start on ${fmtDate(cl.defaultStart)}${cite}. Until then no default interest or flat fee accrues.`
        : `Legal default started on ${fmtDate(cl.defaultStart)}${cite}.`,
    );
  } else if (cl) {
    out.push("The debtor is not in legal default yet, so no default interest or flat fee accrues.");
  }
  if (step.kind !== "fee_invoice" && step.kind !== "close") {
    const wait = DE_RULESET.waitingDays[step.kind];
    const earliest = typeof step.facts.earliestDate === "string" ? (step.facts.earliestDate as string) : null;
    out.push(
      earliest
        ? `Product policy waits ${wait} day${wait === 1 ? "" : "s"} after the previous step. The earliest date for this step was ${fmtDate(earliest)}, so it is due now.`
        : `Product policy waits ${wait} day${wait === 1 ? "" : "s"} after the previous step.`,
    );
  } else if (step.kind === "fee_invoice") {
    out.push("The principal is paid, but default interest or the flat fee is still owed.");
  }
  out.push(`Proposed action: ${STEP_LABEL[step.kind]}. It goes out only after you approve it.`);
  return out;
}
