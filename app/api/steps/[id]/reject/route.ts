// POST /api/steps/[id]/reject (owner of the step's workspace only; idempotent on double click).

import { handleRoute, idParam } from "@/lib/api/http";
import { RejectStepBody } from "@/lib/api/schemas";
import { routeDeps } from "@/lib/api/serverDeps";
import { rejectStep } from "@/lib/services/steps";

export async function POST(req: Request, ctx: RouteContext<"/api/steps/[id]/reject">): Promise<Response> {
  const { id } = await ctx.params;
  return handleRoute(routeDeps, { bucket: "mutate", body: RejectStepBody }, ({ userId, body, services }) => rejectStep(services, userId, idParam(id), body.note))(req);
}
