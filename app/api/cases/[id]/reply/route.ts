// POST /api/cases/[id]/reply {text}: classify a debtor reply. Writes one audit row (actor ai, action
// reply.classified) and returns the classification. It never changes the case.

import { classifyCaseReply, ReplyBody } from "@/lib/ai-wiring/aiService";
import { handleRoute, idParam } from "@/lib/api/http";
import { routeDeps } from "@/lib/api/serverDeps";

export const maxDuration = 30;

export async function POST(req: Request, ctx: RouteContext<"/api/cases/[id]/reply">): Promise<Response> {
  const { id } = await ctx.params;
  return handleRoute(routeDeps, { bucket: "ai", body: ReplyBody }, ({ userId, body, services }) => classifyCaseReply(services, userId, idParam(id), body.text))(req);
}
