import { describe, expect, it } from "vitest";
import { templateLetter, type LetterFacts } from "./letters";

const base: LetterFacts = {
  kind: "mahnung1",
  lang: "de",
  creditorName: "Studio Beispiel",
  debtorName: "Nordlicht Medien GmbH",
  invoiceNumber: "MW-1",
  virtualDate: "2026-11-20",
  dueDate: "2026-09-30",
  openPrincipalCents: 200000,
  openInterestCents: 2882,
  openFeeCents: 4000,
  totalDueCents: 206882,
};

describe("templateLetter pay link", () => {
  const link = "https://www.sandbox.paypal.com/invoice/p/#INV2-TEST";

  it("adds the PayPal link in German and English when one is known", () => {
    expect(templateLetter({ ...base, payLink: link }).body).toContain(`Zahlung online über PayPal: ${link}`);
    expect(templateLetter({ ...base, lang: "en", payLink: link }).body).toContain(`Pay online with PayPal: ${link}`);
  });

  it("adds no link line without one, and none to a fee invoice", () => {
    expect(templateLetter(base).body).not.toMatch(/PayPal/);
    expect(templateLetter({ ...base, kind: "fee_invoice", payLink: link }).body).not.toContain(link);
  });
});
