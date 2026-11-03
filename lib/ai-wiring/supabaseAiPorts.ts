// Supabase (service role) implementations of the AI layer ports: the atomic call counter
// (migration 0004, public.mw_ai_consume) and the ai_runs recorder.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiCallCounter, AiRunRecorder, AiRunRow, QuotaDecision, QuotaRequest } from "../ai/ports";

function fail(op: string, error: { message: string } | null): never {
  throw new Error(`Supabase ${op} failed: ${error?.message ?? "unknown error"}`);
}

export class SupabaseAiCallCounter implements AiCallCounter {
  constructor(private readonly sb: SupabaseClient) {}

  async tryConsume(req: QuotaRequest): Promise<QuotaDecision> {
    const r = await this.sb.rpc("mw_ai_consume", {
      p_workspace: req.workspaceId,
      p_day: req.day,
      p_workspace_limit: req.workspaceLimit,
      p_global_limit: req.globalLimit,
    });
    if (r.error) fail("mw_ai_consume", r.error);
    return parseDecision(r.data);
  }
}

/** Validates the jsonb result of mw_ai_consume. Anything unexpected is an error, never a free call. */
export function parseDecision(data: unknown): QuotaDecision {
  if (typeof data === "object" && data !== null) {
    const d = data as Record<string, unknown>;
    if (d.ok === true && Number.isInteger(d.workspace_used) && Number.isInteger(d.global_used)) {
      return { ok: true, workspaceUsed: d.workspace_used as number, globalUsed: d.global_used as number };
    }
    if (d.ok === false && (d.scope === "workspace" || d.scope === "global")) return { ok: false, scope: d.scope };
  }
  throw new Error("mw_ai_consume returned an unexpected result");
}

export class SupabaseAiRunRecorder implements AiRunRecorder {
  constructor(private readonly sb: SupabaseClient) {}

  async record(row: AiRunRow): Promise<void> {
    const r = await this.sb.from("ai_runs").insert(row);
    // A lost log row must not break the user's request; the call has already happened.
    if (r.error) console.error("[mahnwerk] ai_runs insert failed", { purpose: row.purpose, message: r.error.message });
  }
}
