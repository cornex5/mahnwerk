import { Suspense } from "react";
import { CaseDetail } from "@/components/CaseDetail";
import { Skeleton } from "@/components/ui";

async function Case({ params }: { params: Promise<{ id: string; caseId: string }> }) {
  const { caseId } = await params;
  return <CaseDetail caseId={caseId} />;
}

export default function CasePage({ params }: { params: Promise<{ id: string; caseId: string }> }) {
  return (
    <Suspense fallback={<Skeleton className="h-72" />}>
      <Case params={params} />
    </Suspense>
  );
}
