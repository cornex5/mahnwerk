// Letter facts, placeholders and deterministic formatting. All amounts and dates in a letter come
// from here (rules engine output), never from the model.

import { toDayNumber } from "../rules/dates";
import type { CalcResult, DebtorType, ISODate } from "../rules/types";

export type Lang = "de" | "en";
export const LANGS: readonly Lang[] = ["de", "en"];

export const LETTER_KINDS = ["reminder", "mahnung1", "mahnung2", "handover_notice"] as const;
export type LetterKind = (typeof LETTER_KINDS)[number];

export const LETTER_PLACEHOLDERS = [
  "PRINCIPAL",
  "INTEREST",
  "FEE",
  "TOTAL",
  "DEADLINE",
  "PAY_LINK",
  "INVOICE_NUMBER",
  "CREDITOR",
  "DEBTOR",
] as const;
export type LetterPlaceholder = (typeof LETTER_PLACEHOLDERS)[number];

export interface LetterFacts {
  kind: LetterKind;
  debtorType: DebtorType;
  creditorName: string;
  debtorName: string;
  invoiceNumber: string;
  /** Open amounts from the rules engine, integer cents. totalCents must equal the sum. */
  principalCents: number;
  interestCents: number;
  feeCents: number;
  totalCents: number;
  /** Payment deadline set by the services layer. */
  deadline: ISODate;
  /** https link to the PayPal invoice. */
  payLink: string;
  /** From the rules engine (CalcResult.inDefault). */
  inDefault: boolean;
}

export interface LetterMeta {
  kind: LetterKind;
  debtorType: DebtorType;
  creditorName: string;
  debtorName: string;
  invoiceNumber: string;
  deadline: ISODate;
  payLink: string;
}

/** Builds letter facts straight from a rules engine result, so amounts cannot drift. */
export function letterFactsFromCalc(calc: CalcResult, meta: LetterMeta): LetterFacts {
  return {
    ...meta,
    principalCents: calc.openPrincipalCents,
    interestCents: calc.openInterestCents,
    feeCents: calc.openFeeCents,
    totalCents: calc.totalDueCents,
    inDefault: calc.inDefault,
  };
}

function assertNonNegCents(v: number, name: string): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${name} must be non-negative integer cents, got ${v}`);
}

export function assertLetterFacts(f: LetterFacts): void {
  if (!(LETTER_KINDS as readonly string[]).includes(f.kind)) throw new RangeError(`Unknown letter kind ${String(f.kind)}`);
  assertNonNegCents(f.principalCents, "principalCents");
  assertNonNegCents(f.interestCents, "interestCents");
  assertNonNegCents(f.feeCents, "feeCents");
  assertNonNegCents(f.totalCents, "totalCents");
  if (f.principalCents + f.interestCents + f.feeCents !== f.totalCents) throw new RangeError("totalCents must equal principal + interest + fee");
  if (f.totalCents <= 0) throw new RangeError("Nothing is owed; no letter can be drafted");
  // BGB 288(5): the flat fee never applies to consumers. The engine guarantees this; check anyway.
  if (f.debtorType === "consumer" && f.feeCents > 0) throw new RangeError("A consumer debtor cannot owe the flat fee (BGB 288(5))");
  toDayNumber(f.deadline);
  if (!/^https:\/\/[^\s<>"{}]+$/.test(f.payLink)) throw new RangeError("payLink must be an https URL");
  for (const [k, v] of [
    ["creditorName", f.creditorName],
    ["debtorName", f.debtorName],
    ["invoiceNumber", f.invoiceNumber],
  ] as const) {
    if (typeof v !== "string" || v.trim() === "" || v.length > 200) throw new RangeError(`${k} must be a non-empty string up to 200 chars`);
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function groupThousands(n: number, sep: string): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/** Exact EUR formatting from integer cents. de: "1.234,56 EUR", en: "EUR 1,234.56". */
export function formatEur(cents: number, lang: Lang): string {
  assertNonNegCents(cents, "cents");
  const whole = Math.floor(cents / 100);
  const frac = String(cents % 100).padStart(2, "0");
  return lang === "de" ? `${groupThousands(whole, ".")},${frac} EUR` : `EUR ${groupThousands(whole, ",")}.${frac}`;
}

const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** de: "05.11.2026", en: "5 November 2026". */
export function formatDate(iso: ISODate, lang: Lang): string {
  toDayNumber(iso);
  const [y, m, d] = iso.split("-");
  if (lang === "de") return `${d}.${m}.${y}`;
  return `${Number(d)} ${EN_MONTHS[Number(m) - 1]} ${y}`;
}

// ---------------------------------------------------------------------------
// Placeholder filling
// ---------------------------------------------------------------------------

export const PLACEHOLDER_RE = /\{\{([A-Z_]+)\}\}/g;

export function letterValues(f: LetterFacts, lang: Lang): Record<LetterPlaceholder, string> {
  return {
    PRINCIPAL: formatEur(f.principalCents, lang),
    INTEREST: formatEur(f.interestCents, lang),
    FEE: formatEur(f.feeCents, lang),
    TOTAL: formatEur(f.totalCents, lang),
    DEADLINE: formatDate(f.deadline, lang),
    PAY_LINK: f.payLink,
    INVOICE_NUMBER: f.invoiceNumber.trim(),
    CREDITOR: f.creditorName.trim(),
    DEBTOR: f.debtorName.trim(),
  };
}

/**
 * Replaces placeholders in a single pass. Values are inserted literally, so a debtor name that
 * itself contains "{{TOTAL}}" is never expanded. Unknown placeholders throw (the validator rejects
 * them earlier; this is a second line of defence).
 */
export function fillPlaceholders(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER_RE, (_m, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) throw new RangeError(`Unknown placeholder {{${name}}}`);
    return values[name];
  });
}
