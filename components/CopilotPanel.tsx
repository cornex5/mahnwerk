"use client";

import Link from "next/link";
import { useState } from "react";
import { apiPostFirstAccepted, ApiError, errorMessage } from "./lib/api";
import { Badge, Button, Card, inputClass, Notice, SectionTitle } from "./ui";
import { useWorkspace } from "./WorkspaceProvider";

interface Turn {
  question: string;
  answer: string;
  proposedStepIds: string[];
  note?: string;
}

const SUGGESTIONS = ["Which cases need action today?", "What do we owe in interest across all cases?", "Propose the next step for every overdue case."];

/** The model is told to use plain text; this strips any markdown emphasis that slips through. */
function plainText(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|$)/g, "$1$2").replace(/`([^`]+)`/g, "$1");
}

function pickAnswer(data: unknown): { answer: string; proposed: string[]; note?: string } {
  const d = (data ?? {}) as Record<string, unknown>;
  const answer = [d.answer, d.text, d.message].find((v): v is string => typeof v === "string" && v.trim() !== "") ?? "The copilot returned no answer.";
  const raw = d.proposedStepIds ?? d.proposed_step_ids ?? d.proposedSteps;
  const proposed = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  const stop = d.stopReason;
  const note = stop === "quota_exhausted" ? "The AI budget for this workspace is used up." : stop === "tool_limit" ? "The copilot hit its tool-call limit." : undefined;
  return { answer, proposed, note };
}

export function CopilotPanel() {
  const { data, readOnly, readOnlyReason, refresh } = useWorkspace();
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(q: string) {
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiPostFirstAccepted(`/api/workspaces/${data.workspace.id}/copilot`, [{ question: text }]);
      const { answer, proposed, note } = pickAnswer(res);
      setTurns((t) => [...t, { question: text, answer, proposedStepIds: proposed, note }]);
      setQuestion("");
      if (proposed.length > 0) await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.missing) setError("The copilot is not available: the AI is not configured on this server.");
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col p-4">
      <SectionTitle right={<Badge tone="ai">AI, read-only tools</Badge>}>Ask Mahnwerk</SectionTitle>
      <p className="mt-2 text-sm text-muted">
        Ask about your cases. The copilot reads the workspace and may propose steps, which land in the approval queue. It cannot send anything.
      </p>
      {readOnly && readOnlyReason !== "golden" ? (
        <Notice tone="info" className="mt-3">
          The copilot is disabled because this workspace is read-only.
        </Notice>
      ) : (
        <>
          {readOnlyReason === "golden" && (
            <Notice tone="info" className="mt-3">
              In the read-only example the copilot answers questions but cannot propose steps.
            </Notice>
          )}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" disabled={busy} onClick={() => ask(s)} className="rounded-full border border-line-strong bg-surface-2 px-2.5 py-1 text-left text-xs hover:border-brand disabled:opacity-50">
                {s}
              </button>
            ))}
          </div>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(question);
            }}
          >
            <label htmlFor="copilot-q" className="sr-only">
              Your question
            </label>
            <input id="copilot-q" className={inputClass} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask a question" maxLength={500} disabled={busy} />
            <Button type="submit" variant="primary" loading={busy} disabled={!question.trim()}>
              Ask
            </Button>
          </form>
        </>
      )}
      {error && (
        <Notice tone="danger" className="mt-3">
          {error}
        </Notice>
      )}
      <div className="mt-4 space-y-4" aria-live="polite">
        {[...turns].reverse().map((t, i) => (
          <div key={turns.length - i} className="space-y-2 border-t border-line pt-3">
            <p className="text-sm font-medium">{t.question}</p>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{plainText(t.answer)}</p>
            {t.note && <p className="text-xs text-muted">{t.note}</p>}
            {t.proposedStepIds.length > 0 && (
              <Notice tone="brand" title={`${t.proposedStepIds.length} step${t.proposedStepIds.length === 1 ? "" : "s"} proposed`}>
                Waiting for your decision in the{" "}
                <Link className="font-medium underline underline-offset-2" href={`/w/${data.workspace.id}/queue`}>
                  approval queue
                </Link>
                .
              </Notice>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
