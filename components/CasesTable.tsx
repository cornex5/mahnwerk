"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { CaseView } from "./lib/claim";
import { eur, fmtDate, isClosedState, STATE_RANK } from "./lib/format";
import { Badge, EmptyState, StateBadge, cx } from "./ui";

type Filter = "all" | "active" | "closed";

export function CasesTable({ views, workspaceId, empty }: { views: CaseView[]; workspaceId: string; empty?: React.ReactNode }) {
  const [filter, setFilter] = useState<Filter>("all");
  const rows = useMemo(() => {
    const list = views.filter((v) => (filter === "all" ? true : filter === "closed" ? isClosedState(v.c.state) : !isClosedState(v.c.state)));
    return [...list].sort((a, b) => STATE_RANK[a.c.state] - STATE_RANK[b.c.state] || a.invoice.due_date.localeCompare(b.invoice.due_date));
  }, [views, filter]);

  if (views.length === 0) return <>{empty ?? <EmptyState title="No invoices yet">Create an invoice to open the first dunning case.</EmptyState>}</>;

  const href = (v: CaseView) => `/w/${workspaceId}/cases/${v.c.id}`;
  return (
    <div>
      <div className="mb-3 flex gap-1.5" role="group" aria-label="Filter cases">
        {(["all", "active", "closed"] as const).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={cx(
              "rounded-full border px-3 py-1 text-xs font-medium capitalize",
              filter === f ? "border-brand bg-brand text-brand-fg" : "border-line-strong bg-surface text-muted hover:text-ink",
            )}
          >
            {f}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <EmptyState title="Nothing here">No cases match this filter.</EmptyState>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-xl border border-line md:block">
            <table className="w-full min-w-[760px] text-sm">
              <caption className="sr-only">Dunning cases</caption>
              <thead className="bg-surface-2 text-left text-xs font-medium text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Debtor</th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">Invoice</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-semibold">Amount</th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">Due</th>
                  <th scope="col" className="px-3 py-2.5 font-semibold">State</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-semibold">Days overdue</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-semibold">Owed now</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line bg-surface">
                {rows.map((v) => (
                  <tr key={v.c.id} className="hover:bg-surface-2">
                    <td className="px-4 py-3">
                      <div className="font-medium">{v.debtor?.name ?? "Unknown debtor"}</div>
                      <div className="text-xs capitalize text-muted">{v.debtor?.type}</div>
                    </td>
                    <td className="px-3 py-3">
                      <Link href={href(v)} className="font-mono text-[13px] font-medium text-brand underline-offset-4 hover:underline">
                        {v.invoice.number ?? "no number"}
                      </Link>
                      {v.pendingStep && <Badge tone="ai" className="ml-2">Needs approval</Badge>}
                    </td>
                    <td className="num px-3 py-3 text-right font-mono">{eur(v.invoice.principal_cents)}</td>
                    <td className="px-3 py-3 whitespace-nowrap">{fmtDate(v.invoice.due_date)}</td>
                    <td className="px-3 py-3"><StateBadge state={v.c.state} /></td>
                    <td className={cx("num px-3 py-3 text-right font-mono", v.daysOverdue > 0 && "text-danger")}>{v.daysOverdue || "0"}</td>
                    <td className="num px-4 py-3 text-right font-mono font-semibold">{eur(v.owedCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-3 md:hidden">
            {rows.map((v) => (
              <li key={v.c.id}>
                <Link href={href(v)} className="block rounded-xl border border-line bg-surface p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">{v.debtor?.name ?? "Unknown debtor"}</p>
                      <p className="font-mono text-xs text-muted">{v.invoice.number}</p>
                    </div>
                    <StateBadge state={v.c.state} />
                  </div>
                  <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <dt className="text-muted">Amount</dt>
                      <dd className="num font-mono text-sm">{eur(v.invoice.principal_cents)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">Due</dt>
                      <dd className="text-sm">{fmtDate(v.invoice.due_date)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">Owed now</dt>
                      <dd className="num font-mono text-sm font-semibold">{eur(v.owedCents)}</dd>
                    </div>
                  </dl>
                  <p className={cx("mt-2 text-xs", v.daysOverdue > 0 ? "text-danger" : "text-muted")}>{v.daysOverdue} days overdue</p>
                  {v.pendingStep && <Badge tone="ai" className="mt-2">Needs approval</Badge>}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
