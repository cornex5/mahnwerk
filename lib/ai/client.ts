// Thin server-only wrapper around @anthropic-ai/sdk. The SDK's own retries are disabled; this
// wrapper retries exactly once on 429 or 5xx. Nothing here logs, and errors never carry the API key
// or request bodies. Tests inject a fake MessagesTransport and run offline.

import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AiClient, ContentPart, ModelRequest, ModelResponse, TextPart, ToolUsePart } from "./model";

export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_TOKENS = 1_500;
/** Hard ceiling so a caller can never ask for an expensive completion by accident. */
export const MAX_TOKENS_CEILING = 4_000;
const RETRY_DELAY_MS = 800;
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;

type EnvLike = Record<string, string | undefined>;

/** Minimal structural view of `anthropic.messages`, so tests can pass a fake. */
export interface MessagesTransport {
  create(body: Record<string, unknown>, options: { timeout: number }): Promise<unknown>;
}

export class AiClientError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = "AiClientError";
    this.status = status;
    this.retryable = retryable;
  }
}

export interface CreateAiClientOptions {
  transport?: MessagesTransport;
  env?: EnvLike;
  timeoutMs?: number;
  maxTokens?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function resolveModelId(env: EnvLike = process.env): string {
  const raw = env.AI_MODEL?.trim();
  const model = raw ? raw : DEFAULT_MODEL;
  if (!MODEL_ID_RE.test(model)) throw new Error("AI_MODEL is not a valid model id");
  return model;
}

function statusOf(err: unknown): number | null {
  if (typeof err === "object" && err !== null && "status" in err) {
    const s = (err as { status: unknown }).status;
    if (typeof s === "number" && Number.isInteger(s)) return s;
  }
  return null;
}

function safeDetail(err: unknown): string {
  const msg = typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown }).message) : "";
  return msg
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

function isRetryableStatus(status: number | null): boolean {
  return status === 429 || (status !== null && status >= 500 && status <= 599);
}

const rawBlock = z.object({ type: z.string() }).passthrough();
const rawResponse = z.object({
  model: z.string().optional(),
  content: z.array(rawBlock),
  stop_reason: z.string().nullable().optional(),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).passthrough(),
});

function toWireContent(content: string | ContentPart[]): unknown {
  if (typeof content === "string") return content;
  return content.map((p) => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "tool_use") return { type: "tool_use", id: p.id, name: p.name, input: p.input };
    return { type: "tool_result", tool_use_id: p.tool_use_id, content: p.content, ...(p.is_error ? { is_error: true } : {}) };
  });
}

function parseResponse(raw: unknown, fallbackModel: string): ModelResponse {
  const r = rawResponse.safeParse(raw);
  if (!r.success) throw new AiClientError("Model response has an unexpected shape", null, false);
  const content: (TextPart | ToolUsePart)[] = [];
  for (const b of r.data.content) {
    if (b.type === "text" && typeof b.text === "string") content.push({ type: "text", text: b.text });
    else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
      content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    }
  }
  return {
    model: r.data.model ?? fallbackModel,
    content,
    stopReason: r.data.stop_reason ?? null,
    usage: { inputTokens: r.data.usage.input_tokens, outputTokens: r.data.usage.output_tokens },
  };
}

export function createAiClient(opts: CreateAiClientOptions = {}): AiClient {
  const env = opts.env ?? process.env;
  const model = resolveModelId(env);
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const defaultMaxTokens = Math.min(opts.maxTokens ?? DEFAULT_MAX_TOKENS, MAX_TOKENS_CEILING);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let transport = opts.transport;
  if (!transport) {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    const sdk = new Anthropic({ apiKey, maxRetries: 0, timeout });
    transport = {
      create: (body, options) => sdk.messages.create(body as never, options) as Promise<unknown>,
    };
  }
  const t = transport;

  async function complete(req: ModelRequest): Promise<ModelResponse> {
    const maxTokens = Math.min(req.maxTokens ?? defaultMaxTokens, MAX_TOKENS_CEILING);
    // Some current models reject forced tool_choice ("tool" or "any"). Those are sent as "auto" plus an
    // explicit instruction; callers already treat a missing or invalid tool call as a failed draft.
    const forced = req.toolChoice && (req.toolChoice.type === "tool" || req.toolChoice.type === "any") ? req.toolChoice : null;
    const forcedNote = forced
      ? forced.type === "tool"
        ? `\n\nYou must respond only by calling the tool "${forced.name}". Do not write any other text.`
        : "\n\nYou must respond only by calling one of the provided tools. Do not write any other text."
      : "";
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      system: `${req.system}${forcedNote}`,
      messages: req.messages.map((m) => ({ role: m.role, content: toWireContent(m.content) })),
    };
    if (req.tools && req.tools.length > 0) body.tools = req.tools.map((x) => ({ ...x }));
    if (req.toolChoice) body.tool_choice = forced ? { type: "auto" } : req.toolChoice;

    for (let attempt = 0; ; attempt++) {
      try {
        const raw = await t.create(body, { timeout });
        return parseResponse(raw, model);
      } catch (err) {
        if (err instanceof AiClientError) throw err;
        const status = statusOf(err);
        const retryable = isRetryableStatus(status);
        if (retryable && attempt === 0) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        // Never forward the raw SDK message: it may echo request details. For 4xx only, keep a short,
        // key-redacted excerpt of the API's own validation message so misconfiguration is diagnosable.
        const base = status === null ? "Model request failed" : `Model request failed with status ${status}`;
        const detail = status !== null && status >= 400 && status < 500 && status !== 429 ? safeDetail(err) : "";
        throw new AiClientError(detail ? `${base}: ${detail}` : base, status, retryable);
      }
    }
  }

  return { model, complete };
}
