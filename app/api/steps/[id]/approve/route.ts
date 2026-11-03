// POST /api/steps/[id]/approve (owner of the step's workspace only; idempotent on double click).

import { handleRoute, idParam } from "@/lib/api/http";
import { EmptyBody } from "@/lib/api/schemas";
import { routeDeps } from "@/lib/api/serverDeps";
import { approveStep } from "@/lib/services/steps";

export async function POST(req: Request, ctx: RouteContext<"/api/steps/[id]/approve">): Promise<Response> {
  const { id } = await ctx.params;
  return handleRoute(routeDeps, { bucket: "mutate", body: EmptyBody }, ({ userId, services }) => approveStep(services, userId, idParam(id)))(req);
}
