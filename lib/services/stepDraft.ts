// AI letter drafts for proposed dunning steps. The draft is generated after the step row exists, so
// a slow or failing model can never block a proposal. Whatever happens, the step keeps working: when
// no validated AI draft is stored, execution falls back to the template in letters.ts.

import { draftLetter, type DraftResult } from "../ai/draft";
import type { LetterFacts as AiLetterFacts, LetterKind as AiLetterKind } from "../ai/letterFacts";
import { letterFactsFromCalc } from "../ai/letterFacts";
import { addDays } from "../rules/dates";
import { claimAt, isDunningKind, type DunningKind } from "./claims";
import { DEADLINE_DAYS, draftBasisOf, type DraftBasis } from "./draftBasis";
import type { ServiceDeps } from "./context";
import { virtualDateFor } from "./context";
import { ServiceError } from "./errors";
import { safeMessage } from "./paypalErrors";
import type { FullCaseRow, FullInvoiceRow, FullStepRow, WorkspaceRow } from "./store";

export { DEADLINE_DAYS, draftBasisOf };
export type { DraftBasis };

export const DEFAULT_DRAFT_TIMEOUT_MS = 30_000;

const AI_KIND: Record<DunningKind, AiLetterKind> = { reminder: "reminder", mahnung1: "mahnung1", mahnung2: "mahnung2", handover: "handover_notice" };

/** True when the draft carries no basis (hand-written, older) or its basis equals the current one. */
export function draftBasisMatches(draft: Record<string, unknown> | null, current: DraftBasis): boolean {
  const b = draft?.generated_for as Partial<DraftBasis> | undefined;
  if (!b) return true;
  return (
    b.virtual_date === current.virtual_date &&
    b.principal_cents === current.principal_cents &&
    b.interest_cents === current.interest_cents &&
    b.fee_cents === current.fee_cents &&
    b.total_cents === current.total_cents
  );
}

export interface StepAiContext {
  step: FullStepRow;
  c: FullCaseRow;
  inv: FullInvoiceRow;
  ws: WorkspaceRow;
  kind: DunningKind;
  virtualDate: string;
  lang: "de" | "en";
  facts: AiLetterFacts;
}

function payLinkFor(deps: ServiceDeps, paypalInvoiceId: string): string {
  const host = deps.paypal.env === "sandbox" ? "www.sandbox.paypal.com" : "www.paypal.com";
  return `https://${host}/invoice/p/#${encodeURIComponent(paypalInvoiceId)}`;
}

/** Letter facts for the AI layer, straight from the rules engine at the workspace's virtual date. */
export async function stepAiContext(deps: ServiceDeps, step: FullStepRow): Promise<StepAiContext> {
  if (!isDunningKind(step.kind)) throw new ServiceError("invalid_input", `A ${step.kind} step has no letter draft`);
  const c = await deps.store.getCase(step.case_id);
  const inv = c ? await deps.store.getFullInvoice(c.invoice_id) : null;
  const ws = await deps.store.getWorkspace(step.workspace_id);
  if (!c || !inv || !ws) throw new ServiceError("not_found", "Case, invoice or workspace not found");
  const claimFacts = await deps.store.getClaimFacts(inv.id);
  if (!claimFacts) throw new ServiceError("internal", "Claim facts missing for invoice");
  const ledger = await deps.store.listLedger(inv.id);
  const debtor = await deps.store.getDebtor(inv.debtor_id);
  const creditor = await deps.store.getCreditorForWorkspace(inv.workspace_id);
  if (!debtor || !creditor || !inv.paypal_invoice_id) throw new ServiceError("internal", "Debtor, creditor or PayPal invoice missing");
  const virtualDate = virtualDateFor(ws, deps.now());
  const calc = claimAt(inv, claimFacts, ledger, virtualDate);
  const facts = letterFactsFromCalc(calc, {
    kind: AI_KIND[step.kind],
    debtorType: debtor.type,
    creditorName: creditor.name,
    debtorName: debtor.name,
    invoiceNumber: inv.number ?? inv.id,
    deadline: addDays(virtualDate, DEADLINE_DAYS[step.kind]),
    payLink: payLinkFor(deps, inv.paypal_invoice_id),
  });
  return { step, c, inv, ws, kind: step.kind, virtualDate, lang: debtor.lang, facts };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`AI draft timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export type DraftOutcome =
  | { status: "ai"; draft: Record<string, unknown> }
  | { status: "template"; reason: "no_ai" | "quota_exhausted" | "validation_failed" | "model_error" | "timeout" | "error" | "not_proposed"; issues: string[] };

/**
 * Generates a draft for a proposed dunning step and stores draft plus validation on it. Never throws
 * for AI problems (they come back as a "template" outcome); only unknown steps raise not_found.
 * With force=false an existing validated AI draft is kept. A fallback never overwrites a stored AI draft.
 */
export async function generateStepDraft(deps: ServiceDeps, stepId: string, opts: { keepExisting?: boolean; timeoutMs?: number } = {}): Promise<DraftOutcome> {
  if (!deps.ai) return { status: "template", reason: "no_ai", issues: [] };
  const step = await deps.store.getStep(stepId);
  if (!step) throw new ServiceError("not_found", "Step not found");
  if (step.status !== "proposed") return { status: "template", reason: "not_proposed", issues: [] };
  if (opts.keepExisting && step.draft && step.validation?.passed === true) return { status: "ai", draft: step.draft };

  let result: DraftResult | null = null;
  let ctx: StepAiContext | null = null;
  let failure: { reason: "timeout" | "error"; message: string } | null = null;
  try {
    ctx = await stepAiContext(deps, step);
    const gateway = deps.ai.gateway;
    result = await withTimeout(
      draftLetter(ctx.facts, ctx.lang, { gateway, ctx: { workspaceId: step.workspace_id, stepId: step.id } }),
      opts.timeoutMs ?? deps.ai.draftTimeoutMs ?? DEFAULT_DRAFT_TIMEOUT_MS,
    );
  } catch (err) {
    const message = safeMessage(err);
    failure = { reason: /timed out/.test(message) ? "timeout" : "error", message };
  }

  if (result && result.source === "ai" && ctx) {
    const draft: Record<string, unknown> = {
      subject: result.subject,
      body: result.text,
      lang: ctx.lang,
      source: "ai",
      reviewer_note: result.reviewerNote,
      generated_for: draftBasisOf(ctx.facts, ctx.virtualDate),
      // The validated draft with placeholders, kept so example letters can be rebuilt with other figures.
      raw: result.rawDraft,
    };
    const validation = { passed: true, issues: [] as string[], attempts: result.attempts, ai_issues: result.aiIssues };
    const stored = await deps.store.setStepDraft(step.id, draft, validation).catch(() => false);
    return stored ? { status: "ai", draft } : { status: "template", reason: "not_proposed", issues: [] };
  }

  const reason: Extract<DraftOutcome, { status: "template" }>["reason"] = failure
    ? failure.reason
    : result?.quotaExhausted
      ? "quota_exhausted"
      : result?.aiIssues.includes("model_error")
        ? "model_error"
        : "validation_failed";
  const issues = failure ? [failure.message] : (result?.aiIssues ?? []);
  // Record why the template is used, but never replace an existing validated draft with that note.
  if (!(step.draft && step.validation?.passed === true)) {
    await deps.store.setStepDraft(step.id, null, { passed: false, fallback: "template", reason, issues }).catch(() => false);
  }
  return { status: "template", reason, issues };
}
