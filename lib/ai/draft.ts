// Letter drafting. The model writes wording only, with {{PLACEHOLDERS}} for every amount, date,
// link and name; code fills them from rules engine facts. Flow: draft, validate, one retry with the
// validation issues fed back, then a deterministic template. A human approves every letter before
// anything is sent (outside this module).

import type { AiContext, AiGateway } from "./budget";
import { assertLetterFacts, fillPlaceholders, letterValues, type Lang, type LetterFacts, type LetterKind } from "./letterFacts";
import { addUsage, findToolUse, ZERO_USAGE, type ModelMessage, type ModelResponse, type ModelUsage } from "./model";
import type { QuotaScope } from "./ports";
import { templateLetter } from "./templates";
import { allowedPlaceholders, requiredPlaceholders, SUBMIT_LETTER_TOOL, validateLetterDraft, type LetterDraft } from "./validate";

export interface DraftDeps {
  gateway: AiGateway;
  ctx: AiContext;
}

export interface DraftResult {
  /** Filled letter body: greeting, paragraphs and closing separated by blank lines. */
  text: string;
  subject: string;
  /** Filled letter parts. */
  letter: LetterDraft;
  /** Unfilled draft with placeholders, as validated. */
  rawDraft: LetterDraft;
  source: "ai" | "template";
  /** Validation of the returned draft. */
  validation: { passed: boolean; issues: string[] };
  /** Issues of rejected AI attempts (empty when the first draft passed or no AI call was made). */
  aiIssues: string[];
  usage: ModelUsage;
  attempts: number;
  quotaExhausted: QuotaScope | null;
  reviewerNote: string;
}

export const REVIEWER_NOTE = "Automatically drafted from rules engine figures. Review before sending. This is not legal advice.";

const KIND_BRIEF: Record<LetterKind, string> = {
  reminder: "A friendly first payment reminder (Zahlungserinnerung). Polite, assumes an oversight, no legal escalation.",
  mahnung1: "A first formal payment demand (Mahnung). Firm and factual. States the default position as given in the facts.",
  mahnung2: "A second formal payment demand (zweite Mahnung). Firmer, lists the open amounts, still no escalation beyond the demand. The subject must say that this is the second Mahnung (zweite Mahnung).",
  handover_notice:
    "A final demand that announces handing the claim to a collection agency or law firm or starting the court dunning procedure (gerichtliches Mahnverfahren) if unpaid by the deadline.",
};

function buildSystem(f: LetterFacts, lang: Lang): string {
  const required = requiredPlaceholders(f).map((p) => `{{${p}}}`).join(", ");
  const allowed = allowedPlaceholders(f).map((p) => `{{${p}}}`).join(", ");
  const language = lang === "de" ? "German (formal Sie form)" : "English (formal)";
  const debtor = f.debtorType === "consumer" ? "a consumer (private person)" : "a business";
  const citations =
    f.debtorType === "consumer"
      ? "§ 286 BGB, § 286 Abs. 1 BGB, § 288 Abs. 1 BGB"
      : `§ 286 BGB, § 286 Abs. 1 BGB, § 288 Abs. 2 BGB${f.feeCents > 0 ? ", § 288 Abs. 5 BGB" : ""}`;
  return [
    "You draft dunning letters for Mahnwerk, a receivables tool for German freelancers and small firms.",
    "A rules engine has already decided every amount, date and legal fact. You only write wording.",
    `The debtor is ${debtor}. Keep the tone formal and respectful${f.debtorType === "consumer" ? ", plain and non-technical" : ""}.`,
    "",
    "Hard rules:",
    "1. Never write any number, amount, currency, date, month, weekday, percentage or link yourself, not even as words. Use only these placeholders exactly as written: " +
      allowed +
      ".",
    `2. The letter must contain: ${required}. The closing must contain {{CREDITOR}}.`,
    "3. Placeholders for amounts already include the currency. Do not add EUR or a currency sign.",
    "4. No threats and no legal claims beyond the facts below. Never mention credit bureaus, police, criminal law, employers or publication. Never offer discounts, payment plans, extensions or waivers.",
    f.kind === "handover_notice"
      ? "5. You may announce handing over to a collection agency or law firm, the court dunning procedure and that resulting costs may be claimed as damages for default (§§ 280 Abs. 2, 286 BGB)."
      : "5. Do not mention lawyers, collection agencies, courts, enforcement or extra costs.",
    f.interestCents > 0 || f.inDefault ? "6. You may mention statutory default interest." : "6. Do not mention interest: none is owed.",
    f.feeCents > 0 ? "7. You may mention the flat fee for late payment ({{FEE}})." : "7. Do not mention any fee: none is owed.",
    `8. Cite law only in this form and only these: ${citations}${f.kind === "handover_notice" ? ", §§ 280 Abs. 2, 286 BGB" : ""}. In English write the same citations, e.g. § 286(1) BGB.`,
    "9. No markup, no links other than {{PAY_LINK}}, no email addresses, no mention of AI, prompts, placeholders or tools.",
    `10. Write in ${language}. ${LIMITS_TEXT}`,
    "11. Voice: the letter is written by the creditor ({{CREDITOR}}) to the debtor. Use \"wir\" and \"unsere Rechnung\" (English: \"we\", \"our invoice\") and address the debtor directly with \"Sie\" (English: \"you\"). Never describe the debtor or the creditor in the third person.",
    "12. Style: short, plain sentences. No thanks, no apologies, no reassurance, no flattery, no filler such as \"gerne\", \"sicher\", \"bequem\", \"simply\", \"kindly\". Do not guess why the invoice is unpaid. Vary sentence length.",
    "",
    "Submit the letter only by calling the submit_letter tool.",
  ].join("\n");
}

const LIMITS_TEXT = "Subject up to 120 characters, greeting up to 80, between 2 and 6 paragraphs of up to 700 characters each, closing up to 200.";

function buildUserMessage(f: LetterFacts, lang: Lang): string {
  return JSON.stringify({
    task: "draft_letter",
    letter_kind: f.kind,
    brief: KIND_BRIEF[f.kind],
    language: lang,
    debtor_type: f.debtorType,
    debtor_in_default: f.inDefault,
    interest_owed: f.interestCents > 0,
    flat_fee_owed: f.feeCents > 0,
  });
}

/** The model sometimes writes a line break as the two characters backslash and n; make it a real one. */
const lineBreaks = (s: string): string => s.replace(/\\r\\n|\\n/g, "\n");

/** A sign-off written on one line ("Mit freundlichen Grüßen, {{CREDITOR}}") gets its own line for the name. */
const signOff = (s: string): string =>
  s.replace(/^([^\n]*?),\s+(\{\{CREDITOR\}\})\s*$/, (_m, phrase: string, name: string) => `${phrase}${/^Mit freundlichen/i.test(phrase) ? "" : ","}\n${name}`);

export function render(d: LetterDraft, values: Record<string, string>): { letter: LetterDraft; text: string } {
  const fill = (s: string): string => lineBreaks(fillPlaceholders(s, values));
  const letter: LetterDraft = {
    subject: fill(d.subject).replace(/\n/g, " "),
    greeting: fill(d.greeting),
    paragraphs: d.paragraphs.map(fill),
    closing: fill(signOff(d.closing)),
  };
  return { letter, text: [letter.greeting, ...letter.paragraphs, letter.closing].join("\n\n") };
}

export async function draftLetter(facts: LetterFacts, lang: Lang, deps: DraftDeps): Promise<DraftResult> {
  assertLetterFacts(facts);
  const values = letterValues(facts, lang);
  const system = buildSystem(facts, lang);
  const messages: ModelMessage[] = [{ role: "user", content: buildUserMessage(facts, lang) }];
  const inputFacts = {
    kind: facts.kind,
    lang,
    debtor_type: facts.debtorType,
    in_default: facts.inDefault,
    interest_owed: facts.interestCents > 0,
    fee_owed: facts.feeCents > 0,
  };

  let usage = ZERO_USAGE;
  let attempts = 0;
  let quotaExhausted: QuotaScope | null = null;
  const aiIssues: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const box: { draft: LetterDraft | null } = { draft: null };
    const res = await deps.gateway.call({
      ctx: deps.ctx,
      purpose: "draft_letter",
      inputFacts: { ...inputFacts, attempt: attempt + 1 },
      request: { system, messages, tools: [SUBMIT_LETTER_TOOL], toolChoice: { type: "tool", name: SUBMIT_LETTER_TOOL.name } },
      validate: (r: ModelResponse) => {
        const use = findToolUse(r, SUBMIT_LETTER_TOOL.name);
        if (!use) return { passed: false, issues: ["no_tool_call: submit the letter with the submit_letter tool"] };
        const v = validateLetterDraft(use.input, facts, lang);
        if (v.passed) box.draft = v.draft;
        return { passed: v.passed, issues: v.issues };
      },
    });
    if (!res.ok) {
      if (res.reason === "quota_exhausted") quotaExhausted = res.scope;
      else aiIssues.push("model_error");
      break;
    }
    attempts++;
    usage = addUsage(usage, res.response.usage);
    const accepted = box.draft;
    if (accepted) {
      const { letter, text } = render(accepted, values);
      return {
        text,
        subject: letter.subject,
        letter,
        rawDraft: accepted,
        source: "ai",
        validation: { passed: true, issues: [] },
        aiIssues,
        usage,
        attempts,
        quotaExhausted,
        reviewerNote: REVIEWER_NOTE,
      };
    }
    aiIssues.push(...res.validation.issues);

    // Feed the issues back for one retry.
    const use = findToolUse(res.response, SUBMIT_LETTER_TOOL.name);
    const feedback = `The draft failed validation. Fix every issue and call submit_letter again:\n- ${res.validation.issues.join("\n- ")}`;
    if (use) {
      messages.push({ role: "assistant", content: [use] });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: feedback, is_error: true }] });
    } else {
      const text = res.response.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
      messages.push({ role: "assistant", content: text || "(no output)" });
      messages.push({ role: "user", content: feedback });
    }
  }

  const tpl = templateLetter(facts, lang);
  const v = validateLetterDraft(tpl, facts, lang);
  if (!v.passed) throw new Error(`Template letter failed validation (${facts.kind}/${lang}): ${v.issues.join("; ")}`);
  const { letter, text } = render(tpl, values);
  return {
    text,
    subject: letter.subject,
    letter,
    rawDraft: tpl,
    source: "template",
    validation: { passed: true, issues: [] },
    aiIssues,
    usage,
    attempts,
    quotaExhausted,
    reviewerNote: REVIEWER_NOTE,
  };
}
