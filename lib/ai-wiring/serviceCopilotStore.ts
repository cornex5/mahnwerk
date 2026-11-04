// CopilotStore on top of the service layer store (so it runs on Supabase with the service role and on
// the in-memory store in tests). Every read is scoped to one workspace: a case of another workspace
// behaves like a missing case. The only write, insertProposedStep, goes through the same proposal
// rules as the clock and the reconciler (proposeNextStep): next stage only, waiting days over, one
// pending dunning step per case, rejected stages not re-proposed. Nothing is ever sent from here.

import type {
  CopilotCaseDetail,
  CopilotCaseSummary,
  CopilotClaimInput,
  CopilotLedgerRow,
  CopilotStore,
  CopilotStepRow,
  ProposedStepInsert,
} from "../ai/ports";
import { claimAt, isDunningKind, planNextStage } from "../services/claims";
import { virtualDateFor, type ServiceDeps } from "../services/context";
import { proposeNextStep } from "../services/steps";
import type { FullCaseRow, FullInvoiceRow, WorkspaceRow } from "../services/store";

/** Thrown for a refused proposal. The copilot reports the message to the model as a tool error. */
export class ToolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRefusal";
  }
}

export interface CopilotStoreOptions {
  workspaceId: string;
  /** True for the golden workspace: questions are fine, propose_step is refused. */
  readOnly: boolean;
}

export class ServiceCopilotStore implements CopilotStore {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly opts: CopilotStoreOptions,
  ) {}

  private async workspace(workspaceId: string): Promise<WorkspaceRow | null> {
    if (workspaceId !== this.opts.workspaceId) return null;
    return this.deps.store.getWorkspace(workspaceId);
  }

  private async scopedCase(workspaceId: string, caseId: string): Promise<{ c: FullCaseRow; inv: FullInvoiceRow; ws: WorkspaceRow } | null> {
    const ws = await this.workspace(workspaceId);
    if (!ws) return null;
    const c = await this.deps.store.getCase(caseId);
    if (!c || c.workspace_id !== workspaceId) return null;
    const inv = await this.deps.store.getFullInvoice(c.invoice_id);
    if (!inv) return null;
    return { c, inv, ws };
  }

  private async summary(c: FullCaseRow, inv: FullInvoiceRow, ws: WorkspaceRow): Promise<CopilotCaseSummary> {
    const debtor = await this.deps.store.getDebtor(inv.debtor_id);
    const virtualDate = virtualDateFor(ws, this.deps.now());
    const plan = planNextStage({ state: c.state, dueDate: inv.due_date, lastStepDate: await this.deps.store.lastStepTransitionDate(c.id), virtualDate, holdUntil: c.hold_until });
    return {
      id: c.id,
      invoice_id: inv.id,
      invoice_number: inv.number,
      debtor_name: debtor?.name ?? "Unknown",
      debtor_type: debtor?.type ?? "business",
      state: c.state,
      principal_cents: inv.principal_cents,
      due_date: inv.due_date,
      next_step_kind: plan.kind,
      next_step_due: plan.kind ? plan.earliestDate : null,
    };
  }

  async getCase(workspaceId: string, caseId: string): Promise<CopilotCaseDetail | null> {
    const s = await this.scopedCase(workspaceId, caseId);
    if (!s) return null;
    const base = await this.summary(s.c, s.inv, s.ws);
    let defaultStart: string | null = null;
    const facts = await this.deps.store.getClaimFacts(s.inv.id);
    if (facts) {
      try {
        defaultStart = claimAt(s.inv, facts, await this.deps.store.listLedger(s.inv.id), virtualDateFor(s.ws, this.deps.now())).defaultStart;
      } catch {
        defaultStart = null;
      }
    }
    return { ...base, default_start: defaultStart, paused_reason: s.c.paused_reason, paypal_status: null };
  }

  async listCases(workspaceId: string, opts: { state?: string; limit: number }): Promise<CopilotCaseSummary[]> {
    const ws = await this.workspace(workspaceId);
    if (!ws) return [];
    const cases = (await this.deps.store.listCases(workspaceId)).filter((c) => (opts.state ? c.state === opts.state : true)).slice(0, opts.limit);
    const out: CopilotCaseSummary[] = [];
    for (const c of cases) {
      const inv = await this.deps.store.getFullInvoice(c.invoice_id);
      if (inv) out.push(await this.summary(c, inv, ws));
    }
    return out;
  }

  async getLedger(workspaceId: string, caseId: string): Promise<CopilotLedgerRow[] | null> {
    const s = await this.scopedCase(workspaceId, caseId);
    if (!s) return null;
    return (await this.deps.store.listLedger(s.inv.id)).map((l) => ({ kind: l.kind, amount_cents: l.amount_cents, booked_on: l.booked_on }));
  }

  async getClaimInput(workspaceId: string, caseId: string): Promise<CopilotClaimInput | null> {
    const s = await this.scopedCase(workspaceId, caseId);
    if (!s) return null;
    const facts = await this.deps.store.getClaimFacts(s.inv.id);
    if (!facts) return null;
    const ledger = await this.deps.store.listLedger(s.inv.id);
    return {
      invoice: {
        principalCents: s.inv.principal_cents,
        dueDate: facts.due_date,
        fixedCalendarDue: facts.fixed_calendar_due,
        defaultWarningPrinted: facts.default_warning_printed,
        ...(facts.received_on ? { receivedOn: facts.received_on } : {}),
        ...(facts.first_payment_request_on ? { firstPaymentRequestSentOn: facts.first_payment_request_on } : {}),
        debtorType: facts.debtor_type,
      },
      ledger: ledger.map((l) => ({ date: l.booked_on, kind: l.kind, amountCents: l.amount_cents })),
      today: virtualDateFor(s.ws, this.deps.now()),
    };
  }

  async listProposedSteps(workspaceId: string, caseId?: string): Promise<CopilotStepRow[]> {
    const ws = await this.workspace(workspaceId);
    if (!ws) return [];
    const cases = caseId ? [await this.deps.store.getCase(caseId)] : await this.deps.store.listCases(workspaceId);
    const out: CopilotStepRow[] = [];
    for (const c of cases) {
      if (!c || c.workspace_id !== workspaceId) continue;
      for (const s of await this.deps.store.listSteps(c.id)) {
        if (s.status === "proposed") out.push({ id: s.id, case_id: s.case_id, kind: s.kind, status: s.status, created_at: s.created_at ?? "" });
      }
    }
    return out;
  }

  async insertProposedStep(row: ProposedStepInsert): Promise<{ id: string }> {
    if (this.opts.readOnly) throw new ToolRefusal("This workspace is read-only (golden workspace). Proposing steps is not possible here.");
    if (row.workspace_id !== this.opts.workspaceId) throw new ToolRefusal("Case not found");
    if (!isDunningKind(row.kind)) {
      throw new ToolRefusal(`A ${row.kind} step is created by the reconciler after payment, not by the assistant. Only reminder, mahnung1, mahnung2 or handover can be proposed.`);
    }
    const s = await this.scopedCase(row.workspace_id, row.case_id);
    if (!s) throw new ToolRefusal("Case not found");

    // Same stage plan as the service layer: only the next stage, and only when its waiting days are over.
    const virtualDate = virtualDateFor(s.ws, this.deps.now());
    const plan = planNextStage({ state: s.c.state, dueDate: s.inv.due_date, lastStepDate: await this.deps.store.lastStepTransitionDate(s.c.id), virtualDate, holdUntil: s.c.hold_until });
    if (plan.kind !== row.kind || !plan.dueNow) {
      throw new ToolRefusal(
        plan.kind
          ? `A ${row.kind} cannot be proposed now. The next stage for this case is ${plan.kind}, allowed from ${plan.earliestDate}. Today is ${virtualDate}.`
          : `No further dunning step is possible for a case in state ${s.c.state}.`,
      );
    }

    const r = await proposeNextStep(this.deps, s.c.id);
    if (!r.step || r.step.kind !== row.kind) {
      throw new ToolRefusal(r.step ? `The case already has a pending ${r.step.kind} step.` : `No ${row.kind} step was created (a rejected stage is not proposed again on the same day).`);
    }
    if (r.created) {
      await this.deps.store.insertAudit({
        workspace_id: s.c.workspace_id,
        case_id: s.c.id,
        invoice_id: s.inv.id,
        actor: "ai",
        action: "step.suggested_by_copilot",
        virtual_date: virtualDate,
        details: { step_id: r.step.id, kind: row.kind, reason: row.facts.reason.slice(0, 500) },
      });
    }
    return { id: r.step.id };
  }
}
