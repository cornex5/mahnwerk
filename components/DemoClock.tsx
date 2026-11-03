"use client";

import { useState } from "react";
import { apiPost, errorMessage } from "./lib/api";
import { fmtDate } from "./lib/format";
import { Button, Card, Notice } from "./ui";
import { useWorkspace } from "./WorkspaceProvider";
import Link from "next/link";

interface ClockResult {
  clock: { offsetDays: number; virtualDate: string };
  proposals: Array<{ caseId: string; kind: string | null; created: boolean; stepId: string | null }>;
}

const STEPS = [1, 7, 14, 30];

export function DemoClock() {
  const { data, virtualDate, readOnly, readOnlyReason, refresh } = useWorkspace();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ClockResult | null>(null);

  async function advance(days: number) {
    setBusy(days);
    setError(null);
    try {
      const res = await apiPost<ClockResult>(`/api/workspaces/${data.workspace.id}/clock`, { days });
      setResult(res);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const proposed = result?.proposals.filter((p) => p.stepId && p.kind) ?? [];
  return (
    <Card className="p-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Demo clock</p>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
            <span className="num font-mono text-2xl font-semibold">{fmtDate(virtualDate)}</span>
            <span className="text-sm text-muted">
              {readOnlyReason === "golden" ? "fixed in the example workspace" : data.workspace.clock_offset_days === 0 ? "equals today" : `today + ${data.workspace.clock_offset_days} days`}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Advance the demo clock">
          <span className="mr-1 text-sm text-muted">Advance by</span>
          {STEPS.map((d) => (
            <Button key={d} size="md" disabled={readOnly || busy !== null} loading={busy === d} onClick={() => advance(d)}>
              +{d} {d === 1 ? "day" : "days"}
            </Button>
          ))}
        </div>
      </div>
      {readOnly && <p className="mt-3 text-sm text-muted">The clock is disabled because this workspace is read-only.</p>}
      {error && (
        <Notice tone="danger" className="mt-3" title="Could not move the clock">
          {error}
        </Notice>
      )}
      {result && !error && (
        <Notice tone="brand" className="mt-3" title={`Clock moved to ${fmtDate(result.clock.virtualDate)}`}>
          {proposed.length > 0 ? (
            <>
              The rules engine proposed {proposed.length} step{proposed.length === 1 ? "" : "s"}. Nothing is sent until you approve it in the{" "}
              <Link className="font-medium underline underline-offset-2" href={`/w/${data.workspace.id}/queue`}>
                approval queue
              </Link>
              .
            </>
          ) : (
            "No step is due yet at this date."
          )}
        </Notice>
      )}
    </Card>
  );
}
