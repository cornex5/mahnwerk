// POST /api/steps/[id]/explain: plain-language reason why a step is proposed (read only, owner only).

import { explainStepFor } from "@/lib/ai-wiring/aiService";
import { handleRoute, idParam } from "@/lib/api/http";
import { EmptyBody } from "@/lib/api/schemas";
import { routeDeps } from "@/lib/api/serverDeps";

export const maxDuration = 30;

export async function POST(req: Request, ctx: RouteContext<"/api/steps/[id]/explain">): Promise<Response> {
  const { id } = await ctx.params;
  return handleRoute(routeDeps, { bucket: "ai", body: EmptyBody }, ({ userId, services }) => explainStepFor(services, userId, idParam(id)))(req);
}
