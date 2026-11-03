// ServiceStore backed by Supabase (service role). Atomic multi-row writes go through the SQL
// functions of migration 0003 (mw_create_demo_workspace, mw_finalize_invoice, mw_decide_step,
// mw_complete_step, mw_consume_reminder_quota).

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseStore } from "./supabaseStore";
import type {
  CompleteStepInput,
  CompleteStepResult,
  CreateDemoWorkspaceInput,
  CreateDemoWorkspaceResult,
  CreditorRow,
  DebtorRow,
  DecideStepInput,
  DecideStepResult,
  FullCaseRow,
  FullInvoiceRow,
  FullStepRow,
  PendingInvoiceInsert,
  ServiceStore,
  WorkspaceRow,
} from "../services/store";

const WS_COLS = "id, owner_uid, kind, name, clock_offset_days, expires_at, created_at";
const CREDITOR_COLS = "id, workspace_id, name, address, kleinunternehmer, lang";
const DEBTOR_COLS = "id, workspace_id, name, email, type, lang";
const INVOICE_COLS =
  "id, workspace_id, creditor_id, debtor_id, paypal_invoice_id, number, currency, issue_date, due_date, fixed_calendar_due, default_warning_printed, received_on, principal_cents, request_key";
const CASE_COLS = "id, workspace_id, invoice_id, state, prev_state, paused_reason, version, fee_invoice_paypal_id";
const STEP_COLS =
  "id, workspace_id, case_id, kind, status, facts, draft, validation, approved_by, approved_at, sent_via, sent_at, exec_token, exec_started_at, created_at";
const STEP_TRANSITION_ACTIONS = ["case.reminder_sent", "case.mahnung1_sent", "case.mahnung2_sent", "case.handover_prepared"];

function fail(op: string, error: { message: string } | null): never {
  throw new Error(`Supabase ${op} failed: ${error?.message ?? "unknown error"}`);
}

/** bigint columns arrive as numbers from PostgREST for values in the safe range; assert it. */
function invoiceRow(r: Record<string, unknown>): FullInvoiceRow {
  const cents = Number(r.principal_cents);
  if (!Number.isSafeInteger(cents)) throw new Error("principal_cents out of range");
  return { ...(r as unknown as FullInvoiceRow), principal_cents: cents };
}

export class SupabaseServiceStore extends SupabaseStore implements ServiceStore {
  constructor(private readonly sb: SupabaseClient) {
    super(sb);
  }

  // ------------------------------------------------------------ workspaces

  async getWorkspace(id: string) {
    const r = await this.sb.from("workspaces").select(WS_COLS).eq("id", id).maybeSingle();
    if (r.error) fail("read workspaces", r.error);
    return (r.data as WorkspaceRow | null) ?? null;
  }

  async createDemoWorkspace(input: CreateDemoWorkspaceInput): Promise<CreateDemoWorkspaceResult> {
    const r = await this.sb.rpc("mw_create_demo_workspace", {
      p_owner: input.ownerUid,
      p_name: input.name,
      p_expires_at: input.expiresAt,
      p_now: input.nowIso,
      p_user_cap: input.perUserCap,
      p_global_cap: input.globalCap,
      p_creditor: input.creditor,
      p_debtors: input.debtors,
    });
    if (r.error) fail("mw_create_demo_workspace", r.error);
    const d = r.data as { ok: boolean; workspace_id?: string; reason?: "user_cap" | "global_cap" };
    if (d.ok && d.workspace_id) return { ok: true, workspaceId: d.workspace_id };
    return { ok: false, reason: d.reason === "user_cap" ? "user_cap" : "global_cap" };
  }

  async setClockOffset(workspaceId: string, expectedOld: number, next: number) {
    const r = await this.sb
      .from("workspaces")
      .update({ clock_offset_days: next })
      .eq("id", workspaceId)
      .eq("clock_offset_days", expectedOld)
      .neq("kind", "golden")
      .select("id");
    if (r.error) fail("update workspaces", r.error);
    return r.data.length === 1;
  }

  async getCreditorForWorkspace(workspaceId: string) {
    const r = await this.sb.from("creditors").select(CREDITOR_COLS).eq("workspace_id", workspaceId).order("created_at").limit(1);
    if (r.error) fail("read creditors", r.error);
    return (r.data[0] as CreditorRow | undefined) ?? null;
  }

  async getDebtor(id: string) {
    const r = await this.sb.from("debtors").select(DEBTOR_COLS).eq("id", id).maybeSingle();
    if (r.error) fail("read debtors", r.error);
    return (r.data as DebtorRow | null) ?? null;
  }

  async listDebtors(workspaceId: string) {
    const r = await this.sb.from("debtors").select(DEBTOR_COLS).eq("workspace_id", workspaceId).order("created_at");
    if (r.error) fail("read debtors", r.error);
    return r.data as DebtorRow[];
  }

  // ------------------------------------------------------------ invoices

  async getFullInvoice(id: string) {
    const r = await this.sb.from("invoices").select(INVOICE_COLS).eq("id", id).maybeSingle();
    if (r.error) fail("read invoices", r.error);
    return r.data ? invoiceRow(r.data) : null;
  }

  async findInvoiceByRequestKey(key: string) {
    const r = await this.sb.from("invoices").select(INVOICE_COLS).eq("request_key", key).maybeSingle();
    if (r.error) fail("read invoices", r.error);
    return r.data ? invoiceRow(r.data) : null;
  }

  async insertPendingInvoice(row: PendingInvoiceInsert) {
    const ins = await this.sb.from("invoices").insert(row).select(INVOICE_COLS);
    if (!ins.error && ins.data.length === 1) return { inserted: true, invoice: invoiceRow(ins.data[0]) };
    if (ins.error && ins.error.code !== "23505") fail("insert invoices", ins.error);
    // unique_violation on request_key: another call inserted it first.
    const cur = row.request_key ? await this.findInvoiceByRequestKey(row.request_key) : null;
    if (!cur) fail("insert invoices", ins.error);
    return { inserted: false, invoice: cur };
  }

  async setInvoicePayPalId(invoiceId: string, paypalInvoiceId: string) {
    const r = await this.sb
      .from("invoices")
      .update({ paypal_invoice_id: paypalInvoiceId })
      .eq("id", invoiceId)
      .is("paypal_invoice_id", null)
      .select("id");
    if (r.error) fail("update invoices", r.error);
    if (r.data.length === 1) return true;
    const cur = await this.getFullInvoice(invoiceId);
    return cur?.paypal_invoice_id === paypalInvoiceId;
  }

  async deletePendingInvoice(invoiceId: string) {
    const c = await this.sb.from("dunning_cases").select("id").eq("invoice_id", invoiceId).limit(1);
    if (c.error) fail("read dunning_cases", c.error);
    if (c.data.length > 0) return false;
    // Only called by the invoice flow after a definitive PayPal rejection, before finalize. A case
    // can only be created by finalize after a PayPal success, so no case can appear in between.
    const r = await this.sb.from("invoices").delete().eq("id", invoiceId);
    if (r.error) fail("delete invoices", r.error);
    return true;
  }

  async finalizeInvoice(input: { invoiceId: string; paypalInvoiceId: string; actorUid: string; virtualDate: string; details: Record<string, unknown> }) {
    const r = await this.sb.rpc("mw_finalize_invoice", {
      p_invoice_id: input.invoiceId,
      p_paypal_invoice_id: input.paypalInvoiceId,
      p_actor_uid: input.actorUid,
      p_virtual_date: input.virtualDate,
      p_details: input.details,
    });
    if (r.error) fail("mw_finalize_invoice", r.error);
    return r.data as string;
  }

  // ------------------------------------------------------------ cases

  async getCase(id: string) {
    const r = await this.sb.from("dunning_cases").select(CASE_COLS).eq("id", id).maybeSingle();
    if (r.error) fail("read dunning_cases", r.error);
    return (r.data as FullCaseRow | null) ?? null;
  }

  async getCaseForInvoice(invoiceId: string) {
    const r = await this.sb.from("dunning_cases").select(CASE_COLS).eq("invoice_id", invoiceId).maybeSingle();
    if (r.error) fail("read dunning_cases", r.error);
    return (r.data as FullCaseRow | null) ?? null;
  }

  async listCases(workspaceId: string) {
    const r = await this.sb.from("dunning_cases").select(CASE_COLS).eq("workspace_id", workspaceId).order("created_at");
    if (r.error) fail("read dunning_cases", r.error);
    return r.data as FullCaseRow[];
  }

  async setCaseFeeInvoiceId(caseId: string, paypalInvoiceId: string) {
    const r = await this.sb
      .from("dunning_cases")
      .update({ fee_invoice_paypal_id: paypalInvoiceId })
      .eq("id", caseId)
      .is("fee_invoice_paypal_id", null);
    if (r.error) fail("update dunning_cases", r.error);
  }

  async lastStepTransitionDate(caseId: string) {
    const r = await this.sb
      .from("audit_log")
      .select("virtual_date")
      .eq("case_id", caseId)
      .in("action", STEP_TRANSITION_ACTIONS)
      .not("virtual_date", "is", null)
      .order("id", { ascending: false })
      .limit(1);
    if (r.error) fail("read audit_log", r.error);
    return (r.data[0]?.virtual_date as string | undefined) ?? null;
  }

  // ------------------------------------------------------------ steps

  async getStep(id: string) {
    const r = await this.sb.from("steps").select(STEP_COLS).eq("id", id).maybeSingle();
    if (r.error) fail("read steps", r.error);
    return (r.data as FullStepRow | null) ?? null;
  }

  async listSteps(caseId: string) {
    const r = await this.sb.from("steps").select(STEP_COLS).eq("case_id", caseId).order("created_at");
    if (r.error) fail("read steps", r.error);
    return r.data as FullStepRow[];
  }

  async insertProposedStep(row: { workspace_id: string; case_id: string; kind: FullStepRow["kind"]; facts: Record<string, unknown> }) {
    const ins = await this.sb.from("steps").insert({ ...row, status: "proposed" }).select(STEP_COLS);
    if (!ins.error && ins.data.length === 1) return { inserted: true, step: ins.data[0] as FullStepRow };
    if (ins.error && ins.error.code !== "23505") fail("insert steps", ins.error);
    // Partial unique index (0003): the case already has a pending dunning step.
    const cur = await this.sb
      .from("steps")
      .select(STEP_COLS)
      .eq("case_id", row.case_id)
      .in("status", ["proposed", "approved"])
      .in("kind", ["reminder", "mahnung1", "mahnung2", "handover"])
      .limit(1);
    if (cur.error) fail("read steps", cur.error);
    return { inserted: false, step: (cur.data[0] as FullStepRow | undefined) ?? null };
  }

  async setStepDraft(stepId: string, draft: Record<string, unknown> | null, validation: Record<string, unknown> | null) {
    const r = await this.sb.from("steps").update({ draft, validation }).eq("id", stepId).eq("status", "proposed").select("id");
    if (r.error) fail("update steps", r.error);
    return r.data.length === 1;
  }

  async decideStep(input: DecideStepInput): Promise<DecideStepResult> {
    const r = await this.sb.rpc("mw_decide_step", {
      p_step_id: input.stepId,
      p_decision: input.decision,
      p_actor_uid: input.actorUid,
      p_virtual_date: input.virtualDate,
      p_note: input.note,
    });
    if (r.error) fail("mw_decide_step", r.error);
    return r.data as DecideStepResult;
  }

  async claimStepExecution(stepId: string, token: string, nowIso: string, leaseMs: number) {
    const staleBefore = new Date(Date.parse(nowIso) - leaseMs).toISOString();
    const r = await this.sb
      .from("steps")
      .update({ exec_token: token, exec_started_at: nowIso })
      .eq("id", stepId)
      .eq("status", "approved")
      .or(`exec_token.is.null,exec_started_at.lt."${staleBefore}"`)
      .select("id");
    if (r.error) fail("claim steps", r.error);
    return r.data.length === 1;
  }

  async releaseStepExecution(stepId: string, token: string) {
    const r = await this.sb.from("steps").update({ exec_token: null, exec_started_at: null }).eq("id", stepId).eq("exec_token", token);
    if (r.error) fail("release steps", r.error);
  }

  async setStepSentVia(stepId: string, token: string, sentVia: NonNullable<FullStepRow["sent_via"]>) {
    const r = await this.sb
      .from("steps")
      .update({ sent_via: sentVia })
      .eq("id", stepId)
      .eq("status", "approved")
      .eq("exec_token", token)
      .select("id");
    if (r.error) fail("update steps", r.error);
    return r.data.length === 1;
  }

  async completeStep(input: CompleteStepInput): Promise<CompleteStepResult> {
    const t = input.transition;
    const r = await this.sb.rpc("mw_complete_step", {
      p_step_id: input.stepId,
      p_exec_token: input.execToken,
      p_sent_via: input.sentVia,
      p_draft: input.draft,
      p_actor_uid: input.actorUid,
      p_virtual_date: input.virtualDate,
      p_expected_version: t?.expectedVersion ?? null,
      p_from_state: t?.fromState ?? null,
      p_to_state: t?.toState ?? null,
      p_prev_state: t?.prevState ?? null,
      p_paused_reason: t?.pausedReason ?? null,
      p_actor: t?.actor ?? null,
      p_action: t?.action ?? null,
      p_transition_details: t?.details ?? null,
      p_details: input.details,
    });
    if (r.error) fail("mw_complete_step", r.error);
    return r.data as CompleteStepResult;
  }

  async failStep(stepId: string, token: string, reason: string, actorUid: string, virtualDate: string) {
    const cur = await this.getStep(stepId);
    if (!cur) return false;
    const r = await this.sb
      .from("steps")
      .update({ status: "failed", exec_token: null, exec_started_at: null, validation: { ...(cur.validation ?? {}), failed_reason: reason } })
      .eq("id", stepId)
      .eq("status", "approved")
      .eq("exec_token", token)
      .select("id");
    if (r.error) fail("update steps", r.error);
    if (r.data.length !== 1) return false;
    await this.insertAudit({
      workspace_id: cur.workspace_id,
      case_id: cur.case_id,
      invoice_id: null,
      actor: "system",
      action: "step.failed",
      virtual_date: virtualDate,
      details: { step_id: stepId, kind: cur.kind, reason, actor_uid: actorUid },
    });
    return true;
  }

  // ------------------------------------------------------------ quota

  async consumeReminderQuota(merchantId: string, day: string, max: number) {
    const r = await this.sb.rpc("mw_consume_reminder_quota", { p_merchant: merchantId, p_day: day, p_max: max });
    if (r.error) fail("mw_consume_reminder_quota", r.error);
    return r.data === true;
  }
}
