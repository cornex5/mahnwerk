// Legal note keys for a dunning letter. The letter renderer maps keys to text.
// Not legal advice.

import type { DebtorType } from "./types";

export type LegalNoteKey =
  | "kleinunternehmer_no_vat"
  | "consumer_default_warning_required"
  | "flat_fee_business_only"
  | "not_legal_advice";

export interface LegalNoteContext {
  /** Creditor uses the small business scheme (para 19 UStG): no VAT shown on invoices. */
  creditorIsSmallBusiness: boolean;
  debtorType: DebtorType;
}

export const LEGAL_NOTES: Record<LegalNoteKey, { text: string; citation: string }> = {
  kleinunternehmer_no_vat: {
    text: "No VAT is charged under the small business scheme (Kleinunternehmerregelung).",
    citation: "UStG § 19",
  },
  consumer_default_warning_required: {
    text: "A consumer only falls into default 30 days after due date and receipt if the invoice expressly warned about this consequence; otherwise a reminder (Mahnung) is needed.",
    citation: "BGB § 286(3) sentence 1",
  },
  flat_fee_business_only: {
    text: "The 40 EUR flat fee for late payment applies only when the debtor is not a consumer.",
    citation: "BGB § 288(5)",
  },
  not_legal_advice: {
    text: "Automatically calculated. This is not legal advice.",
    citation: "",
  },
};

export function legalNoteKeys(ctx: LegalNoteContext): LegalNoteKey[] {
  const keys: LegalNoteKey[] = [];
  if (ctx.creditorIsSmallBusiness) keys.push("kleinunternehmer_no_vat");
  if (ctx.debtorType === "consumer") keys.push("consumer_default_warning_required");
  if (ctx.debtorType === "business") keys.push("flat_fee_business_only");
  keys.push("not_legal_advice");
  return keys;
}
