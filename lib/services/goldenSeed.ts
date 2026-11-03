// Read-only golden workspace for judges: a pure data builder plus an inserter. Every amount and
// every state is computed by the rules engine and the state machine at a fixed virtual date
// (GOLDEN_VIRTUAL_DATE), so the golden data can never disagree with the engine.
// Golden invoices are not linked to PayPal (paypal_invoice_id null): nothing here ever calls PayPal.

import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, diffDays } from "../rules/dates";
import { transition, type ActiveState, type CaseEvent, type CaseSnapshot, type CaseState } from "../cases/stateMachine";
import type { ClaimFacts, LedgerRow } from "../cases/store";
import { GOLDEN_VIRTUAL_DATE, stableKey } from "./context";
import { STEP_SPECS, claimAt, planNextStage, type DunningKind } from "./claims";
import { goldenAiDraft } from "./goldenAiDrafts";
import { templateLetter } from "./letters";
import type { CreditorRow, DebtorRow, FullInvoiceRow, FullStepRow, WorkspaceRow } from "./store";
import { DEMO_CREDITOR, DEMO_DEBTORS } from "./workspaces";

/** Fixed approver id recorded on golden steps (the curated demo, not a real user). */
export const GOLDEN_CURATOR_UID = "00000000-0000-4000-8000-00000000c0de";

type TimelineEvent =
  | { date: string; type: "step"; kind: DunningKind; via: "paypal_remind" | "none" }
  | { date: string; type: "payment"; cents: number }
  | { date: string; type: "dispute_open"; reason: string };

interface Scenario {
  label: string;
  debtor: 0 | 1 | 2;
  issue: string;
  due: string;
  cents: number;
  fixedCalendarDue: boolean;
  warning: boolean;
  timeline: TimelineEvent[];
}

export const GOLDEN_SCENARIOS: readonly Scenario[] = [
  { label: "open", debtor: 2, issue: "2026-11-16", due: "2026-11-30", cents: 85000, fixedCalendarDue: false, warning: true, timeline: [] },
  { label: "overdue", debtor: 0, issue: "2026-10-27", due: "2026-11-10", cents: 24000, fixedCalendarDue: false, warning: true, timeline: [] },
  {
    label: "reminded",
    debtor: 2,
    issue: "2026-10-17",
    due: "2026-10-31",
    cents: 150000,
    fixedCalendarDue: false,
    warning: true,
    timeline: [{ date: "2026-11-03", type: "step", kind: "reminder", via: "paypal_remind" }],
  },
  {
    label: "mahnung1",
    debtor: 1,
    issue: "2026-09-15",
    due: "2026-09-30",
    cents: 200000,
    fixedCalendarDue: true,
    warning: true,
    timeline: [
      { date: "2026-10-02", type: "step", kind: "reminder", via: "paypal_remind" },
      { date: "2026-10-12", type: "step", kind: "mahnung1", via: "none" },
    ],
  },
  {
    label: "partial_payment",
    debtor: 1,
    issue: "2026-10-01",
    due: "2026-10-15",
    cents: 120000,
    fixedCalendarDue: false,
    warning: true,
    timeline: [
      { date: "2026-10-20", type: "step", kind: "reminder", via: "paypal_remind" },
      { date: "2026-10-28", type: "payment", cents: 40000 },
    ],
  },
  {
    label: "paused_dispute",
    debtor: 0,
    issue: "2026-10-06",
    due: "2026-10-20",
    cents: 38000,
    fixedCalendarDue: false,
    warning: false,
    timeline: [
      { date: "2026-10-23", type: "step", kind: "reminder", via: "paypal_remind" },
      { date: "2026-11-02", type: "dispute_open", reason: "dispute:SIM-D-GOLDEN0006" },
    ],
  },
  {
    label: "closed_paid",
    debtor: 2,
    issue: "2026-09-01",
    due: "2026-09-15",
    cents: 99000,
    fixedCalendarDue: true,
    warning: true,
    timeline: [
      { date: "2026-09-18", type: "step", kind: "reminder", via: "paypal_remind" },
      { date: "2026-10-15", type: "payment", cents: 99000 },
    ],
  },
];

export interface GoldenCaseInsert {
  id: string;
  workspace_id: string;
  invoice_id: string;
  state: CaseState;
  prev_state: ActiveState | null;
  paused_reason: string | null;
  version: number;
  default_start: string | null;
  next_step_kind: string | null;
  next_step_due: string | null;
}

export interface GoldenAuditInsert {
  workspace_id: string;
  case_id: string | null;
  invoice_id: string | null;
  actor: "user" | "system" | "ai" | "paypal";
  actor_uid: string | null;
  action: string;
  from_state: string | null;
  to_state: string | null;
  virtual_date: string;
  details: Record<string, unknown>;
}

export interface GoldenSeed {
  virtualDate: string;
  workspace: Omit<WorkspaceRow, "created_at"> & { jurisdiction: "DE" };
  creditor: CreditorRow;
  debtors: DebtorRow[];
  invoices: FullInvoiceRow[];
  cases: GoldenCaseInsert[];
  steps: Omit<FullStepRow, "created_at">[];
  ledger: LedgerRow[];
  audit: GoldenAuditInsert[];
  labels: Record<string, string>;
}

function uuidFrom(seed: string, name: string): string {
  const h = stableKey("golden", seed, name);
  // RFC 4122 shape, version 4 bits and variant bits set, derived deterministically from the seed.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const at = (date: string) => `${date}T09:00:00.000Z`;

/**
 * Builds the golden workspace. Pure and deterministic for a given seed string. Use a fresh seed
 * (for example a random UUID) for every real insert so ids never collide with older audit rows.
 */
export function buildGoldenSeed(seed: string): GoldenSeed {
  const id = (name: string) => uuidFrom(seed, name);
  const virtualDate = GOLDEN_VIRTUAL_DATE;
  const wsId = id("workspace");
  const workspace = { id: wsId, owner_uid: null, kind: "golden" as const, name: "Golden demo (read-only)", jurisdiction: "DE" as const, clock_offset_days: 0, expires_at: null };
  const creditor: CreditorRow = { ...structuredClone(DEMO_CREDITOR), id: id("creditor"), workspace_id: wsId };
  const debtors: DebtorRow[] = DEMO_DEBTORS.map((d, i) => ({ ...d, id: id(`debtor-${i}`), workspace_id: wsId }));

  const invoices: FullInvoiceRow[] = [];
  const cases: GoldenCaseInsert[] = [];
  const steps: Omit<FullStepRow, "created_at">[] = [];
  const ledger: LedgerRow[] = [];
  const audit: GoldenAuditInsert[] = [];
  const labels: Record<string, string> = {};

  GOLDEN_SCENARIOS.forEach((sc, n) => {
    const num = String(n + 1).padStart(3, "0");
    const debtor = debtors[sc.debtor];
    const inv: FullInvoiceRow = {
      id: id(`invoice-${num}`),
      workspace_id: wsId,
      creditor_id: creditor.id,
      debtor_id: debtor.id,
      paypal_invoice_id: null,
      number: `MW-G-${num}`,
      currency: "EUR",
      issue_date: sc.issue,
      due_date: sc.due,
      fixed_calendar_due: sc.fixedCalendarDue,
      default_warning_printed: sc.warning,
      received_on: sc.issue,
      principal_cents: sc.cents,
      request_key: null,
    };
    invoices.push(inv);
    const caseId = id(`case-${num}`);
    labels[caseId] = sc.label;

    let snap: CaseSnapshot = { state: "open", resumeState: null, pausedReason: null };
    let version = 0;
    let firstRequest: string | null = null;
    let lastStepDate: string | null = null;
    const invLedger: LedgerRow[] = [];
    const facts = (): ClaimFacts => ({
      due_date: sc.due,
      fixed_calendar_due: sc.fixedCalendarDue,
      default_warning_printed: sc.warning,
      received_on: sc.issue,
      debtor_type: debtor.type,
      first_payment_request_on: firstRequest,
    });
    const log = (a: Omit<GoldenAuditInsert, "workspace_id" | "case_id" | "invoice_id" | "from_state" | "to_state"> & { from_state?: string; to_state?: string }) =>
      audit.push({ workspace_id: wsId, case_id: caseId, invoice_id: inv.id, from_state: a.from_state ?? null, to_state: a.to_state ?? null, ...a });
    const apply = (event: CaseEvent, date: string, actor: GoldenAuditInsert["actor"], details: Record<string, unknown> = {}) => {
      const next = transition(snap, event);
      log({ actor, actor_uid: actor === "user" ? GOLDEN_CURATOR_UID : null, action: `case.${event.type}`, from_state: snap.state, to_state: next.state, virtual_date: date, details });
      snap = next;
      version++;
    };

    log({ actor: "user", actor_uid: GOLDEN_CURATOR_UID, action: "invoice.sent", to_state: "open", virtual_date: sc.issue, details: { number: inv.number, amount_cents: sc.cents, due_date: sc.due, golden: true } });
    const overdueOn = addDays(sc.due, 1);
    const maybeOverdue = (date: string) => {
      if (snap.state === "open" && diffDays(overdueOn, date) >= 0) apply({ type: "became_overdue" }, overdueOn, "system");
    };

    sc.timeline.forEach((ev, k) => {
      maybeOverdue(ev.date);
      if (ev.type === "step") {
        const spec = STEP_SPECS[ev.kind];
        if (snap.state !== spec.from) throw new Error(`golden ${sc.label}: ${ev.kind} needs ${spec.from}, case is ${snap.state}`);
        const stepId = id(`step-${num}-${k}`);
        const claim = claimAt(inv, facts(), invLedger, ev.date);
        const letter = templateLetter({
          kind: ev.kind,
          lang: debtor.lang,
          creditorName: creditor.name,
          debtorName: debtor.name,
          invoiceNumber: inv.number as string,
          virtualDate: ev.date,
          dueDate: sc.due,
          openPrincipalCents: claim.openPrincipalCents,
          openInterestCents: claim.openInterestCents,
          openFeeCents: claim.openFeeCents,
          totalDueCents: claim.totalDueCents,
        });
        steps.push({
          id: stepId,
          workspace_id: wsId,
          case_id: caseId,
          kind: ev.kind,
          status: "sent",
          facts: { kind: ev.kind, virtualDate: ev.date, claim: { openPrincipalCents: claim.openPrincipalCents, openInterestCents: claim.openInterestCents, openFeeCents: claim.openFeeCents, totalDueCents: claim.totalDueCents, defaultStart: claim.defaultStart, citation: claim.citation } },
          draft: { letter, channel: ev.via === "paypal_remind" ? "paypal_reminder_and_in_app_letter" : "in_app_letter" },
          validation: null,
          approved_by: GOLDEN_CURATOR_UID,
          approved_at: at(ev.date),
          sent_via: ev.via,
          sent_at: at(ev.date),
          exec_token: null,
          exec_started_at: null,
        });
        log({ actor: "system", actor_uid: null, action: "step.proposed", virtual_date: ev.date, details: { step_id: stepId, kind: ev.kind } });
        log({ actor: "user", actor_uid: GOLDEN_CURATOR_UID, action: "step.approved", virtual_date: ev.date, details: { step_id: stepId, kind: ev.kind } });
        apply({ type: spec.event, approvedStepId: stepId } as CaseEvent, ev.date, "user", { step_id: stepId, sent_via: ev.via });
        log({ actor: "user", actor_uid: GOLDEN_CURATOR_UID, action: "step.sent", virtual_date: ev.date, details: { step_id: stepId, kind: ev.kind, sent_via: ev.via } });
        if (ev.kind !== "handover" && firstRequest === null) firstRequest = ev.date;
        lastStepDate = ev.date;
      } else if (ev.type === "payment") {
        const row: LedgerRow = { workspace_id: wsId, invoice_id: inv.id, kind: "payment", amount_cents: ev.cents, booked_on: ev.date, paypal_ref: `GOLDEN-PAY-${num}-${k}`, source: "manual" };
        invLedger.push(row);
        log({ actor: "paypal", actor_uid: null, action: "ledger.payment_recorded", virtual_date: ev.date, details: { amount_cents: ev.cents, booked_on: ev.date, paypal_ref: row.paypal_ref } });
        const paid = invLedger.reduce((a, l) => a + (l.kind === "payment" ? l.amount_cents : -l.amount_cents), 0);
        if (paid >= sc.cents) apply({ type: "paid_in_full" }, ev.date, "paypal", { paid_cents: paid });
      } else {
        apply({ type: "dispute_opened", reason: ev.reason }, ev.date, "paypal", { dispute_id: ev.reason.slice("dispute:".length), simulated: true });
      }
    });
    maybeOverdue(virtualDate);
    ledger.push(...invLedger);

    const claim = claimAt(inv, facts(), invLedger, virtualDate);
    const plan = planNextStage({ state: snap.state, dueDate: sc.due, lastStepDate, virtualDate });
    if (plan.kind && plan.dueNow) {
      const stepId = id(`step-${num}-next`);
      const aiExample = goldenAiDraft({ number: inv.number ?? num, kind: plan.kind, debtorType: debtor.type, debtorName: debtor.name, creditorName: creditor.name, claim, virtualDate });
      steps.push({
        id: stepId,
        workspace_id: wsId,
        case_id: caseId,
        kind: plan.kind,
        status: "proposed",
        facts: {
          kind: plan.kind,
          virtualDate,
          earliestDate: plan.earliestDate,
          invoice: { id: inv.id, number: inv.number, principalCents: inv.principal_cents, dueDate: inv.due_date, issueDate: inv.issue_date },
          debtor: { name: debtor.name, type: debtor.type, lang: debtor.lang },
          creditor: { name: creditor.name, kleinunternehmer: creditor.kleinunternehmer },
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
        },
        draft: aiExample?.draft ?? null,
        validation: aiExample?.validation ?? null,
        approved_by: null,
        approved_at: null,
        sent_via: null,
        sent_at: null,
        exec_token: null,
        exec_started_at: null,
      });
      log({ actor: "system", actor_uid: null, action: "step.proposed", virtual_date: virtualDate, details: { step_id: stepId, kind: plan.kind, total_due_cents: claim.totalDueCents } });
    }
    if (snap.state === "closed_paid" && claim.totalDueCents > 0) {
      // Same facts shape as the reconciler's fee_invoice proposal.
      const stepId = id(`step-${num}-fee`);
      steps.push({
        id: stepId,
        workspace_id: wsId,
        case_id: caseId,
        kind: "fee_invoice",
        status: "proposed",
        facts: {
          principalCents: inv.principal_cents,
          interestCents: claim.interestAccruedCents,
          feeCents: claim.flatFeeCents,
          totalCents: claim.totalDueCents,
          calcDate: virtualDate,
          openPrincipalCents: claim.openPrincipalCents,
          openInterestCents: claim.openInterestCents,
          openFeeCents: claim.openFeeCents,
          defaultStart: claim.defaultStart,
          citation: claim.citation,
        },
        draft: null,
        validation: null,
        approved_by: null,
        approved_at: null,
        sent_via: null,
        sent_at: null,
        exec_token: null,
        exec_started_at: null,
      });
      log({ actor: "system", actor_uid: null, action: "step.fee_invoice_proposed", virtual_date: virtualDate, details: { step_id: stepId, total_cents: claim.totalDueCents } });
    }

    cases.push({
      id: caseId,
      workspace_id: wsId,
      invoice_id: inv.id,
      state: snap.state,
      prev_state: snap.resumeState,
      paused_reason: snap.pausedReason,
      version,
      default_start: claim.defaultStart,
      next_step_kind: plan.kind,
      next_step_due: plan.earliestDate,
    });
  });

  return { virtualDate, workspace, creditor, debtors, invoices, cases, steps, ledger, audit, labels };
}

/**
 * Inserts a built seed with the service role. Refuses when a golden workspace exists, unless
 * replace is set (then the old one is deleted; its audit rows stay, they are append-only).
 * On a failure midway the new workspace is deleted again (cascade) so no half golden remains.
 */
export async function insertGoldenSeed(db: SupabaseClient, seed: GoldenSeed, opts: { replace?: boolean } = {}): Promise<void> {
  const cur = await db.from("workspaces").select("id").eq("kind", "golden");
  if (cur.error) throw new Error(`read workspaces: ${cur.error.message}`);
  if (cur.data.length > 0) {
    if (!opts.replace) throw new Error("A golden workspace already exists (pass replace to delete and recreate it)");
    const del = await db.from("workspaces").delete().eq("kind", "golden");
    if (del.error) throw new Error(`delete golden: ${del.error.message}`);
  }
  const step = async (table: string, rows: unknown) => {
    const r = await db.from(table).insert(rows as Record<string, unknown>[]);
    if (r.error) throw new Error(`insert ${table}: ${r.error.message}`);
  };
  await step("workspaces", [seed.workspace]);
  try {
    await step("creditors", [seed.creditor]);
    await step("debtors", seed.debtors);
    await step("invoices", seed.invoices.map(({ request_key, ...rest }) => (request_key === null ? rest : { ...rest, request_key })));
    await step("dunning_cases", seed.cases);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    await step("steps", seed.steps.map(({ exec_token, exec_started_at, ...rest }) => rest));
    if (seed.ledger.length > 0) await step("ledger", seed.ledger);
    await step("audit_log", seed.audit);
  } catch (err) {
    await db.from("workspaces").delete().eq("id", seed.workspace.id);
    throw err;
  }
}
