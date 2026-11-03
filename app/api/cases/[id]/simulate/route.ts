// POST /api/cases/[id]/simulate: customer simulator (sandbox only), reconciled immediately.

import { handleRoute, idParam } from "@/lib/api/http";
import { SimulateBody } from "@/lib/api/schemas";
import { routeDeps } from "@/lib/api/serverDeps";
import { simulate } from "@/lib/services/simulator";

export async function POST(req: Request, ctx: RouteContext<"/api/cases/[id]/simulate">): Promise<Response> {
  const { id } = await ctx.params;
  return handleRoute(routeDeps, { bucket: "paypal_write", body: SimulateBody }, ({ userId, body, services }) =>
    simulate(services, userId, idParam(id), body.action, body.nonce),
  )(req);
}
