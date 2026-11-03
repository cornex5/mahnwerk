// Provider-neutral model types for the Mahnwerk AI layer. No runtime dependencies, safe to import
// from tests and pure modules. The Anthropic implementation lives in lib/ai/client.ts.

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolUsePart {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultPart {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentPart = TextPart | ToolUsePart | ToolResultPart;

export interface ModelMessage {
  role: "user" | "assistant";
  content: string | ContentPart[];
}

export interface ToolSpec {
  name: string;
  description: string;
  /** Strict JSON schema (additionalProperties false on every object). */
  input_schema: Record<string, unknown>;
}

export type ToolChoice = { type: "auto" } | { type: "any" } | { type: "none" } | { type: "tool"; name: string };

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools?: ToolSpec[];
  toolChoice?: ToolChoice;
  maxTokens?: number;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelResponse {
  model: string;
  /** Only text and tool_use parts are kept; other block types are dropped. */
  content: (TextPart | ToolUsePart)[];
  stopReason: string | null;
  usage: ModelUsage;
}

export interface AiClient {
  readonly model: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

export const ZERO_USAGE: ModelUsage = Object.freeze({ inputTokens: 0, outputTokens: 0 });

export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

/** First tool_use part with the given name, or null. */
export function findToolUse(res: ModelResponse, name: string): ToolUsePart | null {
  for (const p of res.content) if (p.type === "tool_use" && p.name === name) return p;
  return null;
}
