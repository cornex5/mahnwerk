// POST /api/workspaces/[id]/copilot {question}: ask the copilot about a workspace. Owner of a real or
// demo workspace; the golden workspace answers questions but refuses propose_step. A proposed step
// only lands in the approval queue.

import { askCopilot, CopilotBody } from "@/lib/ai-wiring/aiService";
import { handleRoute, idParam } from "@/lib/api/http";
import { routeDeps } from "@/lib/api/serverDeps";

export const maxDuration = 60;

export async function POST(req: Request, ctx: RouteContext<"/api/workspaces/[id]/copilot">): Promise<Response> {
  const { id } = await ctx.params;
  return handleRoute(routeDeps, { bucket: "ai", body: CopilotBody }, ({ userId, body, services }) => askCopilot(services, userId, idParam(id), body.question))(req);
}
