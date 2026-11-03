"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { fmtTs, STEP_LABEL, STEP_ORDER } from "./lib/format";
import { EmptyState, Notice, SectionTitle } from "./ui";
import { StepCard } from "./StepCard";
import { useWorkspace } from "./WorkspaceProvider";

export function ApprovalQueue() {
  const { data, views, proposed, readOnly } = useWorkspace();
  const viewByCase = useMemo(() => new Map(views.map((v) => [v.c.id, v])), [views]);

  // Steps acted on in this session stay on screen so their outcome message remains visible.
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const onActed = useCallback((id: string) => setPinned((p) => new Set(p).add(id)), []);

  const waiting = useMemo(() => data.steps.filter((s) => s.status === "proposed" || s.status === "approved" || pinned.has(s.id)), [data.steps, pinned]);
  const grouped = STEP_ORDER.map((kind) => ({ kind, steps: waiting.filter((s) => s.kind === kind) })).filter((g) => g.steps.length > 0);
  const history = useMemo(
    () => [...data.steps].filter((s) => (s.status === "sent" || s.status === "rejected" || s.status === "failed") && !pinned.has(s.id)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 12),
    [data.steps, pinned],
  );

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Approval queue</h1>
        <p className="mt-1 text-sm text-muted">
          The rules engine proposes steps when their waiting period is over. Every outbound step needs your explicit approval. {proposed.length} awaiting a decision.
        </p>
      </div>
      {readOnly && <Notice tone="info">Read-only workspace: you can inspect letters and reasoning, but approving and rejecting is disabled.</Notice>}

      {grouped.length === 0 ? (
        <EmptyState
          title="Nothing waiting for approval"
          action={
            <Link href={`/w/${data.workspace.id}`} className="text-sm font-medium text-brand underline underline-offset-2">
              Back to the dashboard
            </Link>
          }
        >
          {readOnly
            ? "This example workspace has no pending steps. Its sent steps are visible in each case."
            : "Advance the demo clock past an invoice's due date and the rules engine will propose the next step here."}
        </EmptyState>
      ) : (
        grouped.map((g) => (
          <section key={g.kind} className="space-y-3" aria-label={STEP_LABEL[g.kind]}>
            <SectionTitle>
              {STEP_LABEL[g.kind]} ({g.steps.length})
            </SectionTitle>
            {g.steps.map((s) => (
              <StepCard key={s.id} step={s} view={viewByCase.get(s.case_id)} showCaseLink onActed={onActed} />
            ))}
          </section>
        ))
      )}

      {history.length > 0 && (
        <section className="space-y-3" aria-label="Recent decisions">
          <SectionTitle>Recent decisions</SectionTitle>
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface text-sm">
            {history.map((s) => {
              const v = viewByCase.get(s.case_id);
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <span>
                    {STEP_LABEL[s.kind]} for {v?.debtor?.name ?? "debtor"} <span className="font-mono text-xs text-muted">{v?.invoice.number}</span>
                  </span>
                  <span className="flex items-center gap-3 text-xs text-muted">
                    {s.status === "sent" ? "Sent" : s.status === "rejected" ? "Rejected" : "Failed"} {fmtTs(s.sent_at ?? s.created_at)}
                    {v && (
                      <Link className="text-brand underline underline-offset-2" href={`/w/${data.workspace.id}/cases/${v.c.id}`}>
                        Open case
                      </Link>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
