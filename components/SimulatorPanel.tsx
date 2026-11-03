"use client";

import { useState } from "react";
import { apiPost, errorMessage, newNonce } from "./lib/api";
import type { CaseView } from "./lib/claim";
import { eur, isClosedState, parseEuroToCents, STATE_LABEL } from "./lib/format";
import { Badge, Button, Card, inputClass, Notice, SectionTitle } from "./ui";
import { useWorkspace } from "./WorkspaceProvider";

type Action =
  | { type: "pay_full" }
  | { type: "pay_partial"; amountCents: number }
  | { type: "refund"; amountCents?: number }
  | { type: "dispute_open" }
  | { type: "dispute_resolve" };

export function SimulatorPanel({ view }: { view: CaseView }) {
  const { readOnly, refresh, data } = useWorkspace();
  const [partial, setPartial] = useState("");
  const [refund, setRefund] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const state = view.c.state;
  const closed = isClosedState(state);
  const paused = state === "paused_dispute";
  const hasPayment = data.ledger.some((l) => l.invoice_id === view.invoice.id && l.kind === "payment");
  const partialCents = parseEuroToCents(partial);
  const refundCents = refund.trim() ? parseEuroToCents(refund) : undefined;
  const refundInvalid = refund.trim() !== "" && refundCents === null;

  async function run(label: string, action: Action) {
    setBusy(label);
    setError(null);
    setOk(null);
    try {
      const res = await apiPost<{ case?: { state?: string }; usedRealDate?: boolean }>(`/api/cases/${view.c.id}/simulate`, { nonce: newNonce(), action });
      const next = res.case?.state;
      setOk(`Done. The reconciler processed it${next ? `; the case is now "${STATE_LABEL[next as keyof typeof STATE_LABEL] ?? next}"` : ""}.${res.usedRealDate ? " PayPal refused the virtual date, so today's real date was booked." : ""}`);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const off = readOnly || busy !== null;
  return (
    <Card className="p-5">
      <SectionTitle right={<Badge tone="warn">Sandbox only</Badge>}>Customer simulator</SectionTitle>
      <p className="mt-1 text-sm text-muted">Play the debtor. Actions run against the PayPal sandbox and flow through the same reconciler as a real webhook. No real money moves.</p>
      {readOnly && <p className="mt-2 text-sm text-muted">Disabled in a read-only workspace.</p>}

      <div className="mt-4 space-y-4">
        <Button className="w-full" variant="primary" disabled={off || closed || paused} loading={busy === "pay_full"} onClick={() => run("pay_full", { type: "pay_full" })}>
          Customer pays in full ({eur(view.owedCents)})
        </Button>

        <div>
          <label htmlFor="sim-partial" className="mb-1 block text-sm font-medium">
            Partial payment (EUR)
          </label>
          <div className="flex gap-2">
            <input id="sim-partial" inputMode="decimal" className={inputClass} placeholder="100.00" value={partial} onChange={(e) => setPartial(e.target.value)} disabled={off} />
            <Button disabled={off || closed || paused || partialCents === null} loading={busy === "pay_partial"} onClick={() => partialCents && run("pay_partial", { type: "pay_partial", amountCents: partialCents })}>
              Pay
            </Button>
          </div>
        </div>

        <div>
          <label htmlFor="sim-refund" className="mb-1 block text-sm font-medium">
            Refund (EUR, empty for the full amount)
          </label>
          <div className="flex gap-2">
            <input id="sim-refund" inputMode="decimal" className={inputClass} placeholder="full" value={refund} onChange={(e) => setRefund(e.target.value)} disabled={off} aria-invalid={refundInvalid} />
            <Button disabled={off || !hasPayment || refundInvalid} loading={busy === "refund"} onClick={() => run("refund", refundCents ? { type: "refund", amountCents: refundCents } : { type: "refund" })}>
              Refund
            </Button>
          </div>
          {!hasPayment && <p className="mt-1 text-xs text-muted">A refund needs a payment first.</p>}
        </div>

        <div className="flex flex-wrap gap-2 border-t border-line pt-4">
          <Button disabled={off || closed || paused} loading={busy === "dispute_open"} onClick={() => run("dispute_open", { type: "dispute_open" })}>
            Open a dispute
          </Button>
          <Button disabled={off || !paused} loading={busy === "dispute_resolve"} onClick={() => run("dispute_resolve", { type: "dispute_resolve" })}>
            Resolve the dispute
          </Button>
        </div>
      </div>

      {error && (
        <Notice tone="danger" className="mt-4" title="Simulation failed">
          {error}
        </Notice>
      )}
      {ok && (
        <Notice tone="brand" className="mt-4">
          {ok}
        </Notice>
      )}
    </Card>
  );
}
