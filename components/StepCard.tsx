"use client";

import Link from "next/link";
import { useState } from "react";
import type { Letter } from "@/lib/services/letters";
import { draftFingerprint } from "@/lib/services/draftFingerprint";
import { ApiError, apiPost, errorMessage } from "./lib/api";
import type { CaseView } from "./lib/claim";
import { eur, fmtDate, fmtTs, SENT_VIA_LABEL, STEP_LABEL, STEP_STATUS_LABEL } from "./lib/format";
import { letterForStep, whyNowLines } from "./lib/letter";
import type { StepRow } from "./lib/types";
import { GuardrailInspector } from "./GuardrailInspector";
import { Badge, Button, Card, cx, Notice } from "./ui";
import { useWorkspace } from "./WorkspaceProvider";

export function LetterPreview({ letter, startCollapsed = true }: { letter: Letter; startCollapsed?: boolean }) {
  const [open, setOpen] = useState(!startCollapsed);
  const long = letter.body.split("\n").length > 9;
  return (
    <div className="rounded-lg border border-line bg-surface-2 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">{letter.subject}</p>
        <Badge tone={letter.source === "ai" ? "ai" : "neutral"}>{letter.source === "ai" ? "AI wording, validated" : "Template"}</Badge>
      </div>
      <p className="mt-0.5 text-xs text-muted">
        In {letter.lang === "de" ? "German" : "English"}, dated {fmtDate(letter.virtualDate)}. Shown in the app only: no email is sent in the demo.
      </p>
      <pre className={cx("mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed", long && !open && "max-h-44 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]")}>{letter.body}</pre>
      {long && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-2 text-xs font-medium text-brand underline underline-offset-2">
          {open ? "Show less" : "Show full letter"}
        </button>
      )}
    </div>
  );
}

type Phase = "approving" | "sending" | "rejecting" | null;

function sendOutcome(res: { step?: StepRow; replayed?: boolean; fallback?: string; stateMoved?: boolean }): string {
  const via = res.step?.sent_via ? (SENT_VIA_LABEL[res.step.sent_via] ?? res.step.sent_via) : "recorded";
  const parts = [`Sent. Channel: ${via}.`];
  if (res.fallback === "quota_exhausted") parts.push("The PayPal sandbox reminder quota for today is used up, so the letter was stored in the app instead.");
  if (res.fallback === "paypal_limit") parts.push("PayPal refused another reminder today, so the letter was stored in the app instead.");
  if (res.stateMoved) parts.push("The case had already moved on (payment or dispute), so its state was left to the reconciler.");
  if (res.replayed) parts.push("This step had already been sent.");
  return parts.join(" ");
}

export function StepCard({ step, view, showCaseLink = false, onActed }: { step: StepRow; view: CaseView | undefined; showCaseLink?: boolean; onActed?: (id: string) => void }) {
  const { data, virtualDate, readOnly, refresh } = useWorkspace();
  const [phase, setPhase] = useState<Phase>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [why, setWhy] = useState(false);
  const [aiWhy, setAiWhy] = useState<{ state: "idle" | "loading" | "ok" | "unavailable" | "error"; text?: string }>({ state: "idle" });

  const letter = letterForStep(step, view, data.creditor, virtualDate);
  const claim = view?.claim;
  const factClaim = (step.facts as { claim?: { totalDueCents?: unknown } }).claim;
  const amount =
    step.kind === "fee_invoice"
      ? Number((step.facts as Record<string, unknown>).totalCents ?? 0)
      : step.status === "sent"
        ? typeof factClaim?.totalDueCents === "number" ? factClaim.totalDueCents : 0
        : claim?.totalDueCents ?? 0;

  async function execute() {
    setPhase("sending");
    try {
      const res = await apiPost<{ step: StepRow; replayed: boolean; fallback?: string; stateMoved?: boolean }>(`/api/steps/${step.id}/execute`, {});
      setDone(sendOutcome(res));
    } catch (err) {
      setError(`Approved, but not sent yet. ${errorMessage(err)} You can retry the send.`);
    }
  }

  async function approveAndExecute() {
    setError(null);
    setDone(null);
    setPhase("approving");
    try {
      await apiPost(`/api/steps/${step.id}/approve`, { draftFingerprint: draftFingerprint(step.draft, step.validation) });
    } catch (err) {
      setError(errorMessage(err));
      setPhase(null);
      return;
    }
    onActed?.(step.id);
    await execute();
    setPhase(null);
    await refresh();
  }

  async function retrySend() {
    setError(null);
    onActed?.(step.id);
    await execute();
    setPhase(null);
    await refresh();
  }

  async function reject() {
    setError(null);
    setDone(null);
    setPhase("rejecting");
    try {
      await apiPost(`/api/steps/${step.id}/reject`, {});
      onActed?.(step.id);
      setDone("Rejected. The rules engine will not propose this stage again until the virtual date moves on.");
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPhase(null);
    }
  }

  const [redrafting, setRedrafting] = useState(false);
  async function redraft() {
    setRedrafting(true);
    setError(null);
    setDone(null);
    try {
      const res = await apiPost<{ source?: string; fallbackReason?: string | null }>(`/api/steps/${step.id}/draft`, {});
      setDone(res.source === "ai" ? "New AI wording drafted and validated. Review it before approving." : "The AI draft was not usable, so the deterministic template stays in place.");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError && err.missing ? "AI drafting is not available: the AI is not configured on this server." : errorMessage(err));
    } finally {
      setRedrafting(false);
    }
  }

  async function toggleWhy() {
    const next = !why;
    setWhy(next);
    if (next && aiWhy.state === "idle") {
      setAiWhy({ state: "loading" });
      try {
        const res = (await apiPost(`/api/steps/${step.id}/explain`, {})) as Record<string, unknown> | null;
        const text = [res?.text, res?.explanation, res?.answer, res?.message].find((v): v is string => typeof v === "string" && v.trim() !== "");
        setAiWhy(text ? { state: "ok", text } : { state: "unavailable" });
      } catch (err) {
        setAiWhy({ state: err instanceof ApiError && err.missing ? "unavailable" : "error", text: err instanceof Error ? err.message : undefined });
      }
    }
  }

  const statusTone = step.status === "sent" ? "brand" : step.status === "failed" ? "danger" : step.status === "rejected" ? "neutral" : step.status === "approved" ? "warn" : "ai";
  const busy = phase !== null;

  return (
    <Card as="article" className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{STEP_LABEL[step.kind]}</h3>
            <Badge tone={statusTone}>{STEP_STATUS_LABEL[step.status]}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted">
            {view?.debtor?.name ?? "Debtor"} · invoice <span className="font-mono">{view?.invoice.number ?? "?"}</span>
            {showCaseLink && view && (
              <>
                {" "}
                ·{" "}
                <Link className="text-brand underline underline-offset-2" href={`/w/${data.workspace.id}/cases/${view.c.id}`}>
                  open case
                </Link>
              </>
            )}
          </p>
        </div>
        {amount > 0 && (
          <div className="text-right">
            <p className="text-xs font-medium text-muted">{step.kind === "fee_invoice" ? "To invoice" : "Owed in letter"}</p>
            <p className="num font-mono text-lg font-semibold">{eur(amount)}</p>
          </div>
        )}
      </div>

      {letter ? (
        <div className="mt-4">
          <LetterPreview letter={letter} startCollapsed={step.status === "proposed" || step.status === "approved"} />
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted">No letter attached to this step.</p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={toggleWhy} aria-expanded={why}>
          Why now
        </Button>
        <GuardrailInspector step={step} letter={letter} />
        {step.status === "proposed" && step.kind !== "fee_invoice" && step.kind !== "close" && (
          <Button size="sm" loading={redrafting} disabled={readOnly || busy} onClick={redraft} title="Ask the AI for new wording. Amounts stay engine-made.">
            Redraft wording
          </Button>
        )}
        <span className="text-xs text-muted">Created {fmtTs(step.created_at)}</span>
      </div>

      {why && (
        <div className="mt-3 space-y-2 rounded-lg border border-line p-3 text-sm">
          <p className="text-xs font-medium text-muted">Rules engine facts</p>
          <ul className="list-disc space-y-1 pl-5">
            {whyNowLines(step, view, virtualDate).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          {aiWhy.state === "loading" && <p className="text-xs text-muted">Asking for a plain-language explanation...</p>}
          {aiWhy.state === "ok" && (
            <div className="rounded-md bg-ai-soft p-3">
              <Badge tone="ai">AI wording, checked against the facts</Badge>
              <p className="mt-2 whitespace-pre-wrap">{aiWhy.text}</p>
            </div>
          )}
          {aiWhy.state === "unavailable" && <p className="text-xs text-muted">The AI explanation is not available in this deployment. The facts above come straight from the rules engine.</p>}
          {aiWhy.state === "error" && <p className="text-xs text-muted">The AI explanation failed ({aiWhy.text}). The facts above come straight from the rules engine.</p>}
        </div>
      )}

      {step.status === "proposed" && (
        <div className="mt-4 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" loading={phase === "approving" || phase === "sending"} disabled={readOnly || busy} onClick={approveAndExecute}>
              {phase === "sending" ? "Sending..." : "Approve and execute"}
            </Button>
            <Button variant="danger" loading={phase === "rejecting"} disabled={readOnly || busy} onClick={reject}>
              Reject
            </Button>
            <p className="text-xs text-muted">{readOnly ? "Disabled in a read-only workspace." : "Nothing is sent unless you click Approve and execute."}</p>
          </div>
        </div>
      )}
      {step.status === "approved" && (
        <div className="mt-4 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" loading={phase === "sending"} disabled={readOnly || busy} onClick={retrySend}>
              Send now
            </Button>
            <Button variant="danger" loading={phase === "rejecting"} disabled={readOnly || busy} onClick={reject}>
              Reject
            </Button>
            <p className="text-xs text-muted">Approved by you but not sent yet. Retrying is safe: a step is sent at most once.</p>
          </div>
        </div>
      )}
      {step.status === "sent" && (
        <p className="mt-4 border-t border-line pt-3 text-sm text-brand">
          Sent {step.sent_at ? fmtTs(step.sent_at) : ""}
          {step.sent_via ? `. Channel: ${SENT_VIA_LABEL[step.sent_via] ?? step.sent_via}.` : "."}
        </p>
      )}
      {step.status === "rejected" && <p className="mt-4 border-t border-line pt-3 text-sm text-muted">Rejected by you. Nothing was sent.</p>}
      {step.status === "failed" && <p className="mt-4 border-t border-line pt-3 text-sm text-danger">This step failed and nothing was sent. The engine can propose it again.</p>}

      {error && (
        <Notice tone="danger" className="mt-3" title="Action failed">
          {error}
        </Notice>
      )}
      {done && (
        <Notice tone="brand" className="mt-3">
          {done}
        </Notice>
      )}
    </Card>
  );
}
