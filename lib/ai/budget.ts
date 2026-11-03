// AI call budget and run log. Every model call in lib/ai goes through AiGateway.call: it consumes one
// unit of quota (per workspace and global per day), calls the model, lets the caller validate the
// output and writes one ai_runs row through the injected recorder. When the quota is gone it returns
// a typed quota_exhausted result and makes no model call, so callers can fall back to a template.

import type { AiClient, ModelRequest, ModelResponse, ModelUsage } from "./model";
import type { AiCallCounter, AiPurpose, AiRunRecorder, AiRunRow, QuotaDecision, QuotaRequest, QuotaScope } from "./ports";

export const DEFAULT_WORKSPACE_LIMIT = 40;
export const DEFAULT_GLOBAL_DAILY_LIMIT = 2000;

export interface BudgetLimits {
  workspace: number;
  globalPerDay: number;
}

export interface AiContext {
  /** Bound by the server from the session; never taken from model output. */
  workspaceId: string;
  stepId?: string | null;
}

export interface CallValidation {
  passed: boolean;
  issues: string[];
}

export type GatewayResult =
  | { ok: true; response: ModelResponse; validation: CallValidation }
  | { ok: false; reason: "quota_exhausted"; scope: QuotaScope }
  | { ok: false; reason: "model_error"; message: string };

export interface GatewayCall {
  ctx: AiContext;
  purpose: AiPurpose;
  /** What the model was told (no secrets). Stored in ai_runs.input_facts. */
  inputFacts: Record<string, unknown>;
  request: ModelRequest;
  /** Runs before the row is recorded so validation_passed is accurate. */
  validate: (res: ModelResponse) => CallValidation;
}

export interface AiGateway {
  readonly model: string;
  call(c: GatewayCall): Promise<GatewayResult>;
}

export interface CreateGatewayOptions {
  client: AiClient;
  counter: AiCallCounter;
  recorder: AiRunRecorder;
  limits?: Partial<BudgetLimits>;
  now?: () => Date;
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function createAiGateway(opts: CreateGatewayOptions): AiGateway {
  const limits: BudgetLimits = {
    workspace: opts.limits?.workspace ?? DEFAULT_WORKSPACE_LIMIT,
    globalPerDay: opts.limits?.globalPerDay ?? DEFAULT_GLOBAL_DAILY_LIMIT,
  };
  const now = opts.now ?? (() => new Date());

  async function call(c: GatewayCall): Promise<GatewayResult> {
    if (!c.ctx.workspaceId) throw new Error("AI call without a workspace id");
    const decision = await opts.counter.tryConsume({
      workspaceId: c.ctx.workspaceId,
      day: utcDay(now()),
      workspaceLimit: limits.workspace,
      globalLimit: limits.globalPerDay,
    });
    if (!decision.ok) return { ok: false, reason: "quota_exhausted", scope: decision.scope };

    const base: Omit<AiRunRow, "raw_output" | "validation_passed" | "input_tokens" | "output_tokens"> = {
      workspace_id: c.ctx.workspaceId,
      step_id: c.ctx.stepId ?? null,
      purpose: c.purpose,
      model: opts.client.model,
      input_facts: c.inputFacts,
    };

    let response: ModelResponse;
    try {
      response = await opts.client.complete(c.request);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Model request failed";
      await opts.recorder.record({ ...base, raw_output: { error: message }, validation_passed: null, input_tokens: null, output_tokens: null });
      return { ok: false, reason: "model_error", message };
    }

    const validation = c.validate(response);
    await opts.recorder.record({
      ...base,
      model: response.model,
      raw_output: { content: response.content, stop_reason: response.stopReason, issues: validation.issues },
      validation_passed: validation.passed,
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
    });
    return { ok: true, response, validation };
  }

  return { model: opts.client.model, call };
}

export function usageOf(r: GatewayResult): ModelUsage {
  return r.ok ? r.response.usage : { inputTokens: 0, outputTokens: 0 };
}

/** In-memory counter for tests and local demos. Single-process only. */
export class MemoryAiCallCounter implements AiCallCounter {
  readonly perWorkspace = new Map<string, number>();
  readonly perDay = new Map<string, number>();

  async tryConsume(req: QuotaRequest): Promise<QuotaDecision> {
    const ws = this.perWorkspace.get(req.workspaceId) ?? 0;
    const g = this.perDay.get(req.day) ?? 0;
    if (g >= req.globalLimit) return { ok: false, scope: "global" };
    if (ws >= req.workspaceLimit) return { ok: false, scope: "workspace" };
    this.perWorkspace.set(req.workspaceId, ws + 1);
    this.perDay.set(req.day, g + 1);
    return { ok: true, workspaceUsed: ws + 1, globalUsed: g + 1 };
  }
}

/** In-memory recorder for tests. */
export class MemoryAiRunRecorder implements AiRunRecorder {
  readonly rows: AiRunRow[] = [];
  async record(row: AiRunRow): Promise<void> {
    this.rows.push(structuredClone(row));
  }
}
