// Plain-language explanation for the creditor of why a step is proposed now. Dates and amounts only
// via placeholders filled from the rules engine; legal citations only verbatim from the facts or the
// rule set. Validated like letters; one retry, then a deterministic template.

import { z } from "zod";
import { DE_RULESET } from "../rules/de";
import { LEGAL_NOTES } from "../rules/legalNotes";
import type { CalcResult, DebtorType, DefaultRule, ISODate } from "../rules/types";
import type { AiContext, AiGateway } from "./budget";
import { fillPlaceholders, formatDate, formatEur, type Lang } from "./letterFacts";
import { addUsage, findToolUse, ZERO_USAGE, type ModelMessage, type ModelUsage, type ToolSpec } from "./model";
import type { ProposableStepKind, QuotaScope } from "./ports";
import { checkLanguage, checkModelText, extractPlaceholders, stripPlaceholders } from "./validate";

export interface ExplainFacts {
  stepKind: ProposableStepKind;
  lang: Lang;
  debtorType: DebtorType;
  /** Workspace virtual date the step is proposed on. */
  today: ISODate;
  dueDate: ISODate;
  defaultStart: ISODate | null;
  defaultRule: DefaultRule | null;
  inDefault: boolean;
  previousStepKind: ProposableStepKind | null;
  previousStepDate: ISODate | null;
  earliestDate: ISODate | null;
  /** Product policy waiting days before this step (not statutory). */
  waitingDays: number | null;
  totalCents: number;
  interestCents: number;
  feeCents: number;
  /** CalcResult.citation, verbatim. */
  citations: string[];
}

export interface ExplainMeta {
  stepKind: ProposableStepKind;
  lang: Lang;
  debtorType: DebtorType;
  today: ISODate;
  dueDate: ISODate;
  previousStepKind?: ProposableStepKind | null;
  previousStepDate?: ISODate | null;
  earliestDate?: ISODate | null;
  waitingDays?: number | null;
}

export function explainFactsFromCalc(calc: CalcResult, meta: ExplainMeta): ExplainFacts {
  return {
    stepKind: meta.stepKind,
    lang: meta.lang,
    debtorType: meta.debtorType,
    today: meta.today,
    dueDate: meta.dueDate,
    defaultStart: calc.defaultStart,
    defaultRule: calc.defaultRule,
    inDefault: calc.inDefault,
    previousStepKind: meta.previousStepKind ?? null,
    previousStepDate: meta.previousStepDate ?? null,
    earliestDate: meta.earliestDate ?? null,
    waitingDays: meta.waitingDays ?? null,
    totalCents: calc.totalDueCents,
    interestCents: calc.openInterestCents,
    feeCents: calc.openFeeCents,
    citations: [...calc.citation],
  };
}

export const EXPLAIN_MAX_CHARS = 700;
const DATE_PLACEHOLDERS = ["TODAY", "DUE_DATE", "DEFAULT_START", "PREVIOUS_STEP_DATE", "EARLIEST_DATE"] as const;

const explanationSchema = z.strictObject({ explanation: z.string().min(20).max(EXPLAIN_MAX_CHARS) });

export const EXPLAIN_TOOL: ToolSpec = {
  name: "submit_explanation",
  description: "Submit the explanation. Use placeholders for every date, amount and number.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["explanation"],
    properties: { explanation: { type: "string", minLength: 20, maxLength: EXPLAIN_MAX_CHARS } },
  },
};

const STEP_LABEL: Record<Lang, Record<ProposableStepKind, string>> = {
  en: {
    reminder: "payment reminder",
    mahnung1: "first payment demand (Mahnung)",
    mahnung2: "second payment demand",
    handover: "final notice before handover",
    fee_invoice: "invoice for the remaining open items",
    close: "closing the case",
  },
  de: {
    reminder: "Zahlungserinnerung",
    mahnung1: "erste Mahnung",
    mahnung2: "zweite Mahnung",
    handover: "letzte Mahnung vor Abgabe",
    fee_invoice: "Rechnung über die restlichen offenen Posten",
    close: "Abschluss des Falls",
  },
};

/** All citations the explanation may quote verbatim. */
function allowedCitations(f: ExplainFacts): string[] {
  const set = new Set<string>([...f.citations, ...Object.values(DE_RULESET.citations)]);
  // Longest first so a longer citation is removed before its prefix.
  return [...set].sort((a, b) => b.length - a.length);
}

function allowedPlaceholderNames(f: ExplainFacts): string[] {
  const names = ["TODAY", "DUE_DATE", "TOTAL"];
  if (f.defaultStart) names.push("DEFAULT_START");
  if (f.previousStepDate) names.push("PREVIOUS_STEP_DATE");
  if (f.earliestDate) names.push("EARLIEST_DATE");
  if (f.waitingDays !== null) names.push("WAITING_DAYS");
  if (f.interestCents > 0) names.push("INTEREST");
  if (f.feeCents > 0) names.push("FEE");
  return names;
}

function placeholderValues(f: ExplainFacts): Record<string, string> {
  const v: Record<string, string> = {
    TODAY: formatDate(f.today, f.lang),
    DUE_DATE: formatDate(f.dueDate, f.lang),
    TOTAL: formatEur(f.totalCents, f.lang),
    INTEREST: formatEur(f.interestCents, f.lang),
    FEE: formatEur(f.feeCents, f.lang),
  };
  if (f.defaultStart) v.DEFAULT_START = formatDate(f.defaultStart, f.lang);
  if (f.previousStepDate) v.PREVIOUS_STEP_DATE = formatDate(f.previousStepDate, f.lang);
  if (f.earliestDate) v.EARLIEST_DATE = formatDate(f.earliestDate, f.lang);
  if (f.waitingDays !== null) v.WAITING_DAYS = String(f.waitingDays);
  return v;
}

export function validateExplanation(input: unknown, f: ExplainFacts): { passed: boolean; issues: string[]; text: string | null } {
  const p = explanationSchema.safeParse(input);
  if (!p.success) return { passed: false, issues: p.error.issues.map((i) => `schema: ${i.path.join(".") || "(root)"} ${i.message}`), text: null };
  const text = p.data.explanation;
  const cites = allowedCitations(f);
  const numberTokens = new Set(cites.flatMap((c) => c.match(/\d+/g) ?? []));
  const { issues } = checkModelText(text, {
    lang: f.lang,
    allowedPlaceholders: allowedPlaceholderNames(f),
    allowedSections: [],
    allowedNumberTokens: numberTokens,
    verbatimAllowed: cites,
    handoverTermsAllowed: f.stepKind === "handover",
    interestTermsAllowed: f.inDefault || f.interestCents > 0,
    feeTermsAllowed: f.feeCents > 0,
  });
  const out = [...issues];
  if (f.citations.length > 0 && !cites.some((c) => text.includes(c))) out.push("missing_citation: quote at least one citation verbatim from the facts");
  const present = new Set(extractPlaceholders(text));
  if (!DATE_PLACEHOLDERS.some((d) => present.has(d))) out.push("missing_date_placeholder: refer to the relevant date with a placeholder");
  out.push(...checkLanguage(stripPlaceholders(text), f.lang, 3));
  const unique = [...new Set(out)];
  return { passed: unique.length === 0, issues: unique, text };
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

export function templateExplanation(f: ExplainFacts): string {
  const de = f.lang === "de";
  const label = STEP_LABEL[f.lang];
  const c = DE_RULESET.citations;
  const firstCite = f.citations[0];
  const s: string[] = [];

  s.push(
    de
      ? `Vorgeschlagen wird: ${label[f.stepKind]}. Die Rechnung war am {{DUE_DATE}} fällig und ist zum {{TODAY}} nicht vollständig bezahlt.`
      : `Proposed step: ${label[f.stepKind]}. The invoice was due on {{DUE_DATE}} and is not fully paid as of {{TODAY}}.`,
  );
  if (f.stepKind === "close") {
    s[0] = de
      ? `Vorgeschlagen wird: ${label.close}. Zum {{TODAY}} ist nach der Berechnung nichts mehr offen.`
      : `Proposed step: ${label.close}. As of {{TODAY}} nothing is owed according to the calculation.`;
  }

  if (f.defaultStart && firstCite) {
    if (f.inDefault) s.push(de ? `Der Schuldner ist seit dem {{DEFAULT_START}} in Verzug (${firstCite}).` : `The debtor has been in default since {{DEFAULT_START}} (${firstCite}).`);
    else if (f.stepKind !== "close" && f.stepKind !== "fee_invoice")
      s.push(de ? `Verzug tritt nach der Berechnung am {{DEFAULT_START}} ein (${firstCite}).` : `According to the calculation, default starts on {{DEFAULT_START}} (${firstCite}).`);
  } else if (f.stepKind !== "close" && f.stepKind !== "fee_invoice") {
    s.push(
      de
        ? `Der Schuldner ist noch nicht in Verzug. Eine Mahnung nach Fälligkeit begründet den Verzug (${c.paymentRequest}).`
        : `The debtor is not in default yet. A payment demand after the due date puts the debtor in default (${c.paymentRequest}).`,
    );
  }

  if (f.previousStepKind && f.previousStepDate && f.waitingDays !== null && f.earliestDate) {
    s.push(
      de
        ? `Der letzte Schritt (${label[f.previousStepKind]}) war am {{PREVIOUS_STEP_DATE}}. Nach der Wartefrist von {{WAITING_DAYS}} Tagen (Produktregel, nicht gesetzlich) ist dieser Schritt ab dem {{EARLIEST_DATE}} möglich.`
        : `The previous step (${label[f.previousStepKind]}) was on {{PREVIOUS_STEP_DATE}}. After the waiting period of {{WAITING_DAYS}} days (product policy, not statutory) this step is possible from {{EARLIEST_DATE}}.`,
    );
  }

  if (f.stepKind === "fee_invoice") {
    const owed: string[] = [];
    if (f.interestCents > 0) owed.push(de ? `Verzugszinsen von {{INTEREST}}` : `default interest of {{INTEREST}}`);
    if (f.feeCents > 0) owed.push(de ? `die Verzugspauschale von {{FEE}} (${c.flatFee})` : `the flat fee of {{FEE}} (${c.flatFee})`);
    if (owed.length === 0) owed.push(de ? "restliche Posten" : "remaining items");
    s.push(
      de
        ? `Die Hauptforderung ist bezahlt, offen sind noch ${owed.join(" und ")}, zusammen {{TOTAL}}. Dafür wird eine eigene Rechnung vorgeschlagen.`
        : `The principal is paid, but ${owed.join(" and ")} remain open, {{TOTAL}} in total. A separate invoice for this is proposed.`,
    );
  } else if (f.stepKind !== "close") {
    const extra: string[] = [];
    if (f.interestCents > 0) extra.push(de ? `davon Verzugszinsen {{INTEREST}}` : `including default interest of {{INTEREST}}`);
    if (f.feeCents > 0) extra.push(de ? `Verzugspauschale {{FEE}}` : `the flat fee of {{FEE}}`);
    s.push(de ? `Offen sind {{TOTAL}}${extra.length ? ` (${extra.join(", ")})` : ""}.` : `The open amount is {{TOTAL}}${extra.length ? ` (${extra.join(", ")})` : ""}.`);
  }

  if (s.join(" ").length < 20) s.push(de ? "Bitte prüfen Sie den Vorschlag." : "Please review the proposal.");
  return s.join(" ");
}

const NOTE: Record<Lang, string> = {
  en: LEGAL_NOTES.not_legal_advice.text,
  de: "Automatisch berechnet. Dies ist keine Rechtsberatung.",
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface ExplainDeps {
  gateway: AiGateway;
  ctx: AiContext;
}

export interface ExplainResult {
  /** Filled explanation followed by the not-legal-advice note. */
  text: string;
  rawText: string;
  source: "ai" | "template";
  validation: { passed: boolean; issues: string[] };
  aiIssues: string[];
  usage: ModelUsage;
  quotaExhausted: QuotaScope | null;
}

function buildSystem(f: ExplainFacts): string {
  const names = allowedPlaceholderNames(f).map((n) => `{{${n}}}`).join(", ");
  return [
    "You explain to a creditor, in two to four short sentences, why Mahnwerk proposes a dunning step now.",
    "A rules engine decided everything. Only restate the facts you are given; add no legal claims and no advice.",
    `Never write digits, amounts, currencies, dates, months, weekdays or numbers as words. Use only these placeholders: ${names}.`,
    "Quote at least one citation exactly as given in the facts (character for character). Refer to the relevant date with a placeholder.",
    "Do not mention credit bureaus, police, criminal law, waivers, discounts or payment plans. No markup, no links.",
    `Write in ${f.lang === "de" ? "German" : "English"}. At most ${EXPLAIN_MAX_CHARS} characters. Answer only by calling submit_explanation.`,
  ].join("\n");
}

function buildUser(f: ExplainFacts): string {
  const label = STEP_LABEL.en;
  return JSON.stringify({
    task: "explain_step",
    proposed_step: label[f.stepKind],
    previous_step: f.previousStepKind ? label[f.previousStepKind] : null,
    debtor_type: f.debtorType,
    debtor_in_default: f.inDefault,
    default_rule: f.defaultRule,
    interest_owed: f.interestCents > 0,
    flat_fee_owed: f.feeCents > 0,
    citations: f.citations,
    available_placeholders: allowedPlaceholderNames(f),
    waiting_days_are: "product policy, not statutory",
  });
}

export async function explainStep(f: ExplainFacts, deps: ExplainDeps): Promise<ExplainResult> {
  const values = placeholderValues(f);
  const system = buildSystem(f);
  const messages: ModelMessage[] = [{ role: "user", content: buildUser(f) }];
  let usage = ZERO_USAGE;
  let quotaExhausted: QuotaScope | null = null;
  const aiIssues: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const box: { text: string | null } = { text: null };
    const res = await deps.gateway.call({
      ctx: deps.ctx,
      purpose: "explain_step",
      inputFacts: { step: f.stepKind, lang: f.lang, in_default: f.inDefault, citations: f.citations, attempt: attempt + 1 },
      request: { system, messages, tools: [EXPLAIN_TOOL], toolChoice: { type: "tool", name: EXPLAIN_TOOL.name }, maxTokens: 600 },
      validate: (r) => {
        const use = findToolUse(r, EXPLAIN_TOOL.name);
        if (!use) return { passed: false, issues: ["no_tool_call"] };
        const v = validateExplanation(use.input, f);
        if (v.passed) box.text = v.text;
        return { passed: v.passed, issues: v.issues };
      },
    });
    if (!res.ok) {
      if (res.reason === "quota_exhausted") quotaExhausted = res.scope;
      else aiIssues.push("model_error");
      break;
    }
    usage = addUsage(usage, res.response.usage);
    const accepted = box.text;
    if (accepted !== null) {
      return {
        text: `${fillPlaceholders(accepted, values)} ${NOTE[f.lang]}`,
        rawText: accepted,
        source: "ai",
        validation: { passed: true, issues: [] },
        aiIssues,
        usage,
        quotaExhausted,
      };
    }
    aiIssues.push(...res.validation.issues);
    const use = findToolUse(res.response, EXPLAIN_TOOL.name);
    const feedback = `The explanation failed validation. Fix every issue:\n- ${res.validation.issues.join("\n- ")}`;
    if (use) {
      messages.push({ role: "assistant", content: [use] });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: feedback, is_error: true }] });
    } else {
      messages.push({ role: "assistant", content: "(no tool call)" });
      messages.push({ role: "user", content: feedback });
    }
  }

  const tpl = templateExplanation(f);
  const v = validateExplanation({ explanation: tpl }, f);
  if (!v.passed) throw new Error(`Template explanation failed validation (${f.stepKind}/${f.lang}): ${v.issues.join("; ")}`);
  return {
    text: `${fillPlaceholders(tpl, values)} ${NOTE[f.lang]}`,
    rawText: tpl,
    source: "template",
    validation: { passed: true, issues: [] },
    aiIssues,
    usage,
    quotaExhausted,
  };
}
