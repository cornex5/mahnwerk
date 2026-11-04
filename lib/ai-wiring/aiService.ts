// AI features on top of the service layer. Each function checks who may call it, binds the workspace
// id from the stored row (never from model output) and returns plain data. Nothing here executes an
// action from model output: drafts only fill a proposed step, explanations are text, a reply
// classification is an audit row, and copilot proposals go through the normal proposal rules and
// still wait for a human approval.

import { createHash } from "node:crypto";
import { z } from "zod";
import { classifyReply, MAX_REPLY_CHARS, type NextStepLabel, type ReplyCategory } from "../ai/classifyReply";
import { askMahnwerk } from "../ai/copilot";
import { explainFactsFromCalc, explainStep } from "../ai/explain";
import type { ProposableStepKind } from "../ai/ports";
import { DE_RULESET } from "../rules/de";
import { claimAt, isDunningKind, planNextStage } from "../services/claims";
import type { AiServices, ServiceDeps } from "../services/context";
import { loadMutableWorkspace, loadWorkspace, virtualDateFor } from "../services/context";
import { GoldenReadOnlyError, ServiceError } from "../services/errors";
import { generateStepDraft, type DraftOutcome } from "../services/stepDraft";
import type { FullStepRow, WorkspaceRow } from "../services/store";
import { ServiceCopilotStore } from "./serviceCopilotStore";

export const CopilotBody = z.strictObject({ question: z.string().trim().min(1).max(2000) });
export const ReplyBody = z.strictObject({ text: z.string().trim().min(1).max(MAX_REPLY_CHARS) });

function requireAi(deps: ServiceDeps): AiServices {
  if (!deps.ai) throw new ServiceError("ai_unavailable", "The AI assistant is not configured on this server");
  return deps.ai;
}

/** Owner of a real or demo workspace, or anyone for the golden workspace (read-only use only). */
async function loadReadableWorkspace(deps: ServiceDeps, workspaceId: string, actorUid: string): Promise<WorkspaceRow> {
  const ws = await loadWorkspace(deps, workspaceId);
  if (ws.kind === "golden") return ws;
  return loadMutableWorkspace(deps, workspaceId, actorUid);
}

// ------------------------------------------------------------------ draft

export interface RedraftResult {
  step: FullStepRow;
  source: "ai" | "template";
  /** Why the template is used when source is "template". */
  fallbackReason: Exclude<DraftOutcome, { status: "ai" }>["reason"] | null;
}

const REDRAFT_TIMEOUT_MS = 40_000;

/** Regenerates the letter draft of a step that is still proposed. Falls back to the template on any AI problem. */
export async function redraftStep(deps: ServiceDeps, actorUid: string, stepId: string): Promise<RedraftResult> {
  const step = await deps.store.getStep(stepId);
  if (!step) throw new ServiceError("not_found", "Step not found");
  await loadMutableWorkspace(deps, step.workspace_id, actorUid);
  if (step.status !== "proposed") throw new ServiceError("conflict", `Only a proposed step can be redrafted (status is ${step.status})`);
  if (!isDunningKind(step.kind)) throw new ServiceError("invalid_input", `A ${step.kind} step has no letter draft`);
  requireAi(deps);
  // An explicit redraft may wait longer than the automatic draft made while a step is proposed.
  const outcome = await generateStepDraft(deps, stepId, { timeoutMs: deps.ai?.draftTimeoutMs ?? REDRAFT_TIMEOUT_MS });
  if (outcome.status === "template" && outcome.reason === "not_proposed") throw new ServiceError("conflict", "The step changed while drafting");
  const fresh = (await deps.store.getStep(stepId)) as FullStepRow;
  return outcome.status === "ai" ? { step: fresh, source: "ai", fallbackReason: null } : { step: fresh, source: "template", fallbackReason: outcome.reason };
}

// ------------------------------------------------------------------ explain

export interface ExplainOutput {
  text: string;
  source: "ai" | "template";
}

/** Plain-language reason for a step (read only). */
export async function explainStepFor(deps: ServiceDeps, actorUid: string, stepId: string): Promise<ExplainOutput> {
  const ai = requireAi(deps);
  const step = await deps.store.getStep(stepId);
  if (!step) throw new ServiceError("not_found", "Step not found");
  const ws = await loadReadableWorkspace(deps, step.workspace_id, actorUid);
  const c = await deps.store.getCase(step.case_id);
  const inv = c ? await deps.store.getFullInvoice(c.invoice_id) : null;
  const claimFacts = inv ? await deps.store.getClaimFacts(inv.id) : null;
  const debtor = inv ? await deps.store.getDebtor(inv.debtor_id) : null;
  if (!c || !inv || !claimFacts || !debtor) throw new ServiceError("not_found", "Case data not found");

  const today = virtualDateFor(ws, deps.now());
  const calc = claimAt(inv, claimFacts, await deps.store.listLedger(inv.id), today);
  const siblings = await deps.store.listSteps(c.id);
  const previous = siblings.filter((s) => s.id !== step.id && s.status === "sent" && isDunningKind(s.kind)).at(-1);
  const plan = planNextStage({ state: c.state, dueDate: inv.due_date, lastStepDate: await deps.store.lastStepTransitionDate(c.id), virtualDate: today, holdUntil: c.hold_until });
  const facts = explainFactsFromCalc(calc, {
    stepKind: step.kind as ProposableStepKind,
    lang: debtor.lang,
    debtorType: debtor.type,
    today,
    dueDate: inv.due_date,
    previousStepKind: (previous?.kind as ProposableStepKind | undefined) ?? null,
    previousStepDate: previous ? await deps.store.lastStepTransitionDate(c.id) : null,
    earliestDate: isDunningKind(step.kind) && plan.kind === step.kind ? plan.earliestDate : null,
    waitingDays: isDunningKind(step.kind) ? DE_RULESET.waitingDays[step.kind] : null,
  });
  const r = await explainStep(facts, { gateway: ai.gateway, ctx: { workspaceId: step.workspace_id, stepId: step.id } });
  return { text: r.text, source: r.source };
}

// ------------------------------------------------------------------ copilot

export interface CopilotOutput {
  answer: string;
  toolCalls: { name: string; ok: boolean }[];
  proposedStepIds: string[];
}

/** Question to the copilot. The golden workspace may be queried but never changed (propose_step is refused). */
export async function askCopilot(deps: ServiceDeps, actorUid: string, workspaceId: string, question: string): Promise<CopilotOutput> {
  const ai = requireAi(deps);
  const ws = await loadReadableWorkspace(deps, workspaceId, actorUid);
  const store = new ServiceCopilotStore(deps, { workspaceId: ws.id, readOnly: ws.kind === "golden" });
  const r = await askMahnwerk(question, { gateway: ai.gateway, ctx: { workspaceId: ws.id }, store });
  return { answer: r.answer, toolCalls: r.toolCalls.map((t) => ({ name: t.name, ok: t.ok })), proposedStepIds: r.proposedStepIds };
}

// ------------------------------------------------------------------ reply classification

export interface ReplyClassification {
  category: ReplyCategory;
  rationale: string;
  suggestedNextStep: NextStepLabel;
  injectionSuspected: boolean;
  source: "ai" | "fallback";
}

/**
 * Classifies a debtor reply and records it as an audit row (actor ai, action reply.classified).
 * It never changes the case or any step: the suggested next step is a label for the human.
 * The audit row stores a hash and the length of the reply, not its text.
 */
export async function classifyCaseReply(deps: ServiceDeps, actorUid: string, caseId: string, text: string): Promise<ReplyClassification> {
  const ai = requireAi(deps);
  const c = await deps.store.getCase(caseId);
  if (!c) throw new ServiceError("not_found", "Case not found");
  const ws = await loadMutableWorkspace(deps, c.workspace_id, actorUid);
  if (ws.kind === "golden") throw new GoldenReadOnlyError();

  const r = await classifyReply(text, { gateway: ai.gateway, ctx: { workspaceId: c.workspace_id } });
  await deps.store.insertAudit({
    workspace_id: c.workspace_id,
    case_id: c.id,
    invoice_id: c.invoice_id,
    actor: "ai",
    action: "reply.classified",
    virtual_date: virtualDateFor(ws, deps.now()),
    details: {
      category: r.category,
      rationale: r.rationale,
      suggested_next_step: r.suggestedNextStep,
      injection_suspected: r.injectionSuspected,
      source: r.source,
      reply_chars: text.length,
      reply_sha256: createHash("sha256").update(text).digest("hex"),
      requested_by: actorUid,
    },
  });
  return { category: r.category, rationale: r.rationale, suggestedNextStep: r.suggestedNextStep, injectionSuspected: r.injectionSuspected, source: r.source };
}
