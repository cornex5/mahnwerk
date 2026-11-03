// Production wiring of the AI layer: Anthropic client, Supabase quota counter and ai_runs recorder.
// Returns undefined when ANTHROPIC_API_KEY is missing, so proposals keep working with templates and
// the AI routes answer 503.

import "server-only";
import { createAiGateway } from "../ai/budget";
import { createAiClient } from "../ai/client";
import { getSupabaseAdmin } from "../db/admin";
import type { AiServices } from "../services/context";
import { SupabaseAiCallCounter, SupabaseAiRunRecorder } from "./supabaseAiPorts";

let cached: AiServices | undefined;

export function getAiServices(): AiServices | undefined {
  if (cached) return cached;
  if (!process.env.ANTHROPIC_API_KEY) return undefined;
  try {
    const sb = getSupabaseAdmin();
    cached = { gateway: createAiGateway({ client: createAiClient(), counter: new SupabaseAiCallCounter(sb), recorder: new SupabaseAiRunRecorder(sb) }) };
    return cached;
  } catch (err) {
    console.error("[mahnwerk] AI wiring failed", { message: err instanceof Error ? err.message : "unknown" });
    return undefined;
  }
}
