"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { fmtTs, SENT_VIA_LABEL } from "./lib/format";
import { getSupabase } from "./lib/supabase";
import type { CaseView } from "./lib/claim";
import { Badge, Card, SectionTitle } from "./ui";
import { useWorkspace } from "./WorkspaceProvider";

interface EventRow {
  event_type: string;
  verified: boolean;
  received_at: string;
  processed_at: string | null;
  note: string | null;
}

/** What actually happened on PayPal for this invoice: the sandbox invoice, its synced status and the webhooks. */
export function PayPalPanel({ view }: { view: CaseView }) {
  const { data } = useWorkspace();
  const inv = view.invoice;
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const isExample = data.workspace.kind === "golden";
  const [qr, setQr] = useState<string | null>(null);
  const payUrl = inv.paypal_invoice_id ? `https://www.sandbox.paypal.com/invoice/p/#${encodeURIComponent(inv.paypal_invoice_id)}` : null;

  useEffect(() => {
    if (!payUrl) return;
    let alive = true;
    QRCode.toString(payUrl, { type: "svg", margin: 1, width: 132, color: { dark: "#0f1514", light: "#e6efec" } })
      .then((svg) => alive && setQr(svg))
      .catch(() => alive && setQr(null));
    return () => {
      alive = false;
    };
  }, [payUrl]);

  useEffect(() => {
    if (!inv.paypal_invoice_id || isExample) return;
    let alive = true;
    void getSupabase()
      .from("paypal_events")
      .select("event_type, verified, received_at, processed_at, note, resource_id")
      .eq("workspace_id", data.workspace.id)
      .eq("resource_id", inv.paypal_invoice_id)
      .order("received_at", { ascending: false })
      .limit(8)
      .then((res) => {
        if (alive) setEvents(res.error ? [] : ((res.data ?? []) as EventRow[]));
      });
    return () => {
      alive = false;
    };
  }, [data.workspace.id, data.ledger.length, data.steps.length, inv.paypal_invoice_id, isExample]);

  const sentSteps = view.steps.filter((s) => s.sent_via);

  return (
    <Card className="p-5">
      <SectionTitle right={<Badge tone="neutral">PayPal sandbox</Badge>}>PayPal evidence</SectionTitle>
      {isExample || !inv.paypal_invoice_id ? (
        <p className="mt-3 text-sm text-muted">
          The example workspace holds stored data, so there is no PayPal invoice here. In your own workspace every invoice is created on the PayPal sandbox, and its id, status, reminders and webhook events appear in this panel.
        </p>
      ) : (
        <div className="mt-3 space-y-3 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-muted">Invoice id</dt>
            <dd className="break-all font-mono text-xs">{inv.paypal_invoice_id}</dd>
            <dt className="text-muted">PayPal status</dt>
            <dd>{inv.paypal_status ?? "not synced yet"}</dd>
            <dt className="text-muted">Payer page</dt>
            <dd>
              <a className="text-brand underline underline-offset-2" href={`https://www.sandbox.paypal.com/invoice/p/#${encodeURIComponent(inv.paypal_invoice_id)}`} target="_blank" rel="noreferrer">
                Open on PayPal sandbox
              </a>
            </dd>
          </dl>
          {qr && (
            <div className="flex items-center gap-3">
              <div className="shrink-0 overflow-hidden rounded-md" role="img" aria-label="QR code of the PayPal payer page" dangerouslySetInnerHTML={{ __html: qr }} />
              <p className="text-xs text-muted">QR code of the payer page. A debtor can scan it and pay the invoice on PayPal.</p>
            </div>
          )}
          {sentSteps.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted">Sent steps</p>
              <ul className="mt-1 space-y-1">
                {sentSteps.map((s) => (
                  <li key={s.id} className="flex flex-wrap justify-between gap-2">
                    <span className="capitalize">{s.kind.replace("_", " ")}</span>
                    <span className="text-muted">{SENT_VIA_LABEL[s.sent_via ?? ""] ?? s.sent_via}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <p className="text-xs font-medium text-muted">Webhook events</p>
            {events === null ? (
              <p className="mt-1 text-xs text-muted">Loading...</p>
            ) : events.length === 0 ? (
              <p className="mt-1 text-xs text-muted">None yet. Pay the invoice with the customer simulator and PayPal sends one.</p>
            ) : (
              <ul className="mt-1 space-y-1.5">
                {events.map((e, i) => (
                  <li key={`${e.received_at}-${i}`} className="rounded-md border border-line px-2.5 py-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-xs">{e.event_type}</span>
                      <Badge tone={e.verified ? "brand" : "danger"}>{e.verified ? "signature verified" : "not verified"}</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-muted">
                      Received {fmtTs(e.received_at)}
                      {e.processed_at ? `, reconciled ${fmtTs(e.processed_at)}` : ", not processed yet"}
                      {e.note ? ` (${e.note})` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
