"use client";

import { useMemo, useState } from "react";
import { computeClaim, firstPaymentRequestOn, type CaseView } from "./lib/claim";
import { eur, fmtDate, parseEuroToCents } from "./lib/format";
import type { LedgerRow } from "./lib/types";
import { Badge, Card, Field, inputClass, SectionTitle } from "./ui";
import { useWorkspace } from "./WorkspaceProvider";

function Row({ label, now, then }: { label: string; now: number; then: number }) {
  const diff = then - now;
  return (
    <tr>
      <th scope="row" className="py-1.5 pr-3 text-left font-normal">{label}</th>
      <td className="num py-1.5 text-right font-mono">{eur(now)}</td>
      <td className="num py-1.5 text-right font-mono">{eur(then)}</td>
      <td className={`num py-1.5 pl-3 text-right font-mono ${diff < 0 ? "text-brand" : diff > 0 ? "text-danger" : "text-muted"}`}>
        {diff === 0 ? "0.00" : `${diff > 0 ? "+" : "-"}${eur(Math.abs(diff))}`}
      </td>
    </tr>
  );
}

/** Runs the same pure rules engine as the claim calculation on hypothetical facts. Nothing is saved or sent. */
export function WhatIfPanel({ view }: { view: CaseView }) {
  const { data, virtualDate } = useWorkspace();
  const [calcDate, setCalcDate] = useState(virtualDate);
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState(virtualDate);

  const cents = payAmount.trim() === "" ? 0 : parseEuroToCents(payAmount);
  const result = useMemo(() => {
    if (!view.debtor) return null;
    const first = firstPaymentRequestOn(data.audit, view.invoice.id);
    const base = computeClaim(view.invoice, view.debtor.type, data.ledger, first, calcDate);
    if (!base) return null;
    let ledger: LedgerRow[] = data.ledger;
    if (cents !== null && cents > 0) {
      const hypo: LedgerRow = {
        id: "what-if",
        workspace_id: view.invoice.workspace_id,
        invoice_id: view.invoice.id,
        kind: "payment",
        amount_cents: cents,
        booked_on: payDate,
        paypal_ref: "what-if",
        source: "manual",
        created_at: new Date().toISOString(),
      };
      ledger = [...data.ledger, hypo];
    }
    const then = computeClaim(view.invoice, view.debtor.type, ledger, first, calcDate);
    return then ? { base, then } : null;
  }, [view, data.audit, data.ledger, calcDate, cents, payDate]);

  const inputBad = cents === null;
  const current = view.claim;

  return (
    <Card className="p-5">
      <SectionTitle right={<Badge tone="brand">Rules engine, not AI</Badge>}>What if?</SectionTitle>
      <p className="mt-1 text-sm text-muted">
        Change the date or add a payment to see how the claim moves. This runs the same engine in your browser. Nothing is saved or sent.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Field label="Calculate as of" htmlFor="wi-date">
          <input id="wi-date" type="date" className={inputClass} value={calcDate} onChange={(e) => e.target.value && setCalcDate(e.target.value)} />
        </Field>
        <Field label="Customer pays (EUR)" htmlFor="wi-amount" hint={inputBad ? "Enter a positive amount like 250.00" : undefined}>
          <input id="wi-amount" inputMode="decimal" placeholder="0.00" className={inputClass} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
        </Field>
        <Field label="Payment date" htmlFor="wi-pay-date">
          <input id="wi-pay-date" type="date" className={inputClass} value={payDate} onChange={(e) => e.target.value && setPayDate(e.target.value)} />
        </Field>
      </div>
      {result && current ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead className="text-xs font-medium text-muted">
              <tr>
                <th scope="col" className="py-1.5 text-left font-semibold">At {fmtDate(calcDate)}</th>
                <th scope="col" className="py-1.5 text-right font-semibold">Without payment</th>
                <th scope="col" className="py-1.5 text-right font-semibold">With payment</th>
                <th scope="col" className="py-1.5 pl-3 text-right font-semibold">Change</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              <Row label="Open principal" now={result.base.openPrincipalCents} then={result.then.openPrincipalCents} />
              <Row label="Open default interest" now={result.base.openInterestCents} then={result.then.openInterestCents} />
              <Row label="Flat fee (BGB 288(5))" now={result.base.openFeeCents} then={result.then.openFeeCents} />
              <Row label="Total owed" now={result.base.totalDueCents} then={result.then.totalDueCents} />
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">
            Default {result.base.defaultStart ? `starts ${fmtDate(result.base.defaultStart)}` : "has not started"}. A payment goes to fee, then interest, then principal (BGB 367).
          </p>
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted">This case cannot be calculated from the stored facts.</p>
      )}
    </Card>
  );
}
