// POST /api/workspaces/[id]/clock: advance the demo clock by N days, then refresh step proposals.

import { handleRoute, idParam } from "@/lib/api/http";
import { AdvanceClockBody } from "@/lib/api/schemas";
import { routeDeps } from "@/lib/api/serverDeps";
import { refreshProposals } from "@/lib/services/steps";
import { advanceClock } from "@/lib/services/workspaces";

export const maxDuration = 60;

export async function POST(req: Request, ctx: RouteContext<"/api/workspaces/[id]/clock">): Promise<Response> {
  const { id } = await ctx.params;
  return handleRoute(routeDeps, { bucket: "mutate", body: AdvanceClockBody }, async ({ userId, body, services }) => {
    const wsId = idParam(id);
    const clock = await advanceClock(services, wsId, userId, body.days);
    const proposals = await refreshProposals(services, wsId);
    return {
      clock,
      proposals: proposals.map((p) => ({ caseId: p.caseId, kind: p.plan.kind, earliestDate: p.plan.earliestDate, stepId: p.step?.id ?? null, created: p.created })),
    };
  })(req);
}
