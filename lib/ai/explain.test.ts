import { describe, expect, it } from "vitest";
import { DE_BASE_RATES, DE_RULESET } from "../rules/de";
import { calculateClaim } from "../rules/engine";
import { explainFactsFromCalc, explainStep, templateExplanation, validateExplanation, type ExplainFacts } from "./explain";
import type { ProposableStepKind } from "./ports";
import { FakeModel, fakeGateway, toolResponse } from "./testing/fakeModel";

const ctx = { workspaceId: "ws-1" };

const calc = calculateClaim({
  invoice: { principalCents: 100000, dueDate: "2026-09-01", fixedCalendarDue: true, defaultWarningPrinted: false, debtorType: "business" },
  ledger: [],
  calcDate: "2026-10-01",
  ruleSet: DE_RULESET,
  baseRates: DE_BASE_RATES,
});

function facts(over: Partial<ExplainFacts> = {}): ExplainFacts {
  return {
    ...explainFactsFromCalc(calc, {
      stepKind: "mahnung1",
      lang: "en",
      debtorType: "business",
      today: "2026-10-01",
      dueDate: "2026-09-01",
      previousStepKind: "reminder",
      previousStepDate: "2026-09-20",
      earliestDate: "2026-09-27",
      waitingDays: 7,
    }),
    ...over,
  };
}

describe("explainStep", () => {
  it("accepts placeholders and verbatim citations, then fills dates and amounts", async () => {
    const f = facts();
    const text = `The debtor has been in default since {{DEFAULT_START}} (${f.citations[0]}). The reminder was sent on {{PREVIOUS_STEP_DATE}} and the waiting period of {{WAITING_DAYS}} days has passed, so a demand for {{TOTAL}} is proposed.`;
    const model = new FakeModel([toolResponse("submit_explanation", { explanation: text })]);
    const r = await explainStep(f, { gateway: fakeGateway(model).gateway, ctx });
    expect(r.source).toBe("ai");
    expect(r.text).toContain("since 2 September 2026 (BGB § 286(2) no. 1)");
    expect(r.text).toContain("20 September 2026");
    expect(r.text).toContain(`EUR ${(calc.totalDueCents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/, ",")}`);
    expect(r.text).toMatch(/not legal advice\.$/);
  });

  it("rejects invented numbers, then falls back to the template", async () => {
    const f = facts();
    const bad = { explanation: `The debtor is in default since 2 September (${f.citations[0]}) and owes EUR 1,007.40 after 30 days.` };
    const v = validateExplanation(bad, f);
    expect(v.issues.some((i) => i.startsWith("raw_number"))).toBe(true);
    expect(v.issues.some((i) => i.startsWith("raw_currency"))).toBe(true);
    const model = new FakeModel([toolResponse("submit_explanation", bad), toolResponse("submit_explanation", bad)]);
    const r = await explainStep(f, { gateway: fakeGateway(model).gateway, ctx });
    expect(r.source).toBe("template");
    expect(r.text).toContain("BGB § 286(2) no. 1");
  });

  it("requires a verbatim citation and a date placeholder", () => {
    const v = validateExplanation({ explanation: "A demand is proposed because the invoice is unpaid and the reminder did not help." }, facts());
    expect(v.issues).toEqual(expect.arrayContaining(["missing_citation: quote at least one citation verbatim from the facts", "missing_date_placeholder: refer to the relevant date with a placeholder"]));
  });

  const kinds: ProposableStepKind[] = ["reminder", "mahnung1", "mahnung2", "handover", "fee_invoice", "close"];
  for (const lang of ["de", "en"] as const) {
    for (const stepKind of kinds) {
      it(`template for ${stepKind} / ${lang} passes its own validator`, () => {
        const variants: ExplainFacts[] = [
          facts({ stepKind, lang }),
          facts({ stepKind, lang, defaultStart: null, defaultRule: null, inDefault: false, interestCents: 0, feeCents: 0, citations: [], debtorType: "consumer", previousStepKind: null, previousStepDate: null, earliestDate: null, waitingDays: null }),
        ];
        for (const f of variants) {
          const ff = stepKind === "close" ? { ...f, totalCents: 0, interestCents: 0, feeCents: 0 } : f;
          expect(validateExplanation({ explanation: templateExplanation(ff) }, ff).issues).toEqual([]);
        }
      });
    }
  }
});
