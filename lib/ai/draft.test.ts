import { describe, expect, it } from "vitest";
import { DE_BASE_RATES, DE_RULESET } from "../rules/de";
import { calculateClaim } from "../rules/engine";
import { draftLetter, render, REVIEWER_NOTE } from "./draft";
import { fillPlaceholders, formatDate, formatEur, LETTER_KINDS, letterFactsFromCalc, type Lang, type LetterFacts } from "./letterFacts";
import { templateLetter } from "./templates";
import { FakeModel, fakeGateway, textResponse, toolResponse } from "./testing/fakeModel";
import { validateLetterDraft, type LetterDraft } from "./validate";

const ctx = { workspaceId: "ws-1", stepId: "step-1" };

function facts(over: Partial<LetterFacts> = {}): LetterFacts {
  return {
    kind: "mahnung1",
    debtorType: "business",
    creditorName: "Studio Klein",
    debtorName: "Muster GmbH",
    invoiceNumber: "RE-2026-017",
    principalCents: 123456,
    interestCents: 854,
    feeCents: 4000,
    totalCents: 128310,
    deadline: "2026-11-20",
    payLink: "https://www.sandbox.paypal.com/invoice/p/#INV2-TEST",
    inDefault: true,
    ...over,
  };
}

const goodDraftDe: LetterDraft = {
  subject: "Mahnung zur Rechnung {{INVOICE_NUMBER}}",
  greeting: "Sehr geehrte Damen und Herren,",
  paragraphs: [
    "die Rechnung {{INVOICE_NUMBER}} ist leider noch nicht bezahlt. Sie befinden sich in Verzug (§ 286 BGB).",
    "Offen sind die Hauptforderung {{PRINCIPAL}}, Verzugszinsen {{INTEREST}} und die Verzugspauschale {{FEE}} (§ 288 Abs. 5 BGB), insgesamt {{TOTAL}}.",
    "Bitte zahlen Sie bis zum {{DEADLINE}} über diesen Link: {{PAY_LINK}}",
  ],
  closing: "Mit freundlichen Grüßen\n{{CREDITOR}}",
};

describe("formatting", () => {
  it("formats euro amounts exactly in German and English", () => {
    expect(formatEur(123456, "de")).toBe("1.234,56 EUR");
    expect(formatEur(123456, "en")).toBe("EUR 1,234.56");
    expect(formatEur(5, "de")).toBe("0,05 EUR");
    expect(formatEur(4000, "en")).toBe("EUR 40.00");
    expect(formatEur(123456789012, "de")).toBe("1.234.567.890,12 EUR");
    expect(formatEur(0, "en")).toBe("EUR 0.00");
    expect(() => formatEur(-1, "de")).toThrow();
    expect(() => formatEur(1.5, "de")).toThrow();
  });

  it("formats dates per language", () => {
    expect(formatDate("2026-11-05", "de")).toBe("05.11.2026");
    expect(formatDate("2026-11-05", "en")).toBe("5 November 2026");
  });

  it("fills placeholders in one pass and never expands values", () => {
    expect(fillPlaceholders("{{DEBTOR}} owes {{TOTAL}}", { DEBTOR: "Evil {{TOTAL}}", TOTAL: "EUR 1.00" })).toBe("Evil {{TOTAL}} owes EUR 1.00");
    expect(() => fillPlaceholders("{{NOPE}}", {})).toThrow();
  });
});

describe("draftLetter with a fake model", () => {
  it("fills placeholders from the facts with exact German formatting", async () => {
    const model = new FakeModel([toolResponse("submit_letter", goodDraftDe)]);
    const { gateway, recorder } = fakeGateway(model);
    const r = await draftLetter(facts(), "de", { gateway, ctx });
    expect(r.source).toBe("ai");
    expect(r.validation.passed).toBe(true);
    expect(r.subject).toBe("Mahnung zur Rechnung RE-2026-017");
    expect(r.text).toContain("Hauptforderung 1.234,56 EUR, Verzugszinsen 8,54 EUR und die Verzugspauschale 40,00 EUR");
    expect(r.text).toContain("insgesamt 1.283,10 EUR");
    expect(r.text).toContain("bis zum 20.11.2026");
    expect(r.text).toContain("https://www.sandbox.paypal.com/invoice/p/#INV2-TEST");
    expect(r.text).toMatch(/Studio Klein$/);
    expect(r.text).not.toContain("{{");
    expect(r.reviewerNote).toBe(REVIEWER_NOTE);
    expect(r.attempts).toBe(1);
    expect(recorder.rows).toHaveLength(1);
    expect(recorder.rows[0]).toMatchObject({ workspace_id: "ws-1", step_id: "step-1", purpose: "draft_letter", validation_passed: true, input_tokens: 100, output_tokens: 50 });
  });

  it("fills English formatting", async () => {
    const en: LetterDraft = {
      subject: "Payment demand for invoice {{INVOICE_NUMBER}}",
      greeting: "Dear Sir or Madam,",
      paragraphs: [
        "Our invoice {{INVOICE_NUMBER}} is still unpaid and you are in default (§ 286 BGB).",
        "Please pay the total of {{TOTAL}}, including the flat fee of {{FEE}}, by {{DEADLINE}} using this link: {{PAY_LINK}}",
      ],
      closing: "Kind regards,\n{{CREDITOR}}",
    };
    const model = new FakeModel([toolResponse("submit_letter", en)]);
    const { gateway } = fakeGateway(model);
    const r = await draftLetter(facts(), "en", { gateway, ctx });
    expect(r.source).toBe("ai");
    expect(r.text).toContain("total of EUR 1,283.10, including the flat fee of EUR 40.00, by 20 November 2026");
  });

  it("turns a literal backslash-n written by the model into a real line break", async () => {
    const d: LetterDraft = { ...goodDraftDe, closing: "Mit freundlichen Grüßen\\n{{CREDITOR}}" };
    expect(d.closing).toContain("\\n");
    const model = new FakeModel([toolResponse("submit_letter", d)]);
    const { gateway } = fakeGateway(model);
    const r = await draftLetter(facts(), "de", { gateway, ctx });
    expect(r.source).toBe("ai");
    expect(r.text).not.toContain("\\n");
    expect(r.text).toMatch(/Grüßen\n/);
  });

  it("never shows real amounts or names to the model", async () => {
    const model = new FakeModel([toolResponse("submit_letter", goodDraftDe)]);
    const { gateway } = fakeGateway(model);
    await draftLetter(facts(), "de", { gateway, ctx });
    const sent = JSON.stringify(model.requests[0]);
    for (const secret of ["1234", "1.234", "128310", "Muster GmbH", "Studio Klein", "RE-2026-017", "2026-11-20", "sandbox.paypal"]) {
      expect(sent).not.toContain(secret);
    }
    expect(model.requests[0].toolChoice).toEqual({ type: "tool", name: "submit_letter" });
  });

  it("rejects a model that writes 1.234,56 EUR itself, retries with the issues, then uses the template", async () => {
    const bad: LetterDraft = {
      ...goodDraftDe,
      paragraphs: ["Sie schulden uns 1.234,56 EUR aus der Rechnung {{INVOICE_NUMBER}}.", ...goodDraftDe.paragraphs.slice(1)],
    };
    const v = validateLetterDraft(bad, facts(), "de");
    expect(v.passed).toBe(false);
    expect(v.issues.some((i) => i.startsWith("raw_number"))).toBe(true);
    expect(v.issues.some((i) => i.startsWith("raw_currency"))).toBe(true);

    const model = new FakeModel([toolResponse("submit_letter", bad), toolResponse("submit_letter", bad)]);
    const { gateway, recorder } = fakeGateway(model);
    const r = await draftLetter(facts(), "de", { gateway, ctx });
    expect(r.source).toBe("template");
    expect(r.validation.passed).toBe(true);
    expect(r.attempts).toBe(2);
    expect(r.aiIssues.some((i) => i.startsWith("raw_number"))).toBe(true);
    // The retry carried the failure reasons back as a tool_result error.
    const retry = model.requests[1].messages;
    const last = retry[retry.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    const part = (last.content as { type: string; content?: string; is_error?: boolean }[])[0];
    expect(part.type).toBe("tool_result");
    expect(part.is_error).toBe(true);
    expect(part.content).toContain("raw_number");
    expect(recorder.rows.map((x) => x.validation_passed)).toEqual([false, false]);
    expect(r.text).toContain("1.283,10 EUR");
  });

  it("accepts the retry when the second draft is valid", async () => {
    const bad = { ...goodDraftDe, paragraphs: ["Zahlen Sie bitte bis 20.11.2026.", ...goodDraftDe.paragraphs.slice(1)] };
    const model = new FakeModel([toolResponse("submit_letter", bad), toolResponse("submit_letter", goodDraftDe)]);
    const { gateway } = fakeGateway(model);
    const r = await draftLetter(facts(), "de", { gateway, ctx });
    expect(r.source).toBe("ai");
    expect(r.attempts).toBe(2);
    expect(r.usage).toEqual({ inputTokens: 200, outputTokens: 100 });
  });

  it("falls back to the template when the model answers without the tool or errors", async () => {
    const m1 = new FakeModel([textResponse("Here is your letter: ..."), new Error("boom")]);
    const r1 = await draftLetter(facts(), "de", { gateway: fakeGateway(m1).gateway, ctx });
    expect(r1.source).toBe("template");
    expect(r1.aiIssues).toContain("model_error");
  });

  it("uses the template without any model call when the quota is exhausted", async () => {
    const model = new FakeModel([]);
    const { gateway } = fakeGateway(model, { workspace: 0 });
    const r = await draftLetter(facts(), "en", { gateway, ctx });
    expect(r.source).toBe("template");
    expect(r.quotaExhausted).toBe("workspace");
    expect(model.requests).toHaveLength(0);
  });

  it("builds facts from the rules engine so amounts cannot drift", () => {
    const calc = calculateClaim({
      invoice: { principalCents: 100000, dueDate: "2026-09-01", fixedCalendarDue: true, defaultWarningPrinted: false, debtorType: "business" },
      ledger: [],
      calcDate: "2026-10-01",
      ruleSet: DE_RULESET,
      baseRates: DE_BASE_RATES,
    });
    const f = letterFactsFromCalc(calc, {
      kind: "mahnung1",
      debtorType: "business",
      creditorName: "A",
      debtorName: "B",
      invoiceNumber: "X",
      deadline: "2026-10-15",
      payLink: "https://example.com/pay",
    });
    expect(f.totalCents).toBe(calc.totalDueCents);
    expect(f.feeCents).toBe(4000);
    expect(f.principalCents + f.interestCents + f.feeCents).toBe(f.totalCents);
  });

  it("refuses inconsistent facts and a fee for a consumer", async () => {
    const { gateway } = fakeGateway(new FakeModel([]));
    await expect(draftLetter(facts({ totalCents: 1 }), "de", { gateway, ctx })).rejects.toThrow();
    await expect(draftLetter(facts({ debtorType: "consumer" }), "de", { gateway, ctx })).rejects.toThrow(/consumer/);
    await expect(draftLetter(facts({ payLink: "javascript:alert(1)" }), "de", { gateway, ctx })).rejects.toThrow();
  });
});

describe("validator", () => {
  const f = facts();
  const check = (d: Partial<LetterDraft>, ff: LetterFacts = f, lang: Lang = "de") => validateLetterDraft({ ...goodDraftDe, ...d }, ff, lang);

  it("passes a clean draft", () => {
    expect(check({})).toMatchObject({ passed: true, issues: [] });
  });

  it("requires TOTAL, DEADLINE and PAY_LINK for mahnung1", () => {
    const r = check({ paragraphs: ["die Rechnung {{INVOICE_NUMBER}} ist leider noch nicht bezahlt, bitte zahlen Sie mit der Verzugspauschale {{FEE}}.", "Wir danken Ihnen für die Zahlung."] });
    expect(r.issues).toEqual(expect.arrayContaining(["missing_placeholder: {{TOTAL}}", "missing_placeholder: {{DEADLINE}}", "missing_placeholder: {{PAY_LINK}}"]));
  });

  it("rejects unknown and disallowed placeholders", () => {
    expect(check({ subject: "Mahnung {{INVOICE_NUMBER}} {{IBAN}}" }).issues).toContain("unknown_or_disallowed_placeholder: {{IBAN}}");
    const consumer = facts({ debtorType: "consumer", feeCents: 0, totalCents: 124310 });
    expect(check({}, consumer).issues).toContain("unknown_or_disallowed_placeholder: {{FEE}}");
    expect(check({ subject: "Mahnung {TOTAL}" }).issues.some((i) => i.startsWith("malformed_placeholder"))).toBe(true);
  });

  it("rejects dates, number words and percentages written by the model", () => {
    expect(check({ subject: "Mahnung vom 5. November" }).issues.some((i) => i.startsWith("raw_number"))).toBe(true);
    expect(check({ subject: "Mahnung, zahlbar in vierzehn Tagen" }).issues.some((i) => i.startsWith("number_word"))).toBe(true);
    expect(check({ subject: "Zahlung bis Ende November" }).issues.some((i) => i.startsWith("raw_date"))).toBe(true);
    expect(check({ subject: "Zinsen von neun Prozent" }).issues.some((i) => i.startsWith("number_word"))).toBe(true);
  });

  it("rejects threats and claims outside the allowlist", () => {
    expect(check({ subject: "Wir melden Sie der Schufa" }).issues).toContain("forbidden_term: credit_bureau_threat");
    expect(check({ subject: "Wir erstatten Strafanzeige" }).issues).toContain("forbidden_term: criminal_threat");
    expect(check({ subject: "Der Gerichtsvollzieher kommt" }).issues).toContain("forbidden_term: handover_only_term");
    expect(check({ subject: "Wir bieten Ratenzahlung an" }).issues).toContain("forbidden_term: unauthorized_concession");
    expect(check({ subject: "Zuzüglich Mahngebühr" }).issues).toContain("forbidden_term: invented_fee");
  });

  it("allows handover language only in a handover notice", () => {
    const ho = facts({ kind: "handover_notice" });
    const d: Partial<LetterDraft> = {
      paragraphs: [
        "trotz Mahnung ist die Rechnung {{INVOICE_NUMBER}} offen. Offen sind die Hauptforderung {{PRINCIPAL}}, Zinsen {{INTEREST}} und die Pauschale {{FEE}}, insgesamt {{TOTAL}}.",
        "Bitte zahlen Sie bis zum {{DEADLINE}}: {{PAY_LINK}}. Andernfalls übergeben wir die Forderung an ein Inkassounternehmen, das einen Gerichtsvollzieher beauftragen kann.",
      ],
    };
    expect(check(d, ho).passed).toBe(true);
    expect(check({ subject: "Wir übergeben an ein Inkassounternehmen" }).issues).toContain("forbidden_term: handover_only_term");
    // Schufa stays forbidden even in a handover notice.
    expect(check({ ...d, subject: "Schufa-Eintrag droht" }, ho).issues).toContain("forbidden_term: credit_bureau_threat");
  });

  it("checks BGB 288 subsections against the debtor type", () => {
    const consumer = facts({ debtorType: "consumer", feeCents: 0, totalCents: 124310 });
    const d: Partial<LetterDraft> = {
      paragraphs: [
        "die Rechnung {{INVOICE_NUMBER}} ist offen. Hauptforderung {{PRINCIPAL}}, Verzugszinsen {{INTEREST}} (§ 288 Abs. 2 BGB), insgesamt {{TOTAL}}.",
        "Bitte zahlen Sie bis zum {{DEADLINE}} über {{PAY_LINK}}.",
      ],
    };
    expect(check(d, consumer).issues).toContain("wrong_citation: § 288(2) BGB does not apply to a consumer");
    expect(check({ subject: "Mahnung (§ 123 BGB)" }).issues).toContain("citation_not_allowed: § 123 BGB");
  });

  it("rejects interest and fee wording when nothing of that kind is owed", () => {
    const early = facts({ kind: "reminder", inDefault: false, interestCents: 0, feeCents: 0, totalCents: 123456 });
    const d: Partial<LetterDraft> = {
      paragraphs: ["Die Rechnung {{INVOICE_NUMBER}} über {{TOTAL}} ist offen, zuzüglich Zinsen und einer Pauschale.", "Bitte zahlen Sie über {{PAY_LINK}}."],
    };
    const r = check(d, early);
    expect(r.issues).toEqual(expect.arrayContaining(["forbidden_term: interest is not owed in this case", "forbidden_term: no fee is owed in this case"]));
  });

  it("rejects the wrong language, instruction leaks, links and over-long text", () => {
    expect(
      check({ paragraphs: ["Please pay invoice {{INVOICE_NUMBER}} and the total {{TOTAL}} with the fee {{FEE}} by {{DEADLINE}}.", "Use the link {{PAY_LINK}} for the payment."], greeting: "Dear Sir or Madam,", closing: "Kind regards {{CREDITOR}}", subject: "Payment for the invoice" }).issues,
    ).toContain("wrong_language: expected German");
    expect(check({ subject: "Gemäß Systemprompt mit Platzhalter" }).issues.some((i) => i.startsWith("instruction_leak"))).toBe(true);
    expect(check({ subject: "Zahlen Sie auf www.example.com" }).issues.some((i) => i.startsWith("markup_or_link"))).toBe(true);
    const long = check({ paragraphs: Array.from({ length: 6 }, () => "Bitte zahlen Sie die Rechnung, wir danken Ihnen für die Zahlung und bitten um Erledigung. ".repeat(5)) });
    expect(long.issues.some((i) => i.startsWith("too_long"))).toBe(true);
    expect(check({ paragraphs: ["only one"] }).issues.some((i) => i.startsWith("schema"))).toBe(true);
    expect(validateLetterDraft({ ...goodDraftDe, extra: "x" }, f, "de").issues.some((i) => i.startsWith("schema"))).toBe(true);
  });
});

describe("templates", () => {
  const variants: LetterFacts[] = [];
  for (const kind of LETTER_KINDS) {
    variants.push(facts({ kind }));
    variants.push(facts({ kind, debtorType: "consumer", feeCents: 0, totalCents: 124310 }));
    variants.push(facts({ kind, debtorType: "consumer", feeCents: 0, interestCents: 0, inDefault: false, totalCents: 123456 }));
    variants.push(facts({ kind, interestCents: 0, inDefault: true, totalCents: 127456 }));
  }

  for (const lang of ["de", "en"] as const) {
    for (const f of variants) {
      it(`${f.kind} / ${f.debtorType} / interest ${f.interestCents} / fee ${f.feeCents} / ${lang} passes its own validator`, () => {
        const v = validateLetterDraft(templateLetter(f, lang), f, lang);
        expect(v.issues).toEqual([]);
      });
    }
  }

  it("mentions the flat fee and BGB 288(5) only for business debtors", () => {
    const b = JSON.stringify(templateLetter(facts({ kind: "mahnung2" }), "de"));
    expect(b).toContain("{{FEE}}");
    expect(b).toContain("§ 288 Abs. 5 BGB");
    expect(b).toContain("§ 288 Abs. 2 BGB");
    const c = JSON.stringify(templateLetter(facts({ kind: "mahnung2", debtorType: "consumer", feeCents: 0, totalCents: 124310 }), "de"));
    expect(c).not.toContain("FEE");
    expect(c).not.toContain("Pauschale");
    expect(c).toContain("§ 288 Abs. 1 BGB");
  });

  it("only the handover notice announces collection or court steps", () => {
    expect(JSON.stringify(templateLetter(facts({ kind: "handover_notice" }), "en"))).toContain("collection agency");
    for (const kind of ["reminder", "mahnung1", "mahnung2"] as const) {
      expect(JSON.stringify(templateLetter(facts({ kind }), "de"))).not.toMatch(/Inkasso|Mahnverfahren/);
    }
  });
});

describe("sign-off line break", () => {
  it("puts the creditor on its own line", () => {
    const d = { subject: "S", greeting: "G", paragraphs: ["a {{TOTAL}}", "b"], closing: "Mit freundlichen Grüßen, {{CREDITOR}}" };
    const values = { TOTAL: "1 EUR", CREDITOR: "Acme" };
    expect(render(d, values).letter.closing).toBe("Mit freundlichen Grüßen\nAcme");
    expect(render({ ...d, closing: "Kind regards, {{CREDITOR}}" }, values).letter.closing).toBe("Kind regards,\nAcme");
  });
});
