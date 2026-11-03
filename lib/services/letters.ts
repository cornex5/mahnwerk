// Deterministic in-app letters (no email is sent in the demo; letters are shown in the app).
// If the step carries an AI draft (steps.draft.subject and .body) with steps.validation.passed ===
// true, it is used as is;
// otherwise this template is the fallback. Amounts always come from the rules engine facts.

import type { Lang } from "./store";

export type LetterKind = "reminder" | "mahnung1" | "mahnung2" | "handover" | "fee_invoice";

export interface LetterFacts {
  kind: LetterKind;
  lang: Lang;
  creditorName: string;
  debtorName: string;
  invoiceNumber: string;
  virtualDate: string;
  openPrincipalCents: number;
  openInterestCents: number;
  openFeeCents: number;
  totalDueCents: number;
  dueDate: string;
}

export interface Letter {
  subject: string;
  body: string;
  lang: Lang;
  virtualDate: string;
  source: "ai" | "template";
}

export function formatEur(cents: number, lang: Lang): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  if (lang === "de") return `${sign}${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${frac} EUR`;
  return `${sign}EUR ${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
}

const SUBJECT: Record<LetterKind, Record<Lang, string>> = {
  reminder: { de: "Zahlungserinnerung", en: "Payment reminder" },
  mahnung1: { de: "1. Mahnung", en: "First formal reminder" },
  mahnung2: { de: "2. Mahnung", en: "Second formal reminder" },
  handover: { de: "Letzte Mahnung vor Abgabe", en: "Final notice before handover" },
  fee_invoice: { de: "Rechnung über Verzugszinsen und Pauschale", en: "Invoice for default interest and flat fee" },
};

/** 2026-09-30 becomes 30.09.2026 for German letters; other values pass through. */
export function formatDate(iso: string, lang: Lang): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m || lang !== "de") return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function lines(f: LetterFacts): string[] {
  const m = (c: number) => formatEur(c, f.lang);
  const due = formatDate(f.dueDate, f.lang);
  const asOf = formatDate(f.virtualDate, f.lang);
  if (f.lang === "de") {
    const out = [
      `Sehr geehrte Damen und Herren,`,
      "",
      `zur Rechnung ${f.invoiceNumber} an ${f.debtorName} (fällig am ${due}) ist zum ${asOf} noch offen:`,
    ];
    if (f.kind !== "fee_invoice" || f.openPrincipalCents > 0) out.push(`Hauptforderung: ${m(f.openPrincipalCents)}`);
    if (f.openInterestCents > 0) out.push(`Verzugszinsen: ${m(f.openInterestCents)}`);
    if (f.openFeeCents > 0) out.push(`Verzugspauschale (§ 288 Abs. 5 BGB): ${m(f.openFeeCents)}`);
    out.push(`Gesamt: ${m(f.totalDueCents)}`, "");
    if (f.kind === "reminder") out.push("Sicher haben Sie die Zahlung nur übersehen. Bitte begleichen Sie den Betrag in den nächsten Tagen.");
    if (f.kind === "mahnung1") out.push("Wir bitten Sie, den Gesamtbetrag innerhalb von 7 Tagen zu zahlen.");
    if (f.kind === "mahnung2") out.push("Bitte zahlen Sie den Gesamtbetrag innerhalb von 10 Tagen. Danach behalten wir uns weitere Schritte vor.");
    if (f.kind === "handover") out.push("Ohne Zahlung innerhalb von 14 Tagen geben wir die Forderung ab (gerichtliches Mahnverfahren oder Inkasso).");
    if (f.kind === "fee_invoice") out.push("Die Hauptforderung ist beglichen. Offen sind noch Verzugszinsen und gegebenenfalls die Pauschale.");
    out.push("", "Automatisch berechnet, keine Rechtsberatung.", "", `Mit freundlichen Grüßen`, f.creditorName);
    return out;
  }
  const out = [
    `Dear ${f.debtorName},`,
    "",
    `As of ${asOf}, the following is still open on invoice ${f.invoiceNumber} (due ${due}):`,
  ];
  if (f.kind !== "fee_invoice" || f.openPrincipalCents > 0) out.push(`Principal: ${m(f.openPrincipalCents)}`);
  if (f.openInterestCents > 0) out.push(`Default interest: ${m(f.openInterestCents)}`);
  if (f.openFeeCents > 0) out.push(`Flat fee (§ 288(5) BGB): ${m(f.openFeeCents)}`);
  out.push(`Total: ${m(f.totalDueCents)}`, "");
  if (f.kind === "reminder") out.push("This may simply have been overlooked. Please settle the amount in the next few days.");
  if (f.kind === "mahnung1") out.push("Please pay the total within 7 days.");
  if (f.kind === "mahnung2") out.push("Please pay the total within 10 days. After that we reserve further steps.");
  if (f.kind === "handover") out.push("Without payment within 14 days we will hand the claim over (court dunning procedure or collection).");
  if (f.kind === "fee_invoice") out.push("The principal has been paid. Default interest and, where applicable, the flat fee are still open.");
  out.push("", "Calculated automatically. This is not legal advice.", "", "Kind regards", f.creditorName);
  return out;
}

export function templateLetter(f: LetterFacts): Letter {
  return { subject: `${SUBJECT[f.kind][f.lang]}: ${f.invoiceNumber}`, body: lines(f).join("\n"), lang: f.lang, virtualDate: f.virtualDate, source: "template" };
}

/** Uses a validated AI draft from the step if present, else the template. */
export function letterFor(f: LetterFacts, draft: Record<string, unknown> | null, validation: Record<string, unknown> | null): Letter {
  const subject = draft?.subject;
  const body = draft?.body;
  // Only a draft that passed validation (amounts and citations checked against the facts) is used.
  const passed = validation !== null && validation.passed === true;
  if (passed && typeof subject === "string" && typeof body === "string" && subject.trim() && body.trim()) {
    return { subject: subject.slice(0, 300), body: body.slice(0, 20_000), lang: f.lang, virtualDate: f.virtualDate, source: "ai" };
  }
  return templateLetter(f);
}
