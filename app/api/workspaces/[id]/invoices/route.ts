// POST /api/workspaces/[id]/invoices: create and send a PayPal sandbox invoice (idempotent by nonce).

import { handleRoute, idParam } from "@/lib/api/http";
import { CreateInvoiceBody } from "@/lib/api/schemas";
import { routeDeps } from "@/lib/api/serverDeps";
import { createAndSendInvoice } from "@/lib/services/invoices";
import { refreshProposals } from "@/lib/services/steps";

export async function POST(req: Request, ctx: RouteContext<"/api/workspaces/[id]/invoices">): Promise<Response> {
  const { id } = await ctx.params;
  return handleRoute(routeDeps, { bucket: "paypal_write", body: CreateInvoiceBody }, async ({ userId, body, services }) => {
    const wsId = idParam(id);
    const result = await createAndSendInvoice(services, userId, { ...body, workspaceId: wsId });
    await refreshProposals(services, wsId).catch(() => undefined);
    return result;
  })(req);
}
