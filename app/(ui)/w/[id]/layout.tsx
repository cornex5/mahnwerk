import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { ExampleSummary } from "@/components/ExampleSummary";
import { WorkspaceProvider } from "@/components/WorkspaceProvider";
import { WorkspaceShell } from "@/components/WorkspaceShell";
import { Skeleton } from "@/components/ui";

async function WorkspaceFrame({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  const placeholder = await ExampleSummary({ id });
  return (
    <WorkspaceProvider id={id} placeholder={placeholder ?? undefined}>
      <WorkspaceShell id={id}>{children}</WorkspaceShell>
    </WorkspaceProvider>
  );
}

export default function WorkspaceLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-7xl space-y-4 px-4 py-8 sm:px-6" aria-busy="true">
          <Skeleton className="h-10 w-1/3" />
          <Skeleton className="h-72" />
        </div>
      }
    >
      <WorkspaceFrame params={params}>{children}</WorkspaceFrame>
    </Suspense>
  );
}
