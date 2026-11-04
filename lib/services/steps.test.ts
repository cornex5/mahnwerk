import { describe, expect, it } from "vitest";
import { ServiceError } from "./errors";
import { createAndSendInvoice } from "./invoices";
import { planNextStage } from "./claims";
import { simulate } from "./simulator";
import { draftFingerprint } from "./draftFingerprint";
import { approveStep, assertApproved, executeStep, proposeNextStep, refreshProposals, rejectStep, setCaseHold } from "./steps";
import { OTHER_USER, USER, apiError, makeServiceWorld, type ServiceWorld } from "./testkit";
import { advanceClock } from "./workspaces";
import type { FullStepRow } from "./store";

let nonceSeq = 0;
async function newCase(w: ServiceWorld, opts: { debtor?: "consumer" | 0 | 1; cents?: number; dueDate?: string; fixed?: boolean } = {}) {
  const debtorId = opts.debtor === "consumer" ? w.consumer.id : w.business[opts.debtor ?? 0].id;
  const r = await createAndSendInvoice(w.deps, USER, {
    workspaceId: w.ws.id,
    debtorId,
    amountCents: opts.cents ?? 100000,
    dueDate: opts.dueDate ?? "2026-11-10",
    fixedCalendarDue: opts.fixed ?? false,
    nonce: `case-nonce-${++nonceSeq}`,
  });
  return r.case.id;
}

const stepOf = (w: ServiceWorld, id: string) => w.store.fullSteps.find((s) => s.id === id)!;
const caseOf = (w: ServiceWorld, id: string) => w.store.cases.get(id)!;

async function proposeAt(w: ServiceWorld, caseId: string): Promise<FullStepRow> {
  const r = await proposeNextStep(w.deps, caseId);
  if (!r.step) throw new Error(`no step proposed (plan ${JSON.stringify(r.plan)})`);
  return r.step;
}

async function errCode(p: Promise<unknown>) {
  const e = await p.then(() => null, (x) => x);
  return e instanceof ServiceError ? e.code : e === null ? "resolved" : String(e);
}

describe("planNextStage (rules engine waiting days)", () => {
  it("follows open, overdue, reminder 0, mahnung1 7, mahnung2 10, handover 14", () => {
    const base = { dueDate: "2026-11-10", lastStepDate: null };
    expect(planNextStage({ ...base, state: "open", virtualDate: "2026-11-10" })).toMatchObject({ kind: null, earliestDate: "2026-11-11", dueNow: false });
    expect(planNextStage({ ...base, state: "open", virtualDate: "2026-11-11" })).toMatchObject({ kind: "reminder", becomesOverdue: true, dueNow: true });
    expect(planNextStage({ ...base, state: "reminded", lastStepDate: "2026-11-12", virtualDate: "2026-11-18" })).toMatchObject({ kind: "mahnung1", earliestDate: "2026-11-19", dueNow: false });
    expect(planNextStage({ ...base, state: "mahnung1", lastStepDate: "2026-11-19", virtualDate: "2026-11-29" })).toMatchObject({ kind: "mahnung2", earliestDate: "2026-11-29", dueNow: true });
    expect(planNextStage({ ...base, state: "mahnung2", lastStepDate: "2026-11-29", virtualDate: "2026-12-13" })).toMatchObject({ kind: "handover", earliestDate: "2026-12-13" });
    for (const s of ["handover_ready", "paused_dispute", "closed_paid"] as const) expect(planNextStage({ ...base, state: s, virtualDate: "2027-01-01" }).kind).toBeNull();
  });
});

describe("proposals", () => {
  it("moves open to overdue (system) and proposes a reminder with engine facts, idempotently", async () => {
    const w = await makeServiceWorld();
    const caseId = await newCase(w, { fixed: true });
    expect((await proposeNextStep(w.deps, caseId)).step).toBeNull();
    expect(caseOf(w, caseId).state).toBe("open");
    await advanceClock(w.deps, w.ws.id, USER, 8); // 2026-11-11
    const s = await proposeAt(w, caseId);
    expect(caseOf(w, caseId).state).toBe("overdue");
    expect(w.store.audit.find((a) => a.action === "case.became_overdue")).toMatchObject({ actor: "system", virtual_date: "2026-11-11" });
    expect(s).toMatchObject({ kind: "reminder", status: "proposed", approved_by: null });
    const claim = (s.facts as { claim: { totalDueCents: number; openFeeCents: number; inDefault: boolean } }).claim;
    expect(claim.inDefault).toBe(true); // fixed calendar due, business
    expect(claim.openFeeCents).toBe(4000);
    // First default day: no interest accrued yet (interest runs from the default start, exclusive of calcDate).
    expect(claim.totalDueCents).toBe(104000);
    const again = await proposeNextStep(w.deps, caseId);
    expect(again.step!.id).toBe(s.id);
    expect(again.created).toBe(false);
    expect(w.store.fullSteps.filter((x) => x.case_id === caseId)).toHaveLength(1);
  });

  it("does not re-propose a rejected stage on the same virtual date", async () => {
    const w = await makeServiceWorld();
    const caseId = await newCase(w);
    await advanceClock(w.deps, w.ws.id, USER, 8);
    const s = await proposeAt(w, caseId);
    const rej = await rejectStep(w.deps, USER, s.id, "wording");
    expect(rej.step.status).toBe("rejected");
    expect((await rejectStep(w.deps, USER, s.id)).changed).toBe(false);
    expect((await proposeNextStep(w.deps, caseId)).step).toBeNull();
    await advanceClock(w.deps, w.ws.id, USER, 1);
    const s2 = await proposeAt(w, caseId);
    expect(s2.id).not.toBe(s.id);
  });
});

describe("approval", () => {
  it("records approved_by and approved_at; a double click is idempotent", async () => {
    const w = await makeServiceWorld();
    const caseId = await newCase(w);
    await advanceClock(w.deps, w.ws.id, USER, 8);
    const s = await proposeAt(w, caseId);
    const [a, b] = await Promise.all([approveStep(w.deps, USER, s.id), approveStep(w.deps, USER, s.id)]);
    expect([a.changed, b.changed].sort()).toEqual([false, true]);
    expect(stepOf(w, s.id)).toMatchObject({ status: "approved", approved_by: USER });
    expect(stepOf(w, s.id).approved_at).toBeTruthy();
    expect(w.store.audit.filter((x) => x.action === "step.approved")).toHaveLength(1);
  });

  it("refuses an approval for wording that changed since it was shown, and accepts the current fingerprint", async () => {
    const w = await makeServiceWorld();
    const caseId = await newCase(w);
    await advanceClock(w.deps, w.ws.id, USER, 8);
    const s = await proposeAt(w, caseId);
    const shown = draftFingerprint(stepOf(w, s.id).draft, stepOf(w, s.id).validation);
    // An AI draft arrives after the page was rendered.
    await w.store.setStepDraft(s.id, { subject: "S", body: "New wording", source: "ai" }, { passed: true, issues: [] });
    expect(await errCode(approveStep(w.deps, USER, s.id, { draftFingerprint: shown }))).toBe("conflict");
    expect(stepOf(w, s.id).status).toBe("proposed");
    const now = draftFingerprint(stepOf(w, s.id).draft, stepOf(w, s.id).validation);
    expect(now).not.toBe(shown);
    expect((await approveStep(w.deps, USER, s.id, { draftFingerprint: now })).changed).toBe(true);
  });

  it("only the owner may approve, reject or execute", async () => {
    const w = await makeServiceWorld();
    const caseId = await newCase(w);
    await advanceClock(w.deps, w.ws.id, USER, 8);
    const s = await proposeAt(w, caseId);
    expect(await errCode(approveStep(w.deps, OTHER_USER, s.id))).toBe("forbidden");
    expect(await errCode(rejectStep(w.deps, OTHER_USER, s.id))).toBe("forbidden");
    expect(await errCode(executeStep(w.deps, OTHER_USER, s.id))).toBe("forbidden");
  });
});

describe("approval gate: nothing outbound without an approved step", () => {
  it("assertApproved requires status approved plus approved_by and approved_at", () => {
    const ok = { id: "s", status: "approved" as const, approved_by: USER, approved_at: "2026-11-03T12:00:00Z" };
    expect(() => assertApproved(ok)).not.toThrow();
    expect(() => assertApproved({ ...ok, status: "proposed" })).toThrow(/not approved/);
    expect(() => assertApproved({ ...ok, approved_by: null })).toThrow(/not approved/);
    expect(() => assertApproved({ ...ok, approved_at: null })).toThrow(/not approved/);
  });

  it("cannot execute a proposed or rejected step; PayPal is never called", async () => {
    const w = await makeServiceWorld();
    const caseId = await newCase(w);
    await advanceClock(w.deps, w.ws.id, USER, 8);
    const s = await proposeAt(w, caseId);
    const before = w.paypal.calls.length;
    expect(await errCode(executeStep(w.deps, USER, s.id))).toBe("not_approved");
    await rejectStep(w.deps, USER, s.id);
    expect(await errCode(executeStep(w.deps, USER, s.id))).toBe("not_approved");
    expect(w.paypal.calls.length).toBe(before);
    expect(caseOf(w, caseId).state).toBe("overdue");
    expect(w.store.audit.some((a) => a.action === "step.sent")).toBe(false);
    expect(w.store.quota.size).toBe(0);
  });

  it("every PayPal reminder happens while its step is approved", async () => {
    const w = await makeServiceWorld();
    w.paypal.onRemind = (ppId) => {
      const inv = [...w.store.fullInvoices.values()].find((i) => i.paypal_invoice_id === ppId)!;
      const c = [...w.store.cases.values()].find((x) => x.invoice_id === inv.id)!;
      const approved = w.store.fullSteps.filter((s) => s.case_id === c.id && s.kind === "reminder" && s.status === "approved" && s.approved_by && s.approved_at);
      if (approved.length !== 1) throw new Error("remind without approved step");
    };
    const caseId = await newCase(w);
    await advanceClock(w.deps, w.ws.id, USER, 8);
    const s = await proposeAt(w, caseId);
    await approveStep(w.deps, USER, s.id);
    await executeStep(w.deps, USER, s.id);
    expect(w.paypal.count("remindInvoice")).toBe(1);
  });
});

describe("approval is bound to the wording that will be sent", () => {
  it("refuses the fingerprint of a stale AI draft and accepts the template fingerprint", async () => {
    const w = await makeServiceWorld();
    const caseId = await newCase(w);
    await advanceClock(w.deps, w.ws.id, USER, 8);
    const s = await proposeAt(w, caseId);
    const row = w.store.fullSteps.find((x) => x.id === s.id)!;
    row.draft = { subject: "AI subject", body: "AI body", generated_for: { virtual_date: "2000-01-01", principal_cents: 1, interest_cents: 0, fee_cents: 0, total_cents: 1 } };
    row.validation = { passed: true, issues: [] };
    await expect(approveStep(w.deps, USER, s.id, { draftFingerprint: draftFingerprint(row.draft, row.validation) })).rejects.toMatchObject({ code: "conflict" });
    const ok = await approveStep(w.deps, USER, s.id, { draftFingerprint: draftFingerprint(null, null) });
    expect(ok.changed).toBe(true);
  });
});

describe("execute", () => {
  async function approvedReminder(w: ServiceWorld, opts: Parameters<typeof newCase>[1] = {}) {
    const caseId = await newCase(w, opts);
    await advanceClock(w.deps, w.ws.id, USER, 8);
    const s = await proposeAt(w, caseId);
    await approveStep(w.deps, USER, s.id);
    return { caseId, stepId: s.id };
  }

  it("sends a reminder through PayPal, moves the case to reminded and writes audit rows", async () => {
    const w = await makeServiceWorld();
    const { caseId, stepId } = await approvedReminder(w);
    const r = await executeStep(w.deps, USER, stepId);
    expect(r.replayed).toBe(false);
    expect(r.step).toMatchObject({ status: "sent", sent_via: "paypal_remind", exec_token: null });
    expect((r.step.draft as { letter: { subject: string } }).letter.subject).toMatch(/Payment reminder|Zahlungserinnerung/);
    const remind = w.paypal.calls.find((c) => c.op === "remindInvoice")!;
    expect(remind.requestId).toBe(`mw-rm-${stepId}`);
    expect(caseOf(w, caseId)).toMatchObject({ state: "reminded", version: 2 });
    const t = w.store.audit.find((a) => a.action === "case.reminder_sent")!;
    expect(t).toMatchObject({ from_state: "overdue", to_state: "reminded", actor: "user", virtual_date: "2026-11-11" });
    expect(t.details).toMatchObject({ step_id: stepId, approved_by: USER });
    expect(w.store.audit.filter((a) => a.action === "step.sent")).toHaveLength(1);
    expect(w.store.quota.get("pp-test-merchant|2026-11-03")).toBe(1);
  });

  it("double click on execute: one PayPal reminder, one transition, one quota slot", async () => {
    const w = await makeServiceWorld();
    const { caseId, stepId } = await approvedReminder(w);
    const results = await Promise.allSettled([executeStep(w.deps, USER, stepId), executeStep(w.deps, USER, stepId), executeStep(w.deps, USER, stepId)]);
    for (const r of results) if (r.status === "rejected") expect((r.reason as ServiceError).code).toBe("in_progress");
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(w.paypal.count("remindInvoice")).toBe(1);
    expect(w.store.audit.filter((a) => a.action === "case.reminder_sent")).toHaveLength(1);
    expect(w.store.quota.get("pp-test-merchant|2026-11-03")).toBe(1);
    const again = await executeStep(w.deps, USER, stepId);
    expect(again.replayed).toBe(true);
    expect(caseOf(w, caseId).state).toBe("reminded");
    expect((await approveStep(w.deps, USER, stepId)).changed).toBe(false);
  });

  it("falls back to an in-app letter when the daily reminder quota (2) is used up", async () => {
    const w = await makeServiceWorld();
    const ids = [await newCase(w), await newCase(w, { debtor: 1 }), await newCase(w, { debtor: "consumer" })];
    await advanceClock(w.deps, w.ws.id, USER, 8);
    const proposals = await refreshProposals(w.deps, w.ws.id);
    expect(proposals.filter((p) => p.created)).toHaveLength(3);
    const results = [];
    for (const p of proposals) {
      await approveStep(w.deps, USER, p.step!.id);
      results.push(await executeStep(w.deps, USER, p.step!.id));
    }
    expect(results.map((r) => r.step.sent_via)).toEqual(["paypal_remind", "paypal_remind", "none"]);
    expect(results[2].fallback).toBe("quota_exhausted");
    expect((results[2].step.draft as { letter: { body: string } }).letter.body.length).toBeGreaterThan(50);
    expect(w.paypal.count("remindInvoice")).toBe(2);
    expect(w.store.quota.get("pp-test-merchant|2026-11-03")).toBe(2);
    for (const id of ids) expect(caseOf(w, id).state).toBe("reminded");
    // The quota is per real day: tomorrow PayPal reminders work again.
    expect(await w.store.consumeReminderQuota("pp-test-merchant", "2026-11-04", 2)).toBe(true);
  });

  it("quota consumption is atomic under concurrency", async () => {
    const w = await makeServiceWorld();
    const r = await Promise.all([1, 2, 3, 4, 5].map(() => w.store.consumeReminderQuota("m", "2026-11-03", 2)));
    expect(r.filter(Boolean)).toHaveLength(2);
  });

  it("falls back to a letter when PayPal answers 429 on remind", async () => {
    const w = await makeServiceWorld();
    const { caseId, stepId } = await approvedReminder(w);
    w.paypal.failNext("remindInvoice", apiError(429));
    const r = await executeStep(w.deps, USER, stepId);
    expect(r).toMatchObject({ fallback: "paypal_limit" });
    expect(r.step.sent_via).toBe("none");
    expect(caseOf(w, caseId).state).toBe("reminded");
  });

  it("ambiguous PayPal failure: step stays approved, case unchanged; retry reuses the request id and the quota slot", async () => {
    const w = await makeServiceWorld();
    const { caseId, stepId } = await approvedReminder(w);
    w.paypal.failNext("remindInvoice", apiError(503));
    expect(await errCode(executeStep(w.deps, USER, stepId))).toBe("paypal_failed");
    expect(stepOf(w, stepId)).toMatchObject({ status: "approved", exec_token: null, sent_via: "paypal_remind" });
    expect(caseOf(w, caseId).state).toBe("overdue");
    const r = await executeStep(w.deps, USER, stepId);
    expect(r.step.status).toBe("sent");
    const reminds = w.paypal.calls.filter((c) => c.op === "remindInvoice");
    expect(reminds).toHaveLength(2);
    expect(reminds[0].requestId).toBe(reminds[1].requestId);
    expect(w.store.quota.get("pp-test-merchant|2026-11-03")).toBe(1);
    expect(caseOf(w, caseId).state).toBe("reminded");
  });

  it("definitive PayPal rejection marks the step failed and leaves the case alone", async () => {
    const w = await makeServiceWorld();
    const { caseId, stepId } = await approvedReminder(w);
    w.paypal.failNext("remindInvoice", apiError(422, "INVALID_INVOICE_STATUS"));
    expect(await errCode(executeStep(w.deps, USER, stepId))).toBe("paypal_failed");
    expect(stepOf(w, stepId).status).toBe("failed");
    expect(caseOf(w, caseId).state).toBe("overdue");
    expect(w.store.audit.some((a) => a.action === "step.failed")).toBe(true);
    // A failed stage may be proposed again.
    const next = await proposeAt(w, caseId);
    expect(next.id).not.toBe(stepId);
  });

  it("database failure after the PayPal reminder: retry completes with one transition", async () => {
    const w = await makeServiceWorld();
    const { caseId, stepId } = await approvedReminder(w);
    w.store.failNext.completeStep = new Error("connection reset");
    expect(await errCode(executeStep(w.deps, USER, stepId))).toBe("internal");
    expect(stepOf(w, stepId).status).toBe("approved");
    expect(caseOf(w, caseId).state).toBe("overdue");
    await executeStep(w.deps, USER, stepId);
    expect(w.store.audit.filter((a) => a.action === "case.reminder_sent")).toHaveLength(1);
    expect(new Set(w.paypal.calls.filter((c) => c.op === "remindInvoice").map((c) => c.requestId)).size).toBe(1);
    expect(w.store.quota.get("pp-test-merchant|2026-11-03")).toBe(1);
  });

  it("a crashed executor's lease expires and can be taken over", async () => {
    const w = await makeServiceWorld();
    const { stepId } = await approvedReminder(w);
    expect(await w.store.claimStepExecution(stepId, "dead-executor", new Date(w.deps.now()).toISOString(), 120_000)).toBe(true);
    expect(await errCode(executeStep(w.deps, USER, stepId))).toBe("in_progress");
    w.tick(121_000);
    expect((await executeStep(w.deps, USER, stepId)).step.status).toBe("sent");
  });

  it("a case paid after approval: the step is marked failed and nothing is sent", async () => {
    const w = await makeServiceWorld();
    const { caseId, stepId } = await approvedReminder(w);
    await simulate(w.deps, USER, caseId, { type: "pay_full" }, "pay-nonce-01");
    expect(caseOf(w, caseId).state).toBe("closed_paid");
    expect(await errCode(executeStep(w.deps, USER, stepId))).toBe("not_executable");
    expect(stepOf(w, stepId).status).toBe("failed");
    expect(w.paypal.count("remindInvoice")).toBe(0);
  });

  it("a paused case cannot execute; the step stays approved for after the dispute", async () => {
    const w = await makeServiceWorld();
    const { caseId, stepId } = await approvedReminder(w);
    await simulate(w.deps, USER, caseId, { type: "dispute_open" }, "disp-nonce-01");
    expect(await errCode(executeStep(w.deps, USER, stepId))).toBe("not_executable");
    expect(stepOf(w, stepId)).toMatchObject({ status: "approved", exec_token: null });
    await simulate(w.deps, USER, caseId, { type: "dispute_resolve" }, "disp-nonce-02");
    expect((await executeStep(w.deps, USER, stepId)).step.status).toBe("sent");
  });

  it("walks the full ladder with in-app letters and waiting days up to handover_ready", async () => {
    const w = await makeServiceWorld();
    const caseId = await newCase(w, { debtor: 0, fixed: true });
    const run = async (days: number, kind: string, via: string) => {
      await advanceClock(w.deps, w.ws.id, USER, days);
      const s = await proposeAt(w, caseId);
      expect(s.kind).toBe(kind);
      await approveStep(w.deps, USER, s.id);
      const r = await executeStep(w.deps, USER, s.id);
      expect(r.step.sent_via).toBe(via);
      return r;
    };
    await run(8, "reminder", "paypal_remind");
    await advanceClock(w.deps, w.ws.id, USER, 6);
    expect((await proposeNextStep(w.deps, caseId)).plan).toMatchObject({ kind: "mahnung1", earliestDate: "2026-11-18", dueNow: false });
    const m1 = await run(1, "mahnung1", "none");
    const letter = (m1.step.draft as { letter: { subject: string; body: string; lang: string; source: string } }).letter;
    expect(letter).toMatchObject({ lang: "de", source: "template" });
    expect(letter.subject).toMatch(/^1\. Mahnung/);
    expect(letter.body).toMatch(/Verzugspauschale/);
    await run(10, "mahnung2", "none");
    await run(14, "handover", "none");
    expect(caseOf(w, caseId).state).toBe("handover_ready");
    expect((await proposeNextStep(w.deps, caseId)).step).toBeNull();
    // PayPal was only used for the reminder; letters stay in the app.
    expect(w.paypal.count("remindInvoice")).toBe(1);
    const actions = w.store.audit.filter((a) => a.case_id === caseId && a.action.startsWith("case.")).map((a) => a.action);
    expect(actions).toEqual(["case.became_overdue", "case.reminder_sent", "case.mahnung1_sent", "case.mahnung2_sent", "case.handover_prepared"]);
  });

  it("uses a validated AI draft when present, the template otherwise", async () => {
    const w = await makeServiceWorld();
    const { stepId } = await approvedReminder(w);
    const s = stepOf(w, stepId);
    s.draft = { subject: "AI subject", body: "AI body text" };
    s.validation = { passed: false };
    const r1 = await executeStep(w.deps, USER, stepId);
    expect((r1.step.draft as { letter: { source: string } }).letter.source).toBe("template");

    const w2 = await makeServiceWorld();
    const b = await approvedReminder(w2);
    const s2 = stepOf(w2, b.stepId);
    s2.draft = { subject: "AI subject", body: "AI body text" };
    s2.validation = { passed: true };
    const r2 = await executeStep(w2.deps, USER, b.stepId);
    expect((r2.step.draft as { letter: { source: string; subject: string } }).letter).toMatchObject({ source: "ai", subject: "AI subject" });
  });
});

describe("fee invoice step", () => {
  it("after a late full payment: proposed by the reconciler, approved, sent once as a separate PayPal invoice", async () => {
    const w = await makeServiceWorld();
    const caseId = await newCase(w, { debtor: 0, fixed: true, cents: 100000 });
    await advanceClock(w.deps, w.ws.id, USER, 38); // 30 days in default
    await simulate(w.deps, USER, caseId, { type: "pay_full" }, "fee-pay-nonce-1");
    expect(caseOf(w, caseId).state).toBe("closed_paid");
    const fee = w.store.fullSteps.find((s) => s.case_id === caseId && s.kind === "fee_invoice")!;
    expect(fee.status).toBe("proposed");
    const f = fee.facts as { totalCents: number; feeCents: number; interestCents: number; openPrincipalCents: number };
    // BGB 367: the payment of the invoice total went to fee and interest first, so the shortfall is principal.
    expect(f.feeCents).toBe(4000);
    expect(f.interestCents).toBeGreaterThan(0);
    expect(f.totalCents).toBe(f.feeCents + f.interestCents);
    expect(f.openPrincipalCents).toBe(f.totalCents);

    expect(await errCode(executeStep(w.deps, USER, fee.id))).toBe("not_approved");
    expect(w.paypal.invoices.size).toBe(1);

    await approveStep(w.deps, USER, fee.id);
    const results = await Promise.allSettled([executeStep(w.deps, USER, fee.id), executeStep(w.deps, USER, fee.id)]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(w.paypal.invoices.size).toBe(2);
    const feeInv = [...w.paypal.invoices.values()][1];
    expect(feeInv).toMatchObject({ status: "SENT", totalCents: f.totalCents });
    expect(feeInv.number).toMatch(/-F$/);
    const items = (feeInv.body as { items: { name: string; unit_amount: { value: string } }[] }).items;
    expect(items.map((i) => i.name)).toEqual(["Verzugszinsen (BGB 288)", "Verzugspauschale (BGB 288 Abs. 5)"]);
    expect(items[1].unit_amount.value).toBe("40.00");
    expect(stepOf(w, fee.id)).toMatchObject({ status: "sent", sent_via: "paypal_invoice" });
    expect(w.store.feeInvoiceIds.get(caseId)).toBe(feeInv.id);
    expect(caseOf(w, caseId).state).toBe("closed_paid");
    expect((await executeStep(w.deps, USER, fee.id)).replayed).toBe(true);
    expect(w.paypal.invoices.size).toBe(2);
  });
});

describe("case hold", () => {
  it("planner is not due while held and due again after the date", () => {
    const base = { dueDate: "2026-11-10", lastStepDate: "2026-11-12", state: "reminded" as const };
    expect(planNextStage({ ...base, virtualDate: "2026-11-25", holdUntil: "2026-11-30" })).toMatchObject({ kind: "mahnung1", dueNow: false, heldUntil: "2026-11-30" });
    expect(planNextStage({ ...base, virtualDate: "2026-11-30", holdUntil: "2026-11-30" })).toMatchObject({ kind: "mahnung1", dueNow: true });
  });

  it("proposes nothing while held, and an approved step refuses to send", async () => {
    const w = await makeServiceWorld();
    const caseId = await newCase(w);
    await advanceClock(w.deps, w.ws.id, USER, 8);
    const s = await proposeAt(w, caseId);
    await approveStep(w.deps, USER, s.id);
    const h = await setCaseHold(w.deps, USER, caseId, 7);
    expect(h.holdUntil).toBe("2026-11-18");
    expect(w.store.audit.some((a) => a.action === "case.hold_set")).toBe(true);
    expect(await errCode(executeStep(w.deps, USER, s.id))).toBe("not_executable");
    expect(w.paypal.calls.some((c) => c.op === "remindInvoice")).toBe(false);
    await setCaseHold(w.deps, USER, caseId, null);
    const r = await executeStep(w.deps, USER, s.id);
    expect(r.step.status).toBe("sent");
  });

  it("rejects bad days and other users", async () => {
    const w = await makeServiceWorld();
    const caseId = await newCase(w);
    expect(await errCode(setCaseHold(w.deps, USER, caseId, 0))).toBe("invalid_input");
    expect(await errCode(setCaseHold(w.deps, USER, caseId, 61))).toBe("invalid_input");
    expect(await errCode(setCaseHold(w.deps, OTHER_USER, caseId, 7))).not.toBe("resolved");
  });
});
