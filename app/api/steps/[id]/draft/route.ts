// POST /api/steps/[id]/draft: regenerate the letter draft of a proposed step (owner only).
// The draft is stored on the step; the template is used when the AI is unavailable or fails validation.

import { redraftStep } from "@/lib/ai-wiring/aiService";
import { handleRoute, idParam } from "@/lib/api/http";
import { EmptyBody } from "@/lib/api/schemas";
import { routeDeps } from "@/lib/api/serverDeps";

export const maxDuration = 30;

export async function POST(req: Request, ctx: RouteContext<"/api/steps/[id]/draft">): Promise<Response> {
  const { id } = await ctx.params;
  return handleRoute(routeDeps, { bucket: "ai", body: EmptyBody }, ({ userId, services }) => redraftStep(services, userId, idParam(id)))(req);
}
