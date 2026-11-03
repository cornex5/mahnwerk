// Offline test helpers: a scripted fake model and a ready gateway. Not used by production code.

import { createAiGateway, MemoryAiCallCounter, MemoryAiRunRecorder, type AiGateway, type BudgetLimits } from "../budget";
import type { AiClient, ModelRequest, ModelResponse, TextPart, ToolUsePart } from "../model";

export type FakeStep = ModelResponse | Error | ((req: ModelRequest) => ModelResponse);

export class FakeModel implements AiClient {
  readonly model = "fake-model";
  readonly requests: ModelRequest[] = [];
  private steps: FakeStep[];
  constructor(steps: FakeStep[]) {
    this.steps = [...steps];
  }
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift();
    if (step === undefined) throw new Error("FakeModel: no scripted response left");
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(req) : step;
  }
}

let seq = 0;

export function toolResponse(name: string, input: unknown, extra: (TextPart | ToolUsePart)[] = []): ModelResponse {
  seq++;
  return {
    model: "fake-model",
    content: [...extra, { type: "tool_use", id: `toolu_${seq}`, name, input }],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

export function multiToolResponse(calls: { name: string; input: unknown }[]): ModelResponse {
  return {
    model: "fake-model",
    content: calls.map((c) => ({ type: "tool_use" as const, id: `toolu_${++seq}`, name: c.name, input: c.input })),
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

export function textResponse(text: string): ModelResponse {
  return { model: "fake-model", content: [{ type: "text", text }], stopReason: "end_turn", usage: { inputTokens: 80, outputTokens: 20 } };
}

export function fakeGateway(model: AiClient, limits?: Partial<BudgetLimits>): {
  gateway: AiGateway;
  counter: MemoryAiCallCounter;
  recorder: MemoryAiRunRecorder;
} {
  const counter = new MemoryAiCallCounter();
  const recorder = new MemoryAiRunRecorder();
  const gateway = createAiGateway({ client: model, counter, recorder, limits, now: () => new Date("2026-11-06T10:00:00Z") });
  return { gateway, counter, recorder };
}
