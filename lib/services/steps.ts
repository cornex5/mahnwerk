// Dunning steps: proposal (rules engine + state machine), human approval and rejection, and
// execution of approved steps. Nothing outbound ever happens without a recorded approval.
//
// Execution channels (demo decision by the owner: no real email, letters are shown in the app):
// - reminder: PayPal send-reminder while the api_quota allows it (sandbox: 2 per day per API
//   caller, atomic increment); otherwise an in-app letter (sent_via 'none').
// - mahnung1, mahnung2, handover: in-app letter stored on the step (sent_via 'none').
// - fee_invoice (proposed by the reconciler on a paid case with interest or fee still owed): a
//   separate PayPal sandbox invoice for interest and fee (sent_via 'paypal_invoice'). Mahnung 2
//   itself does not create one (PROJECT_STATE: the fee invoice is its own approved step).

import { isClosed, transition, type CaseSnapshot } from "../cases/stateMachine";
import { centsToMoney } from "../paypal/money";
import { PayPalApiError, PayPalSchemaError } from "../paypal/client";
import { GoldenReadOnlyError, ServiceError } from "./errors";
import {
  assertSandbox,
  limitsOf,
  loadMutableWorkspace,
  loadWorkspace,
  newId,
  realToday,
  virtualDateFor,
  type ServiceDeps,
} from "./context";
import { STEP_SPECS, claimAt, isDunningKind, planNextStage, type DunningKind, type StagePlan } from "./claims";
import { draftFingerprint } from "./draftFingerprint";
import { letterFor, templateLetter, type Letter, type LetterFacts } from "./letters";
import { draftBasisMatches, generateStepDraft } from "./stepDraft";
import { isDefinitivePayPalFailure, payPalIssue, safeMessage } from "./paypalErrors";
import type { FullCaseRow, FullInvoiceRow, FullStepRow, WorkspaceRow } from "./store";

const MAX_CAS = 3;

// ------------------------------------------------------------------ approval gate

/** The single gate in front of every outbound action. Throws unless the step carries a human approval. */
export function assertApproved(step: Pick<FullStepRow, "id" | "status" | "approved_by" | "approved_at">): void {
  if (step.status !== "approved" || !step.approved_by || !step.approved_at) {
    throw new ServiceError("not_approved", `Step ${step.id} is not approved`, { status: step.status });
  }
}

// ------------------------------------------------------------------ proposal

export interface ProposalResult {
  caseId: string;
  plan: StagePlan;
  step: FullStepRow | null;
  created: boolean;
}

async function caseContext(deps: ServiceDeps, caseId: string) {
  const c = await deps.store.getCase(caseId);
  if (!c) throw new ServiceError("not_found", "Case not found");
  const inv = await deps.store.getFullInvoice(c.invoice_id);
  if (!inv) throw new ServiceError("not_found", "Invoice not found");
  const ws = await loadWorkspace(deps, c.workspace_id);
  return { c, inv, ws };
}

async function becomeOverdue(deps: ServiceDeps, c: FullCaseRow, virtualDate: string): Promise<FullCaseRow> {
  let cur = c;
  for (let i = 0; i < MAX_CAS; i++) {
    if (cur.state !== "open") return cur;
    const next = transition({ state: cur.state, resumeState: cur.prev_state, pausedReason: cur.paused_reason }, { type: "became_overdue" });
    const ok = await deps.store.transitionCase({
      caseId: cur.id,
      expectedVersion: cur.version,
      fromState: cur.state,
      toState: next.state,
      prevState: next.resumeState,
      pausedReason: next.pausedReason,
      actor: "system",
      action: "case.became_overdue",
      virtualDate,
      details: {},
    });
    cur = (await deps.store.getCase(cur.id)) as FullCaseRow;
    if (ok) return cur;
  }
  throw new ServiceError("conflict", "Case changed concurrently");
}

async function stepFacts(deps: ServiceDeps, kind: DunningKind, inv: FullInvoiceRow, virtualDate: string, plan: StagePlan) {
  const facts = await deps.store.getClaimFacts(inv.id);
  if (!facts) throw new ServiceError("internal", "Claim facts missing for invoice");
  const ledger = await deps.store.listLedger(inv.id);
  const claim = claimAt(inv, facts, ledger, virtualDate);
  const debtor = await deps.store.getDebtor(inv.debtor_id);
  const creditor = await deps.store.getCreditorForWorkspace(inv.workspace_id);
  return {
    kind,
    virtualDate,
    earliestDate: plan.earliestDate,
    invoice: { id: inv.id, number: inv.number, principalCents: inv.principal_cents, dueDate: inv.due_date, issueDate: inv.issue_date },
    debtor: debtor ? { name: debtor.name, type: debtor.type, lang: debtor.lang } : null,
    creditor: creditor ? { name: creditor.name, kleinunternehmer: creditor.kleinunternehmer } : null,
    claim: {
      inDefault: claim.inDefault,
      defaultStart: claim.defaultStart,
      defaultRule: claim.defaultRule,
      openPrincipalCents: claim.openPrincipalCents,
      openInterestCents: claim.openInterestCents,
      openFeeCents: claim.openFeeCents,
      totalDueCents: claim.totalDueCents,
      interestAccruedCents: claim.interestAccruedCents,
      citation: claim.citation,
    },
  };
}

/**
 * Brings one case up to date at its workspace's virtual date: open -> overdue when the due date
 * has passed (system transition), then proposes the next stage when its waiting days are over.
 * Idempotent: an existing pending step is returned instead of a new one. A stage rejected by a
 * human is not proposed again until the virtual date moves past the rejection.
 */
export async function proposeNextStep(deps: ServiceDeps, caseId: string): Promise<ProposalResult> {
  const ctx = await caseContext(deps, caseId);
  if (ctx.ws.kind === "golden") throw new GoldenReadOnlyError();
  const virtualDate = virtualDateFor(ctx.ws, deps.now());
  let c = ctx.c;
  const lastStepDate = await deps.store.lastStepTransitionDate(c.id);
  let plan = planNextStage({ state: c.state, dueDate: ctx.inv.due_date, lastStepDate, virtualDate });
  if (plan.becomesOverdue) {
    c = await becomeOverdue(deps, c, virtualDate);
    plan = planNextStage({ state: c.state, dueDate: ctx.inv.due_date, lastStepDate, virtualDate });
  }
  if (!plan.kind || !plan.dueNow) return { caseId, plan, step: null, created: false };

  const steps = await deps.store.listSteps(c.id);
  const pending = steps.find((s) => isDunningKind(s.kind) && (s.status === "proposed" || s.status === "approved"));
  if (pending) return { caseId, plan, step: pending, created: false };
  const rejected = steps
    .filter((s) => s.kind === plan.kind && s.status === "rejected")
    .some((s) => typeof s.validation?.rejected_virtual_date === "string" && (s.validation.rejected_virtual_date as string) >= virtualDate);
  if (rejected) return { caseId, plan, step: null, created: false };

  const facts = await stepFacts(deps, plan.kind, ctx.inv, virtualDate, plan);
  const ins = await deps.store.insertProposedStep({ workspace_id: c.workspace_id, case_id: c.id, kind: plan.kind, facts });
  if (ins.inserted && ins.step) {
    await deps.store.insertAudit({
      workspace_id: c.workspace_id,
      case_id: c.id,
      invoice_id: ctx.inv.id,
      actor: "system",
      action: "step.proposed",
      virtual_date: virtualDate,
      details: { step_id: ins.step.id, kind: plan.kind, total_due_cents: facts.claim.totalDueCents },
    });
    // Letter draft: best effort. The step already exists, so no AI problem can block the proposal;
    // without a validated draft the template letter is used at execution.
    let step = ins.step;
    try {
      const outcome = await generateStepDraft(deps, ins.step.id);
      if (outcome.status === "ai" || outcome.reason !== "no_ai") step = (await deps.store.getStep(ins.step.id)) ?? ins.step;
    } catch {
      // ignore: template fallback
    }
    return { caseId, plan, step, created: true };
  }
  return { caseId, plan, step: ins.step, created: ins.inserted };
}

/** Runs proposeNextStep for every active case of a workspace. */
export async function refreshProposals(deps: ServiceDeps, workspaceId: string): Promise<ProposalResult[]> {
  const ws = await loadWorkspace(deps, workspaceId);
  if (ws.kind === "golden") return [];
  const cases = await deps.store.listCases(workspaceId);
  const out: ProposalResult[] = [];
  for (const c of cases) {
    if (isClosed(c.state) || c.state === "paused_dispute" || c.state === "handover_ready") continue;
    out.push(await proposeNextStep(deps, c.id));
  }
  return out;
}

// ------------------------------------------------------------------ approve / reject

async function loadStepForMutation(deps: ServiceDeps, actorUid: string, stepId: string): Promise<{ step: FullStepRow; ws: WorkspaceRow }> {
  const step = await deps.store.getStep(stepId);
  if (!step) throw new ServiceError("not_found", "Step not found");
  const ws = await loadMutableWorkspace(deps, step.workspace_id, actorUid);
  return { step, ws };
}

export async function approveStep(
  deps: ServiceDeps,
  actorUid: string,
  stepId: string,
  opts: { draftFingerprint?: string } = {},
): Promise<{ step: FullStepRow; changed: boolean }> {
  const { step, ws } = await loadStepForMutation(deps, actorUid, stepId);
  // The approval covers the wording the person saw. If a new draft arrived meanwhile, ask again.
  if (opts.draftFingerprint && step.status === "proposed" && opts.draftFingerprint !== draftFingerprint(step.draft, step.validation)) {
    throw new ServiceError("conflict", "The wording of this letter changed while you were looking at it. Please read the new text and approve again.");
  }
  const r = await deps.store.decideStep({ stepId, decision: "approve", actorUid, virtualDate: virtualDateFor(ws, deps.now()), note: null });
  if (r === "not_found") throw new ServiceError("not_found", "Step not found");
  if (r.startsWith("invalid:")) {
    // A step that already went out was approved before: a late double click is not an error.
    const cur = (await deps.store.getStep(stepId)) as FullStepRow;
    if (cur.status === "sent") return { step: cur, changed: false };
    throw new ServiceError("conflict", `Step cannot be approved from status ${cur.status}`);
  }
  return { step: (await deps.store.getStep(stepId)) as FullStepRow, changed: r === "ok" };
}

export async function rejectStep(deps: ServiceDeps, actorUid: string, stepId: string, note?: string): Promise<{ step: FullStepRow; changed: boolean }> {
  const { ws } = await loadStepForMutation(deps, actorUid, stepId);
  const r = await deps.store.decideStep({
    stepId,
    decision: "reject",
    actorUid,
    virtualDate: virtualDateFor(ws, deps.now()),
    note: note?.trim().slice(0, 500) || null,
  });
  if (r === "not_found") throw new ServiceError("not_found", "Step not found");
  if (r.startsWith("invalid:")) throw new ServiceError("conflict", `Step cannot be rejected from status ${r.slice(8)}`);
  return { step: (await deps.store.getStep(stepId)) as FullStepRow, changed: r === "ok" };
}

// ------------------------------------------------------------------ execute

export interface ExecuteResult {
  step: FullStepRow;
  /** True when the step had already been sent by an earlier call (double click). */
  replayed: boolean;
  /** Set when the reminder quota was exhausted and an in-app letter was used instead. */
  fallback?: "quota_exhausted" | "paypal_limit";
  /** Set when the case had moved on (payment, dispute) between approval and sending. */
  stateMoved?: boolean;
}

async function letterFactsFor(deps: ServiceDeps, kind: LetterFacts["kind"], step: FullStepRow, inv: FullInvoiceRow, virtualDate: string): Promise<LetterFacts> {
  const debtor = await deps.store.getDebtor(inv.debtor_id);
  const creditor = await deps.store.getCreditorForWorkspace(inv.workspace_id);
  const facts = await deps.store.getClaimFacts(inv.id);
  const ledger = await deps.store.listLedger(inv.id);
  // Fee invoices use the amounts the human approved; Mahnungen use the claim at the sending date.
  const approved = step.facts as Record<string, number | undefined>;
  const claim = kind === "fee_invoice" || !facts ? null : claimAt(inv, facts, ledger, virtualDate);
  const total = approved.totalCents ?? 0;
  // Fee letter: show interest and fee by origin when they make up the total (see feeLines).
  const byOrigin = kind === "fee_invoice" && (approved.interestCents ?? 0) + (approved.feeCents ?? 0) === total;
  if (byOrigin) {
    return {
      kind,
      lang: debtor?.lang ?? "de",
      creditorName: creditor?.name ?? "Creditor",
      debtorName: debtor?.name ?? "Customer",
      invoiceNumber: inv.number ?? inv.id,
      virtualDate,
      dueDate: inv.due_date,
      openPrincipalCents: 0,
      openInterestCents: approved.interestCents ?? 0,
      openFeeCents: approved.feeCents ?? 0,
      totalDueCents: total,
    };
  }
  return {
    kind,
    lang: debtor?.lang ?? "de",
    creditorName: creditor?.name ?? "Creditor",
    debtorName: debtor?.name ?? "Customer",
    invoiceNumber: inv.number ?? inv.id,
    virtualDate,
    dueDate: inv.due_date,
    openPrincipalCents: claim ? claim.openPrincipalCents : (approved.openPrincipalCents ?? 0),
    openInterestCents: claim ? claim.openInterestCents : (approved.openInterestCents ?? 0),
    openFeeCents: claim ? claim.openFeeCents : (approved.openFeeCents ?? 0),
    totalDueCents: claim ? claim.totalDueCents : total,
  };
}

function isPayPalRateLimit(err: unknown): boolean {
  if (!(err instanceof PayPalApiError)) return false;
  if (err.status === 429) return true;
  return err.status === 422 && /LIMIT|QUOTA|RATE/i.test(err.issue ?? "");
}

export async function executeStep(deps: ServiceDeps, actorUid: string, stepId: string): Promise<ExecuteResult> {
  const { step, ws } = await loadStepForMutation(deps, actorUid, stepId);
  if (step.status === "sent") return { step, replayed: true };
  assertApproved(step);

  const token = newId(deps);
  const nowIso = new Date(deps.now()).toISOString();
  if (!(await deps.store.claimStepExecution(step.id, token, nowIso, limitsOf(deps).stepLeaseMs))) {
    const cur = (await deps.store.getStep(step.id)) as FullStepRow;
    if (cur.status === "sent") return { step: cur, replayed: true };
    throw new ServiceError("in_progress", "This step is being executed right now");
  }

  try {
    // Re-read under the lease: the approval must still be in place.
    const leased = (await deps.store.getStep(step.id)) as FullStepRow;
    assertApproved(leased);
    const c = await deps.store.getCase(leased.case_id);
    const inv = c ? await deps.store.getFullInvoice(c.invoice_id) : null;
    if (!c || !inv) throw new ServiceError("not_found", "Case or invoice not found");
    const virtualDate = virtualDateFor(ws, deps.now());

    if (leased.kind === "fee_invoice") return await executeFeeInvoice(deps, actorUid, leased, token, c, inv, virtualDate);
    if (!isDunningKind(leased.kind)) {
      await deps.store.failStep(leased.id, token, `step kind ${leased.kind} cannot be executed`, actorUid, virtualDate);
      throw new ServiceError("not_executable", `Step kind ${leased.kind} cannot be executed`);
    }
    return await executeDunningStep(deps, actorUid, leased, leased.kind, token, c, inv, virtualDate);
  } catch (err) {
    await deps.store.releaseStepExecution(step.id, token).catch(() => undefined);
    if (err instanceof ServiceError) throw err;
    const code = err instanceof PayPalApiError || err instanceof PayPalSchemaError ? "paypal_failed" : "internal";
    throw new ServiceError(code, "Step execution failed; it is still approved and can be retried", { error: safeMessage(err) });
  }
}

async function executeDunningStep(
  deps: ServiceDeps,
  actorUid: string,
  step: FullStepRow,
  kind: DunningKind,
  token: string,
  c0: FullCaseRow,
  inv: FullInvoiceRow,
  virtualDate: string,
): Promise<ExecuteResult> {
  const spec = STEP_SPECS[kind];
  if (isClosed(c0.state)) {
    await deps.store.failStep(step.id, token, `case is ${c0.state}`, actorUid, virtualDate);
    throw new ServiceError("not_executable", `The case is already ${c0.state}; the step was marked failed`);
  }
  if (c0.state !== spec.from) {
    throw new ServiceError("not_executable", `A ${kind} can only be sent from state ${spec.from} (case is ${c0.state})`);
  }
  const plan = planNextStage({ state: c0.state, dueDate: inv.due_date, lastStepDate: await deps.store.lastStepTransitionDate(c0.id), virtualDate });
  if (plan.kind !== kind || !plan.dueNow) {
    throw new ServiceError("not_executable", `The waiting period for ${kind} ends on ${plan.earliestDate}`);
  }

  const letterFacts = await letterFactsFor(deps, kind, step, inv, virtualDate);
  // An AI draft carries the amounts and date it was written for. If the claim moved since (interest,
  // payments, clock), the draft is stale and the template with current figures is used instead.
  const draftIsCurrent = draftBasisMatches(step.draft, {
    virtual_date: virtualDate,
    principal_cents: letterFacts.openPrincipalCents,
    interest_cents: letterFacts.openInterestCents,
    fee_cents: letterFacts.openFeeCents,
    total_cents: letterFacts.totalDueCents,
  });
  const letter: Letter = letterFor(letterFacts, draftIsCurrent ? step.draft : null, draftIsCurrent ? step.validation : null);

  // Channel decision. Recorded on the step before the outbound call, so a retry never consumes
  // quota twice and reuses the same PayPal-Request-Id.
  let sentVia: "paypal_remind" | "none" = "none";
  let fallback: ExecuteResult["fallback"];
  if (kind === "reminder") {
    if (step.sent_via === "paypal_remind" || step.sent_via === "none") {
      sentVia = step.sent_via;
    } else {
      assertSandbox(deps);
      const granted = await deps.store.consumeReminderQuota(deps.merchantId, realToday(deps.now()), limitsOf(deps).remindersPerDay);
      sentVia = granted ? "paypal_remind" : "none";
      if (!granted) fallback = "quota_exhausted";
      if (!(await deps.store.setStepSentVia(step.id, token, sentVia))) throw new ServiceError("in_progress", "Lost the execution lease");
    }
    if (sentVia === "paypal_remind") {
      assertSandbox(deps);
      assertApproved(step);
      if (!inv.paypal_invoice_id) throw new ServiceError("not_executable", "Invoice has no PayPal id");
      try {
        await deps.paypal.remindInvoice(
          inv.paypal_invoice_id,
          { subject: letter.subject.slice(0, 120), note: letter.body.slice(0, 4000), send_to_invoicer: false },
          { requestId: `mw-rm-${step.id}` },
        );
      } catch (err) {
        if (isPayPalRateLimit(err)) {
          sentVia = "none";
          fallback = "paypal_limit";
          await deps.store.setStepSentVia(step.id, token, "none");
        } else if (isDefinitivePayPalFailure(err)) {
          await deps.store.failStep(step.id, token, `PayPal rejected the reminder: ${payPalIssue(err) ?? safeMessage(err)}`, actorUid, virtualDate);
          throw new ServiceError("paypal_failed", "PayPal rejected the reminder; the step was marked failed", { issue: payPalIssue(err) ?? null });
        } else {
          throw err;
        }
      }
    }
  }

  const draft = { ...(step.draft ?? {}), letter, channel: sentVia === "paypal_remind" ? "paypal_reminder_and_in_app_letter" : "in_app_letter" };
  const details = { approved_by: step.approved_by, approved_at: step.approved_at, fallback: fallback ?? null, letter_source: letter.source, ...(draftIsCurrent ? {} : { draft_stale: true }) };

  let c = c0;
  for (let attempt = 0; attempt < MAX_CAS; attempt++) {
    if (c.state === spec.from) {
      const snap: CaseSnapshot = { state: c.state, resumeState: c.prev_state, pausedReason: c.paused_reason };
      const next = transition(snap, { type: spec.event, approvedStepId: step.id } as Parameters<typeof transition>[1]);
      const r = await deps.store.completeStep({
        stepId: step.id,
        execToken: token,
        sentVia,
        draft,
        actorUid,
        virtualDate,
        details,
        transition: {
          expectedVersion: c.version,
          fromState: c.state,
          toState: next.state,
          prevState: next.resumeState,
          pausedReason: next.pausedReason,
          actor: "user",
          action: `case.${spec.event}`,
          details: { step_id: step.id, sent_via: sentVia, approved_by: step.approved_by, actor_uid: actorUid },
        },
      });
      if (r === "ok") return { step: (await deps.store.getStep(step.id)) as FullStepRow, replayed: false, fallback };
      if (r === "lost_claim") return lostClaim(deps, step.id);
      c = (await deps.store.getCase(c.id)) as FullCaseRow;
      continue;
    }
    // The case moved on (paid, disputed) after the outbound step went out: record it as sent,
    // without a transition, and leave the case state to the reconciler.
    const r = await deps.store.completeStep({
      stepId: step.id,
      execToken: token,
      sentVia,
      draft,
      actorUid,
      virtualDate,
      details: { ...details, state_moved: true, case_state: c.state },
      transition: null,
    });
    if (r === "lost_claim") return lostClaim(deps, step.id);
    return { step: (await deps.store.getStep(step.id)) as FullStepRow, replayed: false, fallback, stateMoved: true };
  }
  throw new ServiceError("conflict", "The case kept changing; the step is still approved and can be retried");
}

async function lostClaim(deps: ServiceDeps, stepId: string): Promise<ExecuteResult> {
  const cur = (await deps.store.getStep(stepId)) as FullStepRow;
  if (cur.status === "sent") return { step: cur, replayed: true };
  throw new ServiceError("in_progress", "Another execution took over this step");
}

async function executeFeeInvoice(
  deps: ServiceDeps,
  actorUid: string,
  step: FullStepRow,
  token: string,
  c: FullCaseRow,
  inv: FullInvoiceRow,
  virtualDate: string,
): Promise<ExecuteResult> {
  if (c.state !== "closed_paid") {
    await deps.store.failStep(step.id, token, `fee invoice needs a closed_paid case (case is ${c.state})`, actorUid, virtualDate);
    throw new ServiceError("not_executable", "A fee invoice can only be sent for a paid case; the step was marked failed");
  }
  const f = step.facts as Record<string, unknown>;
  const total = f.totalCents;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total <= 0) {
    await deps.store.failStep(step.id, token, "fee invoice facts have no positive totalCents", actorUid, virtualDate);
    throw new ServiceError("not_executable", "The fee invoice has nothing to charge; the step was marked failed");
  }
  assertSandbox(deps);
  assertApproved(step);
  const debtor = await deps.store.getDebtor(inv.debtor_id);
  if (!debtor?.email) throw new ServiceError("not_executable", "Debtor has no email address");
  const number = `${inv.number ?? "MW"}-F`;

  let paypalId = c.fee_invoice_paypal_id;
  if (!paypalId) {
    const lines = feeLines(f, total, debtor.lang);
    const today = realToday(deps.now());
    const body = {
      detail: {
        invoice_number: number,
        invoice_date: today,
        currency_code: "EUR",
        note: `${debtor.lang === "de" ? "Verzugszinsen und Pauschale zu Rechnung" : "Default interest and flat fee for invoice"} ${inv.number ?? ""}. Mahnwerk demo (PayPal sandbox).`,
        payment_term: { due_date: today },
      },
      primary_recipients: [{ billing_info: { email_address: debtor.email, ...(debtor.type === "business" ? { business_name: debtor.name } : {}) } }],
      items: lines.map((l) => ({ name: l.name, quantity: "1", unit_amount: centsToMoney(l.cents, "EUR"), unit_of_measure: "AMOUNT" })),
      configuration: { allow_tip: false },
    };
    try {
      paypalId = (await deps.paypal.createInvoice(body, { requestId: `mw-fc-${step.id}` })).id;
    } catch (err) {
      if (payPalIssue(err) !== "DUPLICATE_INVOICE_NUMBER") throw err;
      const found = await deps.paypal.searchInvoices({ invoice_number: number }, { page: 1, pageSize: 2 }, { requestId: `mw-fq-${step.id}` });
      const hits = found.items.filter((i) => i.detail?.invoice_number === number);
      if (hits.length !== 1) throw err;
      paypalId = hits[0].id;
    }
    await deps.store.setCaseFeeInvoiceId(c.id, paypalId);
  }
  const remote = await deps.paypal.getInvoice(paypalId);
  if (remote.status === "DRAFT") {
    await deps.paypal.sendInvoice(paypalId, { send_to_recipient: true, send_to_invoicer: false }, { requestId: `mw-fs-${step.id}` });
  }
  const letter = templateLetter(await letterFactsFor(deps, "fee_invoice", step, inv, virtualDate));
  const r = await deps.store.completeStep({
    stepId: step.id,
    execToken: token,
    sentVia: "paypal_invoice",
    draft: { ...(step.draft ?? {}), letter, fee_invoice: { paypal_invoice_id: paypalId, number, total_cents: total } },
    actorUid,
    virtualDate,
    details: { approved_by: step.approved_by, fee_invoice_paypal_id: paypalId, total_cents: total },
    transition: null,
  });
  if (r === "lost_claim") return lostClaim(deps, step.id);
  return { step: (await deps.store.getStep(step.id)) as FullStepRow, replayed: false };
}

function feeLines(f: Record<string, unknown>, total: number, lang: "de" | "en"): { name: string; cents: number }[] {
  const n = (k: string) => (typeof f[k] === "number" && Number.isSafeInteger(f[k]) && (f[k] as number) >= 0 ? (f[k] as number) : 0);
  const names = {
    interest: lang === "de" ? "Verzugszinsen (BGB 288)" : "Default interest (BGB 288)",
    fee: lang === "de" ? "Verzugspauschale (BGB 288 Abs. 5)" : "Flat fee (BGB 288(5))",
    principal: lang === "de" ? "Offene Hauptforderung" : "Open principal",
  };
  const pick = (lines: { name: string; cents: number }[]) => {
    const kept = lines.filter((l) => l.cents > 0);
    return kept.length > 0 && kept.reduce((a, l) => a + l.cents, 0) === total ? kept : null;
  };
  // By BGB 367 a payment of the invoice total settles fee and interest first, so what is still open
  // is technically principal. Label by origin (interest, fee) when those add up to the total.
  return (
    pick([{ name: names.interest, cents: n("interestCents") }, { name: names.fee, cents: n("feeCents") }]) ??
    pick([
      { name: names.interest, cents: n("openInterestCents") },
      { name: names.fee, cents: n("openFeeCents") },
      { name: names.principal, cents: n("openPrincipalCents") },
    ]) ?? [{ name: lang === "de" ? "Verzugskosten" : "Default costs", cents: total }]
  );
}
