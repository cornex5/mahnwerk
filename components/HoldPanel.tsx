"use client";

import { useState } from "react";
import { apiPost, errorMessage } from "./lib/api";
import { fmtDate } from "./lib/format";
import { Badge, Button, Card, Notice, SectionTitle } from "./ui";
import { useWorkspace } from "./WorkspaceProvider";

const CHOICES = [7, 14, 30];

export function HoldPanel({ caseId, holdUntil, closed }: { caseId: string; holdUntil: string | null; closed: boolean }) {
  const { readOnly, refresh, virtualDate } = useWorkspace();
  const [busy, setBusy] = useState<number | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = holdUntil !== null && holdUntil > virtualDate;

  async function run(days: number | null) {
    setBusy(days ?? "clear");
    setError(null);
    try {
      await apiPost(`/api/cases/${caseId}/hold`, { days });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-5">
      <SectionTitle right={active ? <Badge tone="warn">On hold</Badge> : <Badge>Human decision</Badge>}>Hold the case</SectionTitle>
      <p className="mt-1 text-sm text-muted">
        After a dispute or an extension request you can stop the dunning for a while. While the hold lasts nothing new is proposed and an approved step refuses to send. Interest keeps running.
      </p>
      {active && (
        <Notice tone="warn" className="mt-3">
          On hold. Sending is possible again from {fmtDate(holdUntil)}.
        </Notice>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {CHOICES.map((d) => (
          <Button key={d} disabled={readOnly || closed || busy !== null} loading={busy === d} onClick={() => run(d)}>
            Hold {d} days
          </Button>
        ))}
        {active && (
          <Button disabled={readOnly || busy !== null} loading={busy === "clear"} onClick={() => run(null)}>
            Release hold
          </Button>
        )}
      </div>
      {error && (
        <Notice tone="danger" className="mt-3">
          {error}
        </Notice>
      )}
    </Card>
  );
}
