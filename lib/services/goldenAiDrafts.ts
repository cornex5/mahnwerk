// AI-written example letters for the read-only example workspace. Each raw draft is a real model
// output (Claude Sonnet, same prompt and validator as the product) captured in a throwaway demo
// workspace, with placeholders still in it. They are filled here with the example cases' own figures
// and validated again, so a visitor sees the AI wording without the example workspace spending any
// AI budget. A raw draft that does not validate against a case's facts is skipped (template instead).

import { letterValues, letterFactsFromCalc, type Lang } from "../ai/letterFacts";
import { render, REVIEWER_NOTE } from "../ai/draft";
import { validateLetterDraft, type LetterDraft } from "../ai/validate";
import { addDays } from "../rules/dates";
import type { CalcResult, DebtorType } from "../rules/types";
import { draftBasisOf, DEADLINE_DAYS } from "./draftBasis";
import type { DunningKind } from "./claims";

interface Example {
  kind: DunningKind;
  lang: Lang;
  raw: LetterDraft;
}

export const GOLDEN_AI_EXAMPLES: Record<string, Example> = {
  "MW-G-002": {
    kind: "reminder",
    lang: "de",
    raw: {
      "closing": "Mit freundlichen Grüßen\n{{CREDITOR}}",
      "subject": "Zahlungserinnerung zu unserer Rechnung {{INVOICE_NUMBER}}",
      "greeting": "Guten Tag {{DEBTOR}},",
      "paragraphs": [
            "zu unserer Rechnung {{INVOICE_NUMBER}} haben wir bis heute keinen Zahlungseingang festgestellt. Der offene Betrag beträgt {{TOTAL}}.",
            "Wir bitten Sie, diesen Betrag bis {{DEADLINE}} zu überweisen. Die Zahlung ist auch online möglich: {{PAY_LINK}}",
            "Haben Sie die Rechnung inzwischen beglichen, ist dieses Schreiben gegenstandslos. Bei Rückfragen zur Rechnung melden Sie sich bei uns."
      ]
},
  },
  "MW-G-003": {
    kind: "mahnung1",
    lang: "de",
    raw: {
      "closing": "Mit freundlichen Grüßen, {{CREDITOR}}",
      "subject": "Mahnung zu unserer Rechnung {{INVOICE_NUMBER}}",
      "greeting": "Sehr geehrte Damen und Herren,",
      "paragraphs": [
            "unsere Rechnung {{INVOICE_NUMBER}} über {{PRINCIPAL}} ist fällig. Einen Zahlungseingang haben wir bisher nicht festgestellt.",
            "Sie befinden sich damit nach § 286 BGB in Verzug. Wir berechnen daher gesetzliche Verzugszinsen nach § 288 Abs. 2 BGB. Sie betragen {{INTEREST}}. Dazu kommt die Pauschale für Zahlungsverzug nach § 288 Abs. 5 BGB. Sie beträgt {{FEE}}.",
            "Der offene Gesamtbetrag lautet auf {{TOTAL}}. Wir fordern Sie auf, diesen Betrag bis {{DEADLINE}} zu zahlen.",
            "Die Zahlung ist hier möglich: {{PAY_LINK}}"
      ]
},
  },
  "MW-G-004": {
    kind: "mahnung2",
    lang: "de",
    raw: {
      "closing": "Mit freundlichen Grüßen\n{{CREDITOR}}",
      "subject": "Zweite Mahnung zu unserer Rechnung {{INVOICE_NUMBER}}",
      "greeting": "Sehr geehrte Damen und Herren der {{DEBTOR}},",
      "paragraphs": [
            "unsere Rechnung {{INVOICE_NUMBER}} ist weiterhin offen. Wir haben dazu bisher keinen Zahlungseingang festgestellt. Auf unsere erste Zahlungsaufforderung haben wir keine Zahlung erhalten. Sie befinden sich damit im Verzug (§ 286 BGB).",
            "Offen sind folgende Beträge. Rechnungsbetrag: {{PRINCIPAL}}. Gesetzliche Verzugszinsen nach § 288 Abs. 2 BGB: {{INTEREST}}. Pauschale für Zahlungsverzug nach § 288 Abs. 5 BGB: {{FEE}}. Der Gesamtbetrag beträgt {{TOTAL}}.",
            "Wir fordern Sie auf, den Gesamtbetrag von {{TOTAL}} bis zum {{DEADLINE}} zu zahlen. Maßgeblich ist der Zahlungseingang bei uns. Die Zahlung können Sie über diesen Link vornehmen: {{PAY_LINK}}",
            "Haben Sie die Zahlung bereits veranlasst, prüfen Sie bitte den Zahlungsweg und nennen Sie bei Zahlung die Rechnungsnummer {{INVOICE_NUMBER}}."
      ]
},
  },
};

const AI_KIND = { reminder: "reminder", mahnung1: "mahnung1", mahnung2: "mahnung2", handover: "handover_notice" } as const;

export function goldenAiDraft(a: {
  number: string;
  kind: DunningKind;
  debtorType: DebtorType;
  debtorName: string;
  creditorName: string;
  claim: CalcResult;
  virtualDate: string;
}): { draft: Record<string, unknown>; validation: Record<string, unknown> } | null {
  const ex = GOLDEN_AI_EXAMPLES[a.number];
  if (!ex || ex.kind !== a.kind) return null;
  const facts = letterFactsFromCalc(a.claim, {
    kind: AI_KIND[a.kind],
    debtorType: a.debtorType,
    creditorName: a.creditorName,
    debtorName: a.debtorName,
    invoiceNumber: a.number,
    deadline: addDays(a.virtualDate, DEADLINE_DAYS[a.kind]),
    payLink: `https://www.sandbox.paypal.com/invoice/p/#EXAMPLE-${a.number}`,
  });
  const v = validateLetterDraft(ex.raw, facts, ex.lang);
  if (!v.passed || !v.draft) return null;
  const { letter, text } = render(v.draft, letterValues(facts, ex.lang));
  return {
    draft: {
      subject: letter.subject,
      body: text,
      lang: ex.lang,
      source: "ai",
      reviewer_note: REVIEWER_NOTE,
      generated_for: draftBasisOf(facts, a.virtualDate),
      raw: v.draft,
    },
    validation: { passed: true, issues: [] as string[], attempts: 1, ai_issues: [] as string[], example: true },
  };
}
