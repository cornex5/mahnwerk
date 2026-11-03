import { describe, expect, it } from "vitest";
import { buildGoldenSeed } from "./goldenSeed";

describe("golden AI example letters", () => {
  const seed = buildGoldenSeed("00000000-0000-4000-8000-000000000001");
  const byNumber = (n: string) => {
    const inv = seed.invoices.find((i) => i.number === n)!;
    const c = seed.cases.find((x) => x.invoice_id === inv.id)!;
    return seed.steps.find((s) => s.case_id === c.id && s.status === "proposed")!;
  };

  it("seeds validated AI wording with the case's own figures", () => {
    for (const n of ["MW-G-002", "MW-G-003", "MW-G-004"]) {
      const step = byNumber(n);
      expect(step.validation).toMatchObject({ passed: true, example: true });
      const body = String((step.draft as Record<string, unknown>).body);
      expect(body).toContain(n);
      expect(body).not.toMatch(/\{\{|\\n/);
    }
    expect(String((byNumber("MW-G-004").draft as Record<string, unknown>).body)).toContain("2.068,82");
  });

  it("leaves a case whose facts do not fit the example (no flat fee) on the template", () => {
    expect(byNumber("MW-G-005").draft).toBeNull();
  });
});
