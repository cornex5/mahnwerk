"use client";

import { DE_RULESET } from "@/lib/rules/de";
import { LEGAL_NOTES, legalNoteKeys } from "@/lib/rules/legalNotes";
import type { CaseView } from "./lib/claim";
import { eur, fmtDate, pct } from "./lib/format";
import { Badge, Card, Notice, SectionTitle } from "./ui";
import { useWorkspace } from "./WorkspaceProvider";

const RULE_LABEL: Record<string, string> = {
  fixed_calendar_date: "Fixed calendar due date",
  payment_request: "Payment request (Mahnung) sent",
  thirty_day_rule: "30-day rule",
};

function Line({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: "danger" | "brand" }) {
  return (
    <div className={`flex items-baseline gap-2 py-1 text-sm ${strong ? "font-semibold" : ""}`}>
      <span>{label}</span>
      <span className="leader" aria-hidden="true" />
      <span className={`num font-mono ${tone === "danger" ? "text-danger" : tone === "brand" ? "text-brand" : ""}`}>{value}</span>
    </div>
  );
}

export function ClaimBreakdown({ view }: { view: CaseView }) {
  const { data, virtualDate } = useWorkspace();
  const claim = view.claim;
  const type = view.debtor?.type ?? "business";
  const margin = DE_RULESET.marginBp[type];
  const cit = DE_RULESET.citations;

  if (!claim) {
    return (
      <Card className="p-5">
        <SectionTitle>Claim calculation</SectionTitle>
        <Notice tone="warn" className="mt-3">
          The claim could not be calculated from the stored facts.
        </Notice>
      </Card>
    );
  }

  const notes = legalNoteKeys({ creditorIsSmallBusiness: data.creditor?.kleinunternehmer ?? false, debtorType: type });
  return (
    <Card className="p-5">
      <SectionTitle right={<Badge tone="brand">Rules engine, not AI</Badge>}>Claim calculation</SectionTitle>
      <p className="mt-1 text-sm text-muted">
        As of {fmtDate(virtualDate)}. Computed from the invoice facts and the ledger with {type === "consumer" ? "consumer" : "business"} rules (BGB 286, 288).
      </p>

      <div className="mt-4">
        <Line label="Principal (invoice)" value={eur(view.invoice.principal_cents)} />
        {claim.allocation.map((a, i) => (
          <Line key={i} label={`${a.kind === "payment" ? "Payment" : "Refund"} on ${fmtDate(a.date)}`} value={eur(a.amountCents)} />
        ))}
        <Line label="Open principal" value={eur(claim.openPrincipalCents)} />
      </div>

      <div className="mt-4 rounded-lg border border-line p-3 text-sm">
        {claim.defaultStart ? (
          <p>
            <strong>Default start:</strong> {fmtDate(claim.defaultStart)}
            {claim.defaultRule ? ` (${RULE_LABEL[claim.defaultRule] ?? claim.defaultRule})` : ""}.{" "}
            {claim.inDefault ? "The debtor is in default." : "Default has not started yet at this date."}
          </p>
        ) : (
          <p>
            <strong>No default yet.</strong> {type === "consumer" && !view.invoice.default_warning_printed ? "A consumer invoice without a default warning needs a payment request (Mahnung) first." : "No default rule applies yet."}
          </p>
        )}
        {claim.citation.length > 0 && <p className="mt-1 text-muted">Legal basis: {claim.citation.join("; ")}</p>}
      </div>

      {claim.segments.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <caption className="mb-2 text-left text-xs text-muted">
              Interest per period: base rate + margin ({pct(margin)} {type === "consumer" ? cit.interestConsumer : cit.interestBusiness}; base rate {cit.baseRate}). 365-day year.
            </caption>
            <thead className="text-left text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="py-1.5 pr-3 font-semibold">Period</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-semibold">Days</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-semibold">Principal</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-semibold">Rate</th>
                <th scope="col" className="py-1.5 text-right font-semibold">Interest (unrounded)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {claim.segments.map((s, i) => (
                <tr key={i}>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {fmtDate(s.from)} to {fmtDate(s.to)}
                  </td>
                  <td className="num py-2 pr-3 text-right font-mono">{s.days}</td>
                  <td className="num py-2 pr-3 text-right font-mono">{eur(s.principalCents)}</td>
                  <td className="num py-2 pr-3 text-right font-mono whitespace-nowrap">
                    {pct(s.rateBp - margin)} + {pct(margin)} = {pct(s.rateBp)}
                  </td>
                  <td className="num py-2 text-right font-mono">{`EUR ${(Number(s.interestExact) / 100).toFixed(4)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 border-t border-line pt-3">
        <Line label="Default interest accrued (rounded)" value={eur(claim.interestAccruedCents)} />
        {claim.interestPaidCents > 0 && <Line label="Interest already paid" value={`-${eur(claim.interestPaidCents)}`} />}
        <Line label="Open interest" value={eur(claim.openInterestCents)} />
        <Line
          label={`Flat fee ${type === "consumer" ? `(not owed by consumers, ${cit.flatFee})` : `(${cit.flatFee})`}`}
          value={eur(claim.flatFeeCents)}
        />
        {claim.openFeeCents !== claim.flatFeeCents && <Line label="Open flat fee" value={eur(claim.openFeeCents)} />}
        <Line label="Total owed now" value={eur(view.owedCents)} strong tone={view.owedCents > 0 ? "danger" : "brand"} />
        {claim.creditCents > 0 && <Line label="Credit held for the debtor" value={eur(claim.creditCents)} />}
      </div>
      {claim.refundCappedCents > 0 && (
        <Notice tone="warn" className="mt-3" title="Refund needs review">
          A refund of {eur(claim.refundCappedCents)} exceeded the open claim and was capped.
        </Notice>
      )}
      <ul className="mt-4 space-y-1 text-xs text-muted">
        {notes.map((k) => (
          <li key={k}>
            {LEGAL_NOTES[k].text} {LEGAL_NOTES[k].citation && `(${LEGAL_NOTES[k].citation})`}
          </li>
        ))}
      </ul>
    </Card>
  );
}
