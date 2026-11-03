"use client";

import Link from "next/link";
import { useState } from "react";
import { CasesTable } from "./CasesTable";
import { CopilotPanel } from "./CopilotPanel";
import { DemoClock } from "./DemoClock";
import { eur } from "./lib/format";
import { NewInvoiceModal } from "./NewInvoiceModal";
import { Button, Card, Dialog, EmptyState, SectionTitle } from "./ui";
import { useWorkspace } from "./WorkspaceProvider";

function Stat({ label, cents, sub, tone }: { label: string; cents: number; sub: string; tone?: "danger" | "brand" }) {
  return (
    <Card className="p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</p>
      <p className={`num mt-2 font-mono text-xl font-semibold sm:text-2xl ${tone === "danger" ? "text-danger" : tone === "brand" ? "text-brand" : ""}`}>{eur(cents)}</p>
      <p className="mt-1 text-xs text-muted">{sub}</p>
    </Card>
  );
}

export function Dashboard() {
  const { data, views, totals, proposed, readOnly } = useWorkspace();
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Receivables</h1>
            <p className="text-sm text-muted">{data.creditor ? `Creditor: ${data.creditor.name}` : "Dunning cases at the virtual date"}</p>
          </div>
          <div className="flex gap-2">
            <Button className="lg:hidden" onClick={() => setCopilotOpen(true)}>
              Ask Mahnwerk
            </Button>
            <Button variant="primary" onClick={() => setInvoiceOpen(true)} disabled={readOnly} title={readOnly ? "Disabled in a read-only workspace" : undefined}>
              New invoice
            </Button>
          </div>
        </div>

        <DemoClock />

        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <Stat label="Open" cents={totals.openCents} sub={plural(totals.openCount, "active case")} />
          <Stat label="Overdue" cents={totals.overdueCents} sub={plural(totals.overdueCount, "case")} tone={totals.overdueCount > 0 ? "danger" : undefined} />
          <Stat label="In dunning" cents={totals.dunningCents} sub={plural(totals.dunningCount, "case")} />
          <Stat label="Collected" cents={totals.collectedCents} sub="payments net of refunds" tone="brand" />
        </div>

        {proposed.length > 0 && (
          <Link
            href={`/w/${data.workspace.id}/queue`}
            className="flex items-center justify-between gap-3 rounded-xl border border-ai-line bg-ai-soft px-4 py-3 text-sm hover:border-ai"
          >
            <span>
              <strong>{plural(proposed.length, "step")}</strong> waiting for your approval.
            </span>
            <span className="font-medium text-ai">Open queue</span>
          </Link>
        )}

        <section aria-labelledby="cases-h" className="space-y-3">
          <SectionTitle>
            <span id="cases-h">Cases</span>
          </SectionTitle>
          <CasesTable
            views={views}
            workspaceId={data.workspace.id}
            empty={
              <EmptyState
                title="No invoices yet"
                action={
                  <Button variant="primary" onClick={() => setInvoiceOpen(true)} disabled={readOnly}>
                    Create the first invoice
                  </Button>
                }
              >
                Create an invoice, then advance the demo clock past its due date to watch the rules engine open a dunning case.
              </EmptyState>
            }
          />
        </section>
      </div>

      <aside className="hidden lg:block" aria-label="Ask Mahnwerk">
        <div className="sticky top-4">
          <CopilotPanel />
        </div>
      </aside>
      <Dialog open={copilotOpen} onClose={() => setCopilotOpen(false)} title="Ask Mahnwerk" side>
        <CopilotPanel />
      </Dialog>
      <NewInvoiceModal open={invoiceOpen} onClose={() => setInvoiceOpen(false)} />
    </div>
  );
}
