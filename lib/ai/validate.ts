// Validators for model-written text. The model may only write wording; every amount, date and
// number comes from placeholders filled by code. Validation runs on the raw draft (placeholders not
// yet filled) and returns machine-readable issue strings that are fed back to the model on retry.

import { z } from "zod";
import type { ToolSpec } from "./model";
import { LETTER_PLACEHOLDERS, PLACEHOLDER_RE, type Lang, type LetterFacts, type LetterKind, type LetterPlaceholder } from "./letterFacts";

export interface ValidationResult {
  passed: boolean;
  issues: string[];
}

// ---------------------------------------------------------------------------
// Draft schema (tool input)
// ---------------------------------------------------------------------------

export const LETTER_LIMITS = {
  subject: 120,
  greeting: 80,
  paragraph: 700,
  minParagraphs: 2,
  maxParagraphs: 6,
  closing: 200,
  total: 2500,
} as const;

export const letterDraftSchema = z.strictObject({
  subject: z.string().min(3).max(LETTER_LIMITS.subject),
  greeting: z.string().min(3).max(LETTER_LIMITS.greeting),
  paragraphs: z.array(z.string().min(1).max(LETTER_LIMITS.paragraph)).min(LETTER_LIMITS.minParagraphs).max(LETTER_LIMITS.maxParagraphs),
  closing: z.string().min(3).max(LETTER_LIMITS.closing),
});
export type LetterDraft = z.infer<typeof letterDraftSchema>;

export const SUBMIT_LETTER_TOOL: ToolSpec = {
  name: "submit_letter",
  description: "Submit the drafted letter. Use only the allowed {{PLACEHOLDERS}} for every amount, date, link, number and name.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["subject", "greeting", "paragraphs", "closing"],
    properties: {
      subject: { type: "string", minLength: 3, maxLength: LETTER_LIMITS.subject },
      greeting: { type: "string", minLength: 3, maxLength: LETTER_LIMITS.greeting },
      paragraphs: {
        type: "array",
        minItems: LETTER_LIMITS.minParagraphs,
        maxItems: LETTER_LIMITS.maxParagraphs,
        items: { type: "string", minLength: 1, maxLength: LETTER_LIMITS.paragraph },
      },
      closing: { type: "string", minLength: 3, maxLength: LETTER_LIMITS.closing },
    },
  },
};

// ---------------------------------------------------------------------------
// Placeholder policy per kind
// ---------------------------------------------------------------------------

const BASE_REQUIRED: Record<LetterKind, LetterPlaceholder[]> = {
  reminder: ["INVOICE_NUMBER", "TOTAL", "PAY_LINK", "CREDITOR"],
  mahnung1: ["INVOICE_NUMBER", "TOTAL", "DEADLINE", "PAY_LINK", "CREDITOR"],
  mahnung2: ["INVOICE_NUMBER", "PRINCIPAL", "TOTAL", "DEADLINE", "PAY_LINK", "CREDITOR"],
  handover_notice: ["INVOICE_NUMBER", "PRINCIPAL", "TOTAL", "DEADLINE", "PAY_LINK", "CREDITOR"],
};

export function requiredPlaceholders(f: Pick<LetterFacts, "kind" | "interestCents" | "feeCents">): LetterPlaceholder[] {
  const req = [...BASE_REQUIRED[f.kind]];
  const escalated = f.kind !== "reminder";
  if (escalated && f.feeCents > 0) req.push("FEE");
  if ((f.kind === "mahnung2" || f.kind === "handover_notice") && f.interestCents > 0) req.push("INTEREST");
  return req;
}

/** INTEREST and FEE are only allowed when the engine says something is owed. */
export function allowedPlaceholders(f: Pick<LetterFacts, "interestCents" | "feeCents">): LetterPlaceholder[] {
  return LETTER_PLACEHOLDERS.filter((p) => !(p === "INTEREST" && f.interestCents === 0) && !(p === "FEE" && f.feeCents === 0));
}

// ---------------------------------------------------------------------------
// Shared text checks
// ---------------------------------------------------------------------------

export function extractPlaceholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]);
}

export function stripPlaceholders(text: string): string {
  return text.replace(PLACEHOLDER_RE, " ");
}

const CITATION_UNIT = String.raw`(\d{3})(?:\s?Abs\.\s?(\d)|\((\d)\))?(?:\s?(?:S\.|Satz|sentence)\s?\d)?`;
const CITATION_RE = new RegExp(String.raw`§§?\s?${CITATION_UNIT}(?:\s?(?:,|und|and)\s?(?:§\s?)?${CITATION_UNIT})*\s?BGB`, "g");
const CITATION_UNIT_RE = new RegExp(CITATION_UNIT, "g");

export interface Citation {
  section: string;
  subsection: string | null;
}

/** Removes well-formed BGB citations ("§ 288 Abs. 2 BGB", "§§ 280 Abs. 2, 286 BGB", "§ 288(5) BGB"). */
export function extractCitations(text: string): { rest: string; citations: Citation[] } {
  const citations: Citation[] = [];
  const rest = text.replace(CITATION_RE, (m) => {
    for (const u of m.replace(/BGB$/, "").matchAll(CITATION_UNIT_RE)) {
      citations.push({ section: u[1], subsection: u[2] ?? u[3] ?? null });
    }
    return " ";
  });
  return { rest, citations };
}

interface TermRule {
  re: RegExp;
  code: string;
}

const NUMBER_WORDS =
  /(?<!\p{L})(zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|dreizehn|vierzehn|fünfzehn|sechzehn|siebzehn|achtzehn|neunzehn|zwanzig|dreißig|vierzig|fünfzig|hundert|tausend|millionen?|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|hundred|thousand|million|dozen|prozent|percent)(?!\p{L})/iu;
const MONTHS_AND_DAYS =
  /(?<!\p{L})(januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember|january|february|march|june|july|october|december|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|übermorgen|next week|nächste[nr]? woche|end of the month|monatsende)(?!\p{L})/iu;
const CURRENCY = /€|\$|(?<!\p{L})(eur|euro|euros|cent|cents|usd)(?!\p{L})/iu;

/** Never allowed in any model text: threats, credit bureau, criminal law, invented concessions or fees. */
export const ALWAYS_FORBIDDEN: readonly TermRule[] = [
  { re: /schufa|auskunftei|bonität|credit (bureau|agency|score|rating|report)/iu, code: "credit_bureau_threat" },
  { re: /strafanzeige|anzeige erstatten|criminal|polizei|(?<!\p{L})police(?!\p{L})|staatsanwalt|prosecut|(?<!\p{L})betrug|(?<!\p{L})fraud/iu, code: "criminal_threat" },
  { re: /(?<!\p{L})haft(?!\p{L})|gefängnis|(?<!\p{L})(prison|jail)(?!\p{L})/iu, code: "criminal_threat" },
  { re: /arbeitgeber|employer|veröffentlich|(?<!\p{L})publish|social media|name and shame|nachbarn|neighbo/iu, code: "pressure_threat" },
  { re: /(?<!\p{L})waive|waiver|forgiv|write[- ]off|written off|(?<!\p{L})erlass|verzicht|storn|cancel|gutschrift|credit note|discount|rabatt|skonto/iu, code: "unauthorized_concession" },
  { re: /ratenzahlung|instal{1,2}ment|payment plan|stundung|aufschub|extension|fristverlängerung/iu, code: "unauthorized_concession" },
  { re: /mahngebühr|bearbeitungsgebühr|dunning (fee|charge)|processing fee|admin(istration|istrative)? fee|service charge/iu, code: "invented_fee" },
];

/** Escalation language that is only allowed in a handover notice. */
export const HANDOVER_ONLY: readonly TermRule[] = [
  { re: /gerichtsvollzieher|bailiff/iu, code: "handover_only_term" },
  { re: /mahnbescheid|mahnverfahren|gericht|(?<!\p{L})court|(?<!\p{L})klage|lawsuit|(?<!\p{L})sue(?!\p{L})|legal action|rechtliche schritte/iu, code: "handover_only_term" },
  { re: /rechtsanwalt|anwalt|lawyer|attorney|solicitor|inkasso|collection agency|debt collect/iu, code: "handover_only_term" },
  { re: /vollstreck|enforcement|pfändung|garnish|verzugsschaden|damages|(?<!\p{L})kosten|(?<!\p{L})costs?(?!\p{L})/iu, code: "handover_only_term" },
];

const INTEREST_TERMS = /zins|(?<!\p{L})interest(?!\p{L})/iu;
const FEE_TERMS = /pauschale|flat fee|lump[- ]sum|late payment fee|gebühr|(?<!\p{L})fees?(?!\p{L})/iu;

const LEAK_TERMS =
  /system ?prompt|placeholder|platzhalter|(?<!\p{L})instruction|anweisung|language model|sprachmodell|(?<!\p{L})as an ai(?!\p{L})|(?<!\p{L})ki(?!\p{L})|künstliche intelligenz|artificial intelligence|(?<!\p{L})claude(?!\p{L})|anthropic|(?<!\p{L})json(?!\p{L})|(?<!\p{L})tool(?!\p{L})|schema|ignore (all|previous)|ignoriere/iu;
const MARKUP_OR_LINK = /[<>`{}]|https?:|www\.|@/iu;

const STOPWORDS: Record<Lang, Set<string>> = {
  de: new Set(["und", "die", "der", "das", "den", "dem", "sie", "ihre", "ihr", "ihnen", "bitte", "wir", "uns", "nicht", "zu", "zur", "mit", "von", "ist", "bis", "für", "auf", "eine", "einen", "dieses", "diese", "des", "zum", "im", "nach", "wird", "ein"]),
  en: new Set(["the", "and", "you", "your", "please", "we", "us", "of", "to", "is", "for", "with", "this", "by", "our", "on", "an", "if", "have", "has"]),
};

export function languageScore(text: string): Record<Lang, number> {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const score: Record<Lang, number> = { de: 0, en: 0 };
  for (const w of words) {
    if (STOPWORDS.de.has(w)) score.de++;
    if (STOPWORDS.en.has(w)) score.en++;
  }
  return score;
}

export function checkLanguage(text: string, lang: Lang, minHits = 3): string[] {
  const s = languageScore(text);
  const other: Lang = lang === "de" ? "en" : "de";
  if (s[lang] < minHits || s[lang] <= s[other]) return [`wrong_language: expected ${lang === "de" ? "German" : "English"}`];
  return [];
}

export interface TextCheckOptions {
  lang: Lang;
  allowedPlaceholders: readonly string[];
  /** BGB sections the text may cite. */
  allowedSections: readonly string[];
  /** Extra digit runs that may appear verbatim (explain step: digits taken from the facts). */
  allowedNumberTokens?: ReadonlySet<string>;
  /** Exact strings removed before the number check (verbatim citations from the facts). */
  verbatimAllowed?: readonly string[];
  handoverTermsAllowed: boolean;
  interestTermsAllowed: boolean;
  feeTermsAllowed: boolean;
}

/** Checks one piece of model text (placeholders still unfilled). Returns issue strings. */
export function checkModelText(text: string, o: TextCheckOptions): { issues: string[]; citations: Citation[] } {
  const issues = new Set<string>();

  for (const name of extractPlaceholders(text)) {
    if (!o.allowedPlaceholders.includes(name)) issues.add(`unknown_or_disallowed_placeholder: {{${name}}}`);
  }
  let rest = stripPlaceholders(text);
  for (const v of o.verbatimAllowed ?? []) if (v) rest = rest.split(v).join(" ");
  const ex = extractCitations(rest);
  rest = ex.rest;
  for (const c of ex.citations) {
    if (!o.allowedSections.includes(c.section)) issues.add(`citation_not_allowed: § ${c.section} BGB`);
  }

  if (/[{}]/.test(rest)) issues.add("malformed_placeholder: braces outside a valid {{PLACEHOLDER}}");
  if (/§/.test(rest)) issues.add("citation_malformed: § outside a recognised BGB citation");
  const digitRuns = rest.match(/\d+/g) ?? [];
  const badDigits = digitRuns.filter((d) => !o.allowedNumberTokens?.has(d));
  if (badDigits.length > 0) issues.add("raw_number: digits written outside placeholders (use {{TOTAL}}, {{DEADLINE}} and the other placeholders)");
  if (CURRENCY.test(rest)) issues.add("raw_currency: currency written outside placeholders (amount placeholders already include EUR)");
  if (NUMBER_WORDS.test(rest)) issues.add("number_word: numbers written as words are not allowed");
  if (MONTHS_AND_DAYS.test(rest)) issues.add("raw_date: dates, months or weekdays written outside {{DEADLINE}}");

  for (const r of ALWAYS_FORBIDDEN) if (r.re.test(rest)) issues.add(`forbidden_term: ${r.code}`);
  if (!o.handoverTermsAllowed) for (const r of HANDOVER_ONLY) if (r.re.test(rest)) issues.add(`forbidden_term: ${r.code}`);
  if (!o.interestTermsAllowed && INTEREST_TERMS.test(rest)) issues.add("forbidden_term: interest is not owed in this case");
  if (!o.feeTermsAllowed && FEE_TERMS.test(rest)) issues.add("forbidden_term: no fee is owed in this case");

  if (LEAK_TERMS.test(rest)) issues.add("instruction_leak: mentions prompts, placeholders, tools or AI");
  if (MARKUP_OR_LINK.test(rest)) issues.add("markup_or_link: no markup, links or email addresses (use {{PAY_LINK}})");

  return { issues: [...issues], citations: ex.citations };
}

// ---------------------------------------------------------------------------
// Letter validator
// ---------------------------------------------------------------------------

export function letterText(d: LetterDraft): string {
  return [d.subject, d.greeting, ...d.paragraphs, d.closing].join("\n");
}

export function validateLetterDraft(input: unknown, facts: LetterFacts, lang: Lang): ValidationResult & { draft: LetterDraft | null } {
  const parsed = letterDraftSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `schema: ${i.path.join(".") || "(root)"} ${i.message}`);
    return { passed: false, issues, draft: null };
  }
  const d = parsed.data;
  const issues: string[] = [];
  const all = letterText(d);
  if (all.length > LETTER_LIMITS.total) issues.push(`too_long: letter exceeds ${LETTER_LIMITS.total} characters`);

  const allowed = allowedPlaceholders(facts);
  const isHandover = facts.kind === "handover_notice";
  const sections = isHandover ? ["280", "286", "288"] : ["286", "288"];
  const { issues: textIssues, citations } = checkModelText(all, {
    lang,
    allowedPlaceholders: allowed,
    allowedSections: sections,
    handoverTermsAllowed: isHandover,
    interestTermsAllowed: facts.inDefault || facts.interestCents > 0,
    feeTermsAllowed: facts.feeCents > 0,
  });
  issues.push(...textIssues);

  // Correct subsection of BGB 288 for the debtor type.
  for (const c of citations) {
    if (c.section !== "288" || c.subsection === null) continue;
    if (facts.debtorType === "consumer" && c.subsection !== "1") issues.push(`wrong_citation: § 288(${c.subsection}) BGB does not apply to a consumer`);
    if (facts.debtorType === "business" && c.subsection === "1") issues.push("wrong_citation: use § 288(2) BGB for a business debtor");
    if (c.subsection === "5" && facts.feeCents === 0) issues.push("wrong_citation: § 288(5) BGB cited but no flat fee is owed");
  }

  const present = new Set(extractPlaceholders(all));
  for (const p of requiredPlaceholders(facts)) if (!present.has(p)) issues.push(`missing_placeholder: {{${p}}}`);
  if (!extractPlaceholders(d.closing).includes("CREDITOR")) issues.push("closing_must_contain: {{CREDITOR}}");

  issues.push(...checkLanguage(stripPlaceholders(all), lang));
  const unique = [...new Set(issues)];
  return { passed: unique.length === 0, issues: unique, draft: d };
}
