// POST /api/workspaces: create a demo workspace (seeded creditor and 3 debtors, expires after 48h).

import { handleRoute } from "@/lib/api/http";
import { CreateWorkspaceBody } from "@/lib/api/schemas";
import { routeDeps } from "@/lib/api/serverDeps";
import { createDemoWorkspace } from "@/lib/services/workspaces";

export const POST = handleRoute(routeDeps, { bucket: "workspace_create", body: CreateWorkspaceBody }, ({ userId, body, services }) =>
  createDemoWorkspace(services, userId, { name: body.name }),
);
