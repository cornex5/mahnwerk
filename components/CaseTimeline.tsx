"use client";

import { useMemo } from "react";
import { eur, fmtDate, fmtTs, humanizeAction, STATE_LABEL } from "./lib/format";
import type { AuditRow, CaseState, LedgerRow } from "./lib/types";
import { Card, EmptyState, SectionTitle, cx } from "./ui";

interface Item {
  key: string;
  date: string;
  ts: string;
  title: string;
  detail?: string;
  actor: string;
  tone: "brand" | "danger" | "ai" | "neutral";
}

const ACTOR_TONE: Record<string, Item["tone"]> = { user: "brand", system: "neutral", ai: "ai", paypal: "danger" };

function stateName(s: string | null): string {
  return s ? (STATE_LABEL[s as CaseState] ?? s) : "";
}

export function CaseTimeline({ audit, ledger }: { audit: AuditRow[]; ledger: LedgerRow[] }) {
  const items = useMemo(() => {
    const list: Item[] = [];
    for (const a of audit) {
      if (a.action.startsWith("ledger.")) continue; // shown from the ledger itself
      const transition = a.from_state || a.to_state ? `${stateName(a.from_state) || "start"} to ${stateName(a.to_state)}` : undefined;
      list.push({
        key: `a${a.id}`,
        date: a.virtual_date ?? a.real_ts.slice(0, 10),
        ts: a.real_ts,
        title: humanizeAction(a.action),
        detail: transition,
        actor: a.actor,
        tone: ACTOR_TONE[a.actor] ?? "neutral",
      });
    }
    for (const l of ledger) {
      list.push({
        key: `l${l.id}`,
        date: l.booked_on,
        ts: l.created_at,
        title: l.kind === "payment" ? `Payment received: ${eur(l.amount_cents)}` : `Refund issued: ${eur(l.amount_cents)}`,
        detail: `Ledger entry ${l.paypal_ref}`,
        actor: "paypal",
        tone: l.kind === "payment" ? "brand" : "danger",
      });
    }
    return list.sort((a, b) => a.date.localeCompare(b.date) || a.ts.localeCompare(b.ts));
  }, [audit, ledger]);

  return (
    <Card className="p-5">
      <SectionTitle>Timeline</SectionTitle>
      {items.length === 0 ? (
        <div className="mt-3">
          <EmptyState title="No events yet" />
        </div>
      ) : (
        <ol className="mt-4 space-y-0">
          {items.map((it, i) => (
            <li key={it.key} className="relative flex gap-3 pb-4 last:pb-0">
              {i < items.length - 1 && <span aria-hidden="true" className="absolute left-[5px] top-3 h-full w-px bg-line-strong" />}
              <span
                aria-hidden="true"
                className={cx(
                  "relative mt-1 h-[11px] w-[11px] shrink-0 rounded-full border-2 border-surface ring-1",
                  it.tone === "brand" && "bg-brand ring-brand",
                  it.tone === "danger" && "bg-danger ring-danger",
                  it.tone === "ai" && "bg-ai ring-ai",
                  it.tone === "neutral" && "bg-muted ring-muted",
                )}
              />
              <div className="min-w-0 text-sm">
                <p className="font-medium">{it.title}</p>
                <p className="text-xs text-muted">
                  {fmtDate(it.date)} · {it.actor} · logged {fmtTs(it.ts)}
                  {it.detail ? ` · ${it.detail}` : ""}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
