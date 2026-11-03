"use client";

import { useState } from "react";
import type { Letter } from "@/lib/services/letters";
import { Badge, Button, Dialog, Notice } from "./ui";
import type { StepRow } from "./lib/types";

interface CheckItem {
  name: string;
  passed: boolean | null;
}

function toChecks(v: unknown): CheckItem[] {
  if (Array.isArray(v)) {
    return v.map((c, i): CheckItem => {
      if (typeof c === "string") return { name: c, passed: true };
      const o = (c ?? {}) as Record<string, unknown>;
      return { name: String(o.name ?? o.check ?? o.id ?? `check ${i + 1}`), passed: typeof o.passed === "boolean" ? o.passed : typeof o.ok === "boolean" ? o.ok : null };
    });
  }
  if (v && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>).map(([name, val]) => ({ name, passed: typeof val === "boolean" ? val : null }));
  }
  return [];
}

const POLICY = [
  "Every amount, date, number, link and name in an AI draft must be a placeholder that code fills from the rules engine.",
  "Digits and numbers written as words are rejected, so the model cannot invent or alter a figure.",
  "Legal citations must match the ones the rules engine supplied, character for character.",
  "The draft must be in the debtor's language and must not threaten, promise discounts, waive anything or mention credit bureaus.",
  "If the AI draft fails validation twice, the deterministic template is used instead. Amounts always come from the rules engine.",
];

export function GuardrailInspector({ step, letter }: { step: StepRow; letter: Letter | null }) {
  const [open, setOpen] = useState(false);
  const v = step.validation;
  const issues = Array.isArray(v?.issues) ? (v.issues as unknown[]).map(String) : [];
  const passed = typeof v?.passed === "boolean" ? (v.passed as boolean) : null;
  const explicitSource = typeof step.draft?.source === "string" ? (step.draft.source as string) : typeof v?.source === "string" ? (v.source as string) : null;
  const source = explicitSource ?? letter?.source ?? "template";
  const checks = toChecks(v?.checks);
  const rawAi = v?.ai_issues ?? v?.aiIssues;
  const aiIssues = Array.isArray(rawAi) ? (rawAi as unknown[]).map(String) : [];
  const reason = typeof v?.reason === "string" ? (v.reason as string) : null;
  const attempts = typeof v?.attempts === "number" ? (v.attempts as number) : null;
  const REASON: Record<string, string> = {
    no_ai: "the AI is not configured",
    quota_exhausted: "the AI budget is used up",
    validation_failed: "the AI draft failed validation twice",
    model_error: "the model call failed",
    timeout: "the model call timed out",
    error: "drafting failed",
  };

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Guardrail inspector
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Guardrail inspector" side>
        <div className="space-y-5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted">Wording source</span>
            {source === "ai" ? <Badge tone="ai">AI draft</Badge> : <Badge tone="neutral">Deterministic template</Badge>}
            <span className="text-muted">Validation</span>
            {passed === null ? <Badge>not recorded yet</Badge> : passed ? <Badge tone="brand">passed</Badge> : <Badge tone="danger">failed</Badge>}
          </div>

          {reason && (
            <Notice tone="warn" title="Template fallback">
              The deterministic template is used because {REASON[reason] ?? reason}. Amounts and citations are engine-made either way.
            </Notice>
          )}
          {attempts !== null && <p className="text-muted">AI attempts needed: {attempts}</p>}

          {v === null && (
            <Notice tone="info">
              No validation is stored on this step yet. Without a passed validation the letter falls back to the deterministic template, so amounts and citations are always engine-made.
            </Notice>
          )}

          {checks.length > 0 && (
            <section>
              <h3 className="mb-2 font-semibold">Checks</h3>
              <ul className="space-y-1.5">
                {checks.map((c) => (
                  <li key={c.name} className="flex items-start gap-2">
                    <span aria-hidden="true" className={c.passed === false ? "text-danger" : "text-brand"}>
                      {c.passed === false ? "x" : c.passed === null ? "-" : "ok"}
                    </span>
                    <span>{c.name}</span>
                    <span className="sr-only">{c.passed === false ? "failed" : c.passed === null ? "no result" : "passed"}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 className="mb-2 font-semibold">Issues</h3>
            {issues.length === 0 && aiIssues.length === 0 ? (
              <p className="text-muted">No issues recorded.</p>
            ) : (
              <ul className="list-disc space-y-1 pl-5">
                {[...issues, ...aiIssues.map((i) => `Earlier AI attempt: ${i}`)].map((i, n) => (
                  <li key={n} className="break-words">
                    {i}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="mb-2 font-semibold">What the guardrails enforce</h3>
            <ul className="list-disc space-y-1 pl-5 text-muted">
              {POLICY.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </section>

          {v && (
            <details>
              <summary className="cursor-pointer font-medium">Raw validation record</summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-xs">{JSON.stringify(v, null, 2)}</pre>
            </details>
          )}
        </div>
      </Dialog>
    </>
  );
}
