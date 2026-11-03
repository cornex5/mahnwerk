import { describe, expect, it } from "vitest";
import { AiClientError, createAiClient, DEFAULT_MODEL, MAX_TOKENS_CEILING, resolveModelId, type MessagesTransport } from "./client";

const okRaw = {
  model: "claude-sonnet-5-5",
  content: [
    { type: "text", text: "hi" },
    { type: "tool_use", id: "t1", name: "x", input: { a: 1 }, caller: { type: "direct" } },
    { type: "thinking", thinking: "..." },
  ],
  stop_reason: "tool_use",
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null },
};

class FakeTransport implements MessagesTransport {
  calls: { body: Record<string, unknown>; options: { timeout: number } }[] = [];
  constructor(private script: unknown[]) {}
  async create(body: Record<string, unknown>, options: { timeout: number }) {
    this.calls.push({ body, options });
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    return next;
  }
}

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status} sk-ant-SECRET body`), { status });
}

const env = { ANTHROPIC_API_KEY: "sk-ant-SECRET" };
const noSleep = async () => {};

describe("AI client", () => {
  it("uses AI_MODEL or the default model id", () => {
    expect(resolveModelId({})).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe("claude-sonnet-5-5");
    expect(resolveModelId({ AI_MODEL: "claude-opus-5-5" })).toBe("claude-opus-5-5");
    expect(() => resolveModelId({ AI_MODEL: "bad model; rm" })).toThrow();
  });

  it("requires an API key only when no transport is injected", () => {
    expect(() => createAiClient({ env: {} })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => createAiClient({ env: {}, transport: new FakeTransport([]) })).not.toThrow();
  });

  it("builds the request, caps max tokens and parses text and tool_use only", async () => {
    const t = new FakeTransport([okRaw]);
    const c = createAiClient({ env, transport: t, timeoutMs: 1234, sleep: noSleep });
    const r = await c.complete({
      system: "sys",
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "x", is_error: true }] }],
      tools: [{ name: "x", description: "d", input_schema: { type: "object" } }],
      toolChoice: { type: "tool", name: "x" },
      maxTokens: 999_999,
    });
    expect(t.calls[0].options).toEqual({ timeout: 1234 });
    expect(t.calls[0].body).toMatchObject({ model: DEFAULT_MODEL, max_tokens: MAX_TOKENS_CEILING, system: "sys", tool_choice: { type: "tool", name: "x" } });
    expect(r.content).toEqual([
      { type: "text", text: "hi" },
      { type: "tool_use", id: "t1", name: "x", input: { a: 1 } },
    ]);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("retries exactly once on 429 and 5xx", async () => {
    const t1 = new FakeTransport([httpError(429), okRaw]);
    await createAiClient({ env, transport: t1, sleep: noSleep }).complete({ system: "", messages: [] });
    expect(t1.calls).toHaveLength(2);

    const t2 = new FakeTransport([httpError(503), httpError(500), okRaw]);
    const err = await createAiClient({ env, transport: t2, sleep: noSleep }).complete({ system: "", messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(AiClientError);
    expect((err as AiClientError).status).toBe(500);
    expect(t2.calls).toHaveLength(2);
  });

  it("does not retry 4xx and never leaks the key or the SDK message", async () => {
    const t = new FakeTransport([httpError(400)]);
    const err = (await createAiClient({ env, transport: t, sleep: noSleep }).complete({ system: "", messages: [] }).catch((e) => e)) as Error;
    expect(t.calls).toHaveLength(1);
    expect(err.message).toBe("Model request failed with status 400");
    expect(JSON.stringify(err)).not.toContain("SECRET");
    expect(String(err.stack)).not.toContain("SECRET");
  });

  it("rejects malformed responses", async () => {
    const t = new FakeTransport([{ nope: true }]);
    await expect(createAiClient({ env, transport: t }).complete({ system: "", messages: [] })).rejects.toThrow(/unexpected shape/);
  });
});
