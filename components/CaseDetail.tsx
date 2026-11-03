"use client";

import Link from "next/link";
import { CaseTimeline } from "./CaseTimeline";
import { ClaimBreakdown } from "./ClaimBreakdown";
import { eur, fmtDate, fmtTs } from "./lib/format";
import { ReplyBox } from "./ReplyBox";
import { SimulatorPanel } from "./SimulatorPanel";
import { StepCard } from "./StepCard";
import { Card, EmptyState, Notice, SectionTitle, StateBadge } from "./ui";
import { useWorkspace } from "./WorkspaceProvider";

export function CaseDetail({ caseId }: { caseId: string }) {
  const { data, views, virtualDate } = useWorkspace();
  const view = views.find((v) => v.c.id === caseId);
  if (!view) {
    return (
      <EmptyState
        title="Case not found"
        action={
          <Link className="text-sm font-medium text-brand underline underline-offset-2" href={`/w/${data.workspace.id}`}>
            Back to the dashboard
          </Link>
        }
      >
        This case is not part of this workspace.
      </EmptyState>
    );
  }
  const audit = data.audit.filter((a) => a.case_id === view.c.id);
  const ledger = data.ledger.filter((l) => l.invoice_id === view.invoice.id);
  const steps = [...view.steps].reverse();

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/w/${data.workspace.id}`} className="text-sm text-muted underline-offset-2 hover:text-ink hover:underline">
          Back to receivables
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">{view.debtor?.name ?? "Debtor"}</h1>
              <StateBadge state={view.c.state} />
            </div>
            <p className="mt-1 text-sm text-muted">
              Invoice <span className="font-mono">{view.invoice.number}</span> · issued {fmtDate(view.invoice.issue_date)} · due {fmtDate(view.invoice.due_date)} · {view.debtor?.type}
              {view.c.paused_reason ? ` · paused (${view.c.paused_reason})` : ""}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs font-medium text-muted">Owed at {fmtDate(virtualDate)}</p>
            <p className="num font-mono text-3xl font-semibold">{eur(view.owedCents)}</p>
            <p className="text-xs text-muted">
              of {eur(view.invoice.principal_cents)} principal{view.daysOverdue > 0 ? ` · ${view.daysOverdue} days overdue` : ""}
            </p>
          </div>
        </div>
      </div>

      {view.pendingStep && (
        <Notice tone="brand" title="A step is waiting for your approval">
          <Link className="font-medium underline underline-offset-2" href={`/w/${data.workspace.id}/queue`}>
            Open the approval queue
          </Link>{" "}
          or approve it below.
        </Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-6">
          <ClaimBreakdown view={view} />

          <section className="space-y-3" aria-labelledby="steps-h">
            <SectionTitle>
              <span id="steps-h">Steps and letters</span>
            </SectionTitle>
            {steps.length === 0 ? (
              <EmptyState title="No steps yet">The rules engine proposes the first step once the invoice is overdue and its waiting period has passed.</EmptyState>
            ) : (
              steps.map((s) => <StepCard key={s.id} step={s} view={view} />)
            )}
          </section>

          {ledger.length > 0 && (
            <Card className="p-5">
              <SectionTitle>Ledger</SectionTitle>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead className="text-left text-xs font-medium text-muted">
                    <tr>
                      <th scope="col" className="py-1.5 font-semibold">Booked</th>
                      <th scope="col" className="py-1.5 font-semibold">Type</th>
                      <th scope="col" className="py-1.5 text-right font-semibold">Amount</th>
                      <th scope="col" className="py-1.5 pl-4 font-semibold">Reference</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {ledger.map((l) => (
                      <tr key={l.id}>
                        <td className="py-2">{fmtDate(l.booked_on)}</td>
                        <td className="py-2 capitalize">{l.kind}</td>
                        <td className="num py-2 text-right font-mono">{l.kind === "refund" ? "-" : ""}{eur(l.amount_cents)}</td>
                        <td className="py-2 pl-4 font-mono text-xs text-muted" title={`Recorded ${fmtTs(l.created_at)}`}>{l.paypal_ref}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>

        <div className="min-w-0 space-y-6">
          <SimulatorPanel view={view} />
          <ReplyBox caseId={view.c.id} />
          <CaseTimeline audit={audit} ledger={ledger} />
        </div>
      </div>
    </div>
  );
}
