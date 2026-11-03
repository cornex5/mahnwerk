// POST /api/steps/[id]/execute (owner of the step's workspace only; idempotent on double click).

import { handleRoute, idParam } from "@/lib/api/http";
import { EmptyBody } from "@/lib/api/schemas";
import { routeDeps } from "@/lib/api/serverDeps";
import { executeStep } from "@/lib/services/steps";

export async function POST(req: Request, ctx: RouteContext<"/api/steps/[id]/execute">): Promise<Response> {
  const { id } = await ctx.params;
  return handleRoute(routeDeps, { bucket: "paypal_write", body: EmptyBody }, ({ userId, services }) => executeStep(services, userId, idParam(id)))(req);
}
