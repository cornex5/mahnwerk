// Deterministic fallback letters per kind and language. Same placeholder contract as the model, and
// they must pass the same validator (a test checks every combination).
//
// Legal basis used (German law, statutory defaults; not legal advice):
// - Default (Verzug): BGB 286. A Mahnung after the due date puts the debtor in default on receipt,
//   BGB 286(1). The engine decides whether the debtor is already in default (CalcResult.inDefault).
// - Default interest: BGB 288(1) (consumer involved), BGB 288(2) (no consumer involved).
// - 40 EUR flat fee: BGB 288(5), only when the debtor is not a consumer; it is credited against
//   later legal costs, BGB 288(5) sentence 3. The amount always comes from {{FEE}}.
// - Costs of legal pursuit as damages for default: BGB 280(1),(2), 286 (handover notice only).

import type { Lang, LetterFacts } from "./letterFacts";
import type { LetterDraft } from "./validate";

interface Phrases {
  greetingConsumer: string;
  greetingBusiness: string;
  closing: string;
  alreadyPaid: string;
  contactConsumer: string;
  contactBusiness: string;
  inDefault: string;
  defaultByThisDemand: string;
  furtherInterest: string;
  outstandingIntro: string;
  principal: string;
  interest: (consumer: boolean) => string;
  fee: string;
  total: string;
  singleAmount: string;
  payBy: string;
  reminder: { subject: string; opening: string; payBy: string };
  mahnung1: { subject: string; opening: string };
  mahnung2: { subject: string; opening: string };
  handover: { subject: string; opening: string; consequence: string; costs: string; feeCredited: string };
}

const DE: Phrases = {
  greetingConsumer: "Guten Tag {{DEBTOR}},",
  greetingBusiness: "Sehr geehrte Damen und Herren,",
  closing: "Mit freundlichen Grüßen\n{{CREDITOR}}",
  alreadyPaid: "Sollten Sie die Zahlung bereits veranlasst haben, betrachten Sie dieses Schreiben bitte als gegenstandslos.",
  contactConsumer: "Wenn Ihnen die Zahlung gerade Schwierigkeiten bereitet, melden Sie sich bitte bei uns, damit wir gemeinsam eine Lösung finden.",
  contactBusiness: "Bei Rückfragen zur Rechnung stehen wir Ihnen gern zur Verfügung.",
  inDefault: "Sie befinden sich mit der Zahlung in Verzug (§ 286 BGB).",
  defaultByThisDemand: "Mit diesem Schreiben fordern wir Sie zur Zahlung auf. Mit Zugang dieser Mahnung befinden Sie sich in Verzug (§ 286 Abs. 1 BGB).",
  furtherInterest: "Bis zum Zahlungseingang fallen weitere gesetzliche Verzugszinsen an.",
  outstandingIntro: "Offen sind derzeit",
  principal: "Hauptforderung {{PRINCIPAL}}",
  interest: (consumer) => `Verzugszinsen bis heute {{INTEREST}} (§ 288 Abs. ${consumer ? "1" : "2"} BGB)`,
  fee: "Verzugspauschale {{FEE}} (§ 288 Abs. 5 BGB)",
  total: "insgesamt {{TOTAL}}",
  singleAmount: "Der offene Betrag beträgt {{TOTAL}}.",
  payBy: "Bitte zahlen Sie den Gesamtbetrag von {{TOTAL}} bis spätestens {{DEADLINE}} über diesen Link: {{PAY_LINK}}",
  reminder: {
    subject: "Zahlungserinnerung zur Rechnung {{INVOICE_NUMBER}}",
    opening: "sicher ist es im Alltag untergegangen: Für unsere Rechnung {{INVOICE_NUMBER}} konnten wir bisher keinen vollständigen Zahlungseingang feststellen.",
    payBy: "Bitte begleichen Sie den Betrag von {{TOTAL}} bis zum {{DEADLINE}} bequem über diesen Link: {{PAY_LINK}}",
  },
  mahnung1: {
    subject: "Mahnung zur Rechnung {{INVOICE_NUMBER}}",
    opening: "unsere Rechnung {{INVOICE_NUMBER}} ist fällig, ein vollständiger Zahlungseingang liegt uns bis heute nicht vor.",
  },
  mahnung2: {
    subject: "Zweite Mahnung zur Rechnung {{INVOICE_NUMBER}}",
    opening: "trotz unserer Mahnung ist die Rechnung {{INVOICE_NUMBER}} weiterhin nicht vollständig bezahlt.",
  },
  handover: {
    subject: "Letzte Mahnung vor Abgabe der Forderung, Rechnung {{INVOICE_NUMBER}}",
    opening: "trotz mehrfacher Mahnung ist die Rechnung {{INVOICE_NUMBER}} weiterhin offen.",
    consequence:
      "Geht bis zu diesem Datum keine Zahlung ein, werden wir die Forderung an ein Inkassounternehmen oder eine Rechtsanwaltskanzlei übergeben oder das gerichtliche Mahnverfahren einleiten.",
    costs: "Die dadurch entstehenden Kosten können wir als Verzugsschaden geltend machen (§§ 280 Abs. 2, 286 BGB)",
    feeCredited: "; die Verzugspauschale wird darauf angerechnet (§ 288 Abs. 5 Satz 3 BGB)",
  },
};

const EN: Phrases = {
  greetingConsumer: "Dear {{DEBTOR}},",
  greetingBusiness: "Dear Sir or Madam,",
  closing: "Kind regards,\n{{CREDITOR}}",
  alreadyPaid: "If you have already arranged payment, please disregard this letter.",
  contactConsumer: "If paying is difficult for you at the moment, please get in touch with us so that we can find a solution together.",
  contactBusiness: "If you have any questions about the invoice, please contact us.",
  inDefault: "You are in default of payment (§ 286 BGB).",
  defaultByThisDemand: "This letter is a formal demand for payment. On receipt of this demand you are in default (§ 286(1) BGB).",
  furtherInterest: "Further statutory default interest accrues until payment is received.",
  outstandingIntro: "Currently outstanding",
  principal: "principal {{PRINCIPAL}}",
  interest: (consumer) => `default interest to date {{INTEREST}} (§ 288(${consumer ? "1" : "2"}) BGB)`,
  fee: "flat fee for late payment {{FEE}} (§ 288(5) BGB)",
  total: "in total {{TOTAL}}",
  singleAmount: "The amount outstanding is {{TOTAL}}.",
  payBy: "Please pay the total amount of {{TOTAL}} by {{DEADLINE}} at the latest, using this link: {{PAY_LINK}}",
  reminder: {
    subject: "Payment reminder for invoice {{INVOICE_NUMBER}}",
    opening: "This may simply have been overlooked: we have not yet received full payment for our invoice {{INVOICE_NUMBER}}.",
    payBy: "Please pay the amount of {{TOTAL}} by {{DEADLINE}} using this link: {{PAY_LINK}}",
  },
  mahnung1: {
    subject: "Payment demand for invoice {{INVOICE_NUMBER}}",
    opening: "Our invoice {{INVOICE_NUMBER}} is due, and we have not yet received full payment.",
  },
  mahnung2: {
    subject: "Second payment demand for invoice {{INVOICE_NUMBER}}",
    opening: "Despite our previous demand, invoice {{INVOICE_NUMBER}} has still not been paid in full.",
  },
  handover: {
    subject: "Final demand before referral of the claim, invoice {{INVOICE_NUMBER}}",
    opening: "Despite several demands, invoice {{INVOICE_NUMBER}} is still outstanding.",
    consequence:
      "If we do not receive payment by that date, we will refer the claim to a collection agency or a law firm, or apply for a court order for payment (gerichtliches Mahnverfahren).",
    costs: "We may claim the resulting costs as damages for default (§§ 280(2), 286 BGB)",
    feeCredited: "; the flat fee for late payment will be credited against them (§ 288(5) sentence 3 BGB)",
  },
};

const PHRASES: Record<Lang, Phrases> = { de: DE, en: EN };

function breakdown(p: Phrases, f: LetterFacts): string {
  const parts = [p.principal];
  if (f.interestCents > 0) parts.push(p.interest(f.debtorType === "consumer"));
  if (f.feeCents > 0) parts.push(p.fee);
  parts.push(p.total);
  return `${p.outstandingIntro}: ${parts.join("; ")}.`;
}

function amountSentence(p: Phrases, f: LetterFacts, forceBreakdown: boolean): string {
  return forceBreakdown || f.interestCents > 0 || f.feeCents > 0 ? breakdown(p, f) : p.singleAmount;
}

function join(...xs: (string | false | null | undefined)[]): string {
  return xs.filter((x): x is string => typeof x === "string" && x.length > 0).join(" ");
}

export function templateLetter(f: LetterFacts, lang: Lang): LetterDraft {
  const p = PHRASES[lang];
  const consumer = f.debtorType === "consumer";
  const greeting = consumer ? p.greetingConsumer : p.greetingBusiness;
  const contact = consumer ? p.contactConsumer : p.contactBusiness;
  const tail = join(p.alreadyPaid, contact);
  const status = f.inDefault ? join(p.inDefault) : "";
  const further = f.inDefault ? p.furtherInterest : "";

  switch (f.kind) {
    case "reminder": {
      const amounts = f.interestCents > 0 || f.feeCents > 0 ? breakdown(p, f) : "";
      return {
        subject: p.reminder.subject,
        greeting,
        paragraphs: [join(p.reminder.opening, amounts), p.reminder.payBy, tail],
        closing: p.closing,
      };
    }
    case "mahnung1": {
      const legal = f.inDefault ? join(p.inDefault, amountSentence(p, f, false), further) : join(p.defaultByThisDemand, amountSentence(p, f, false));
      return { subject: p.mahnung1.subject, greeting, paragraphs: [p.mahnung1.opening, legal, p.payBy, tail], closing: p.closing };
    }
    case "mahnung2": {
      return {
        subject: p.mahnung2.subject,
        greeting,
        paragraphs: [p.mahnung2.opening, join(status, amountSentence(p, f, true), further), p.payBy, tail],
        closing: p.closing,
      };
    }
    case "handover_notice": {
      const costs = f.inDefault ? `${p.handover.costs}${!consumer && f.feeCents > 0 ? p.handover.feeCredited : ""}.` : "";
      return {
        subject: p.handover.subject,
        greeting,
        paragraphs: [p.handover.opening, join(status, amountSentence(p, f, true), further), p.payBy, join(p.handover.consequence, costs), tail],
        closing: p.closing,
      };
    }
  }
}
