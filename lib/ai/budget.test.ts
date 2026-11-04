import { describe, expect, it } from "vitest";
import { createAiGateway, DEFAULT_GLOBAL_DAILY_LIMIT, DEFAULT_WORKSPACE_LIMIT, MemoryAiCallCounter, MemoryAiRunRecorder } from "./budget";
import { FakeModel, textResponse } from "./testing/fakeModel";

const request = { system: "s", messages: [{ role: "user" as const, content: "hi" }] };
const ok = () => ({ passed: true, issues: [] });

function setup(limits?: { workspace?: number; globalPerDay?: number }, now = new Date("2026-11-06T10:00:00Z")) {
  const model = new FakeModel(Array.from({ length: 50 }, () => textResponse("x")));
  const counter = new MemoryAiCallCounter();
  const recorder = new MemoryAiRunRecorder();
  let current = now;
  const gateway = createAiGateway({ client: model, counter, recorder, limits, now: () => current });
  return { model, counter, recorder, gateway, setNow: (d: Date) => (current = d) };
}

describe("AI budget", () => {
  it("defaults to 40 per workspace and 500 per day globally", () => {
    expect(DEFAULT_WORKSPACE_LIMIT).toBe(40);
    expect(DEFAULT_GLOBAL_DAILY_LIMIT).toBe(500);
  });

  it("caps calls per workspace with a typed quota_exhausted result", async () => {
    const { gateway, model } = setup({ workspace: 2 });
    const call = (ws: string) => gateway.call({ ctx: { workspaceId: ws }, purpose: "copilot", inputFacts: {}, request, validate: ok });
    expect((await call("a")).ok).toBe(true);
    expect((await call("a")).ok).toBe(true);
    expect(await call("a")).toEqual({ ok: false, reason: "quota_exhausted", scope: "workspace" });
    expect((await call("b")).ok).toBe(true);
    expect(model.requests).toHaveLength(3);
  });

  it("caps calls globally per UTC day and resets the next day", async () => {
    const { gateway, setNow } = setup({ globalPerDay: 2 });
    const call = (ws: string) => gateway.call({ ctx: { workspaceId: ws }, purpose: "copilot", inputFacts: {}, request, validate: ok });
    await call("a");
    await call("b");
    expect(await call("c")).toEqual({ ok: false, reason: "quota_exhausted", scope: "global" });
    setNow(new Date("2026-11-07T00:00:01Z"));
    expect((await call("c")).ok).toBe(true);
  });

  it("records every model call in ai_runs shape, including failures", async () => {
    const counter = new MemoryAiCallCounter();
    const recorder = new MemoryAiRunRecorder();
    const model = new FakeModel([textResponse("hello"), new Error("upstream down")]);
    const gateway = createAiGateway({ client: model, counter, recorder });
    const r1 = await gateway.call({
      ctx: { workspaceId: "ws", stepId: "st" },
      purpose: "explain_step",
      inputFacts: { a: 1 },
      request,
      validate: () => ({ passed: false, issues: ["bad"] }),
    });
    expect(r1.ok && r1.validation.passed).toBe(false);
    const r2 = await gateway.call({ ctx: { workspaceId: "ws" }, purpose: "copilot", inputFacts: {}, request, validate: ok });
    expect(r2).toEqual({ ok: false, reason: "model_error", message: "upstream down" });
    expect(recorder.rows).toEqual([
      {
        workspace_id: "ws",
        step_id: "st",
        purpose: "explain_step",
        model: "fake-model",
        input_facts: { a: 1 },
        raw_output: { content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", issues: ["bad"] },
        validation_passed: false,
        input_tokens: 80,
        output_tokens: 20,
      },
      {
        workspace_id: "ws",
        step_id: null,
        purpose: "copilot",
        model: "fake-model",
        input_facts: {},
        raw_output: { error: "upstream down" },
        validation_passed: null,
        input_tokens: null,
        output_tokens: null,
      },
    ]);
  });

  it("does not record or call the model when the quota is gone", async () => {
    const { gateway, recorder, model } = setup({ workspace: 0 });
    await gateway.call({ ctx: { workspaceId: "a" }, purpose: "copilot", inputFacts: {}, request, validate: ok });
    expect(recorder.rows).toHaveLength(0);
    expect(model.requests).toHaveLength(0);
  });
});
