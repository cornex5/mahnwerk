// POST /api/cases/[id]/hold {days} puts the case on hold for 1 to 60 days; {days: null} clears it.
// A human decision: nothing is proposed or sent while the hold lasts.

import { z } from "zod";
import { handleRoute, idParam } from "@/lib/api/http";
import { routeDeps } from "@/lib/api/serverDeps";
import { setCaseHold } from "@/lib/services/steps";

const HoldBody = z.strictObject({ days: z.number().int().min(1).max(60).nullable() });

export async function POST(req: Request, ctx: RouteContext<"/api/cases/[id]/hold">): Promise<Response> {
  const { id } = await ctx.params;
  return handleRoute(routeDeps, { bucket: "mutate", body: HoldBody }, ({ userId, body, services }) => setCaseHold(services, userId, idParam(id), body.days))(req);
}
