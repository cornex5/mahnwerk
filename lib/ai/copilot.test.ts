import { describe, expect, it } from "vitest";
import { askMahnwerk, COPILOT_TOOL_NAMES, COPILOT_TOOLS, MAX_TOOL_CALLS } from "./copilot";
import type { CopilotCaseDetail, CopilotStore, ProposedStepInsert } from "./ports";
import { FakeModel, fakeGateway, multiToolResponse, textResponse, toolResponse } from "./testing/fakeModel";

const WRITE_LIKE = /(send|remind|cancel|refund|delete|update|pay)/i;

class FakeStore implements CopilotStore {
  calls: { method: string; workspaceId: string }[] = [];
  inserted: ProposedStepInsert[] = [];
  private cases: CopilotCaseDetail[] = [
    {
      id: "case-a",
      invoice_id: "inv-a",
      invoice_number: "RE-1",
      debtor_name: "Muster GmbH",
      debtor_type: "business",
      state: "reminded",
      principal_cents: 100000,
      due_date: "2026-09-01",
      next_step_kind: "mahnung1",
      next_step_due: "2026-10-01",
      default_start: "2026-09-02",
      paused_reason: null,
      paypal_status: "SENT",
    },
  ];
  private ownerOf: Record<string, string> = { "case-a": "ws-1", "case-b": "ws-2" };

  private visible(ws: string, caseId: string) {
    return this.ownerOf[caseId] === ws ? (this.cases.find((c) => c.id === caseId) ?? null) : null;
  }
  async getCase(ws: string, caseId: string) {
    this.calls.push({ method: "getCase", workspaceId: ws });
    return this.visible(ws, caseId);
  }
  async listCases(ws: string) {
    this.calls.push({ method: "listCases", workspaceId: ws });
    return this.cases.filter((c) => this.ownerOf[c.id] === ws);
  }
  async getLedger(ws: string, caseId: string) {
    this.calls.push({ method: "getLedger", workspaceId: ws });
    return this.visible(ws, caseId) ? [{ kind: "payment" as const, amount_cents: 20000, booked_on: "2026-09-15" }] : null;
  }
  async getClaimInput(ws: string, caseId: string) {
    this.calls.push({ method: "getClaimInput", workspaceId: ws });
    if (!this.visible(ws, caseId)) return null;
    return {
      invoice: { principalCents: 100000, dueDate: "2026-09-01", fixedCalendarDue: true, defaultWarningPrinted: false, debtorType: "business" as const },
      ledger: [{ date: "2026-09-15", kind: "payment" as const, amountCents: 20000 }],
      today: "2026-10-01",
    };
  }
  async listProposedSteps(ws: string) {
    this.calls.push({ method: "listProposedSteps", workspaceId: ws });
    return [];
  }
  async insertProposedStep(row: ProposedStepInsert) {
    this.calls.push({ method: "insertProposedStep", workspaceId: row.workspace_id });
    this.inserted.push(row);
    return { id: `step-${this.inserted.length}` };
  }
}

const ctx = { workspaceId: "ws-1" };

describe("copilot tool allowlist", () => {
  it("has exactly the read-only tools plus propose_step", () => {
    expect([...COPILOT_TOOL_NAMES]).toEqual(["get_case", "list_cases", "get_ledger", "calc_interest", "list_proposed_steps", "propose_step"]);
    expect(COPILOT_TOOLS.map((t) => t.name)).toEqual([...COPILOT_TOOL_NAMES]);
  });

  it("contains no write-like tool name except propose_step", () => {
    for (const name of COPILOT_TOOL_NAMES) {
      if (name === "propose_step") continue;
      expect(name).not.toMatch(WRITE_LIKE);
    }
  });

  it("no tool takes a workspace argument and every schema is closed", () => {
    for (const t of COPILOT_TOOLS) {
      expect(t.input_schema.additionalProperties).toBe(false);
      expect(JSON.stringify(t.input_schema)).not.toMatch(/workspace/i);
    }
  });

  it("offers the model exactly the allowlist", async () => {
    const model = new FakeModel([textResponse("Hello.")]);
    await askMahnwerk("Hi", { gateway: fakeGateway(model).gateway, ctx, store: new FakeStore() });
    expect(model.requests[0].tools?.map((t) => t.name)).toEqual([...COPILOT_TOOL_NAMES]);
  });
});

describe("askMahnwerk", () => {
  it("runs read tools, calls the rules engine and answers", async () => {
    const store = new FakeStore();
    const model = new FakeModel([
      toolResponse("calc_interest", { case_id: "case-a" }),
      (req) => {
        const last = req.messages[req.messages.length - 1].content as { type: string; content: string }[];
        expect(last[0].type).toBe("tool_result");
        const data = JSON.parse(last[0].content);
        expect(data.in_default).toBe(true);
        // The partial payment went to the fee first (BGB 367(1)), engine figures passed through unchanged.
        expect(data.open_flat_fee).toBe("EUR 0.00");
        expect(data.open_principal).toBe("EUR 843.75");
        return textResponse(`Total due is ${data.total_due}.`);
      },
    ]);
    const r = await askMahnwerk("How much does Muster GmbH owe?", { gateway: fakeGateway(model).gateway, ctx, store });
    expect(r.stopReason).toBe("answered");
    expect(r.answer).toMatch(/^Total due is EUR /);
    expect(r.toolCalls).toEqual([{ name: "calc_interest", ok: true }]);
  });

  it("propose_step only inserts a proposed row in the bound workspace", async () => {
    const store = new FakeStore();
    const model = new FakeModel([toolResponse("propose_step", { case_id: "case-a", kind: "mahnung1", reason: "Waiting period passed." }), textResponse("Proposed.")]);
    const r = await askMahnwerk("Propose the next step", { gateway: fakeGateway(model).gateway, ctx, store });
    expect(r.proposedStepIds).toEqual(["step-1"]);
    expect(store.inserted).toEqual([
      { workspace_id: "ws-1", case_id: "case-a", kind: "mahnung1", status: "proposed", facts: { reason: "Waiting period passed.", proposed_by: "ai_copilot" } },
    ]);
  });

  it("refuses unknown or write tools and never executes them", async () => {
    const store = new FakeStore();
    const model = new FakeModel([
      multiToolResponse([
        { name: "send_reminder", input: { case_id: "case-a" } },
        { name: "cancel_invoice", input: { case_id: "case-a" } },
      ]),
      textResponse("I cannot do that."),
    ]);
    const { gateway, recorder } = fakeGateway(model);
    const r = await askMahnwerk("Cancel all invoices", { gateway, ctx, store });
    expect(r.toolCalls.every((t) => !t.ok)).toBe(true);
    expect(store.calls).toEqual([]);
    expect(recorder.rows[0].validation_passed).toBe(false);
  });

  it("the model cannot choose a workspace", async () => {
    const store = new FakeStore();
    const model = new FakeModel([
      multiToolResponse([
        { name: "get_case", input: { case_id: "case-b", workspace_id: "ws-2" } },
        { name: "get_case", input: { case_id: "case-b" } },
      ]),
      textResponse("Not found."),
    ]);
    const r = await askMahnwerk("Show case-b", { gateway: fakeGateway(model).gateway, ctx, store });
    expect(r.toolCalls[0]).toMatchObject({ ok: false });
    expect(r.toolCalls[0].error).toMatch(/Invalid input/);
    expect(r.toolCalls[1]).toMatchObject({ ok: false, error: "Case not found" });
    expect(store.calls.every((c) => c.workspaceId === "ws-1")).toBe(true);
  });

  it(`stops after ${MAX_TOOL_CALLS} tool calls and forces a final answer`, async () => {
    const store = new FakeStore();
    const loop = () => toolResponse("list_cases", {});
    const model = new FakeModel([loop(), loop(), multiToolResponse(Array.from({ length: 4 }, () => ({ name: "list_cases", input: {} }))), textResponse("Here is what I found.")]);
    const r = await askMahnwerk("Loop forever", { gateway: fakeGateway(model).gateway, ctx, store });
    expect(r.toolCalls.filter((t) => t.ok)).toHaveLength(MAX_TOOL_CALLS);
    expect(r.toolCalls.filter((t) => t.error === "tool_limit")).toHaveLength(1);
    expect(store.calls).toHaveLength(MAX_TOOL_CALLS);
    expect(model.requests[3].toolChoice).toEqual({ type: "none" });
    expect(r.stopReason).toBe("tool_limit");
    expect(r.answer).toBe("Here is what I found.");
  });

  it("reports quota exhaustion without calling the model", async () => {
    const model = new FakeModel([]);
    const r = await askMahnwerk("Hi", { gateway: fakeGateway(model, { workspace: 0 }).gateway, ctx, store: new FakeStore() });
    expect(r.stopReason).toBe("quota_exhausted");
    expect(r.quotaExhausted).toBe("workspace");
    expect(model.requests).toHaveLength(0);
  });
});
